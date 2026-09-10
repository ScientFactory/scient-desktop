import {
  applyUserMarkdownSource,
  beginMarkdownSave,
  confirmMarkdownSave,
  createMarkdownDocumentSession,
  receiveExternalMarkdownSource,
  rebaseLocalMarkdownDraft,
  resolveMarkdownConflictWithDisk,
  resolveMarkdownConflictWithLocal,
  setMarkdownDocumentMode,
  type MarkdownDocumentMode,
  type MarkdownDocumentSession,
  type MarkdownSaveIntent,
  type MarkdownExternalUpdate,
} from "@scientfactory/scient-markdown";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { EditorState, NodeSelection, PluginKey, Selection, TextSelection } from "prosemirror-state";

import {
  createScientMarkdownProjection,
  projectScientMarkdownSource,
  refreshScientMarkdownReferences,
  withProjectedDocument,
  type ScientMarkdownProjection,
} from "./projection";
import { selectionOutsideNode } from "./safeSelection";
import { buildScientMarkdownPlugins } from "./plugins";
import { findScientMarkdownReferenceDefinition } from "./referenceLinks";
import { scientMarkdownParser } from "./schema";
import { prepareScientExternalProjection } from "./externalProjection";

export type ScientMarkdownTransactionOrigin = "user" | "external" | "system";

export const scientMarkdownTransactionOriginKey = new PluginKey<ScientMarkdownTransactionOrigin>(
  "scientMarkdownTransactionOrigin",
);

export interface ScientProseMirrorSessionOptions {
  /** Current local document bytes, including a restored optimistic draft. */
  readonly source: string;
  /** Disk revision paired with `authoritativeSource` (or `source` by default). */
  readonly revision: string;
  readonly authoritativeSource?: string;
  readonly mode?: MarkdownDocumentMode;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent | null) => void;
}

export type ScientExternalSourceResult = "adopted" | "conflict" | "unchanged";
export type ScientExternalConflictResolution = "disk" | "local";

function blockRanges(projection: ScientMarkdownProjection) {
  return projection.ledger.blocks.map((block) => ({
    from: block.start,
    to: block.end,
  }));
}

/**
 * ProseMirror selects a leading atom by default. In write mode, the first
 * printable key would then replace YAML/front matter, display math, or another
 * source island. Prefer the first ordinary text block while leaving documents
 * with no writable text block untouched.
 */
function safeInitialSelection(document: ProseMirrorNode): Selection {
  const selection = Selection.atStart(document);
  if (!(selection instanceof NodeSelection)) return selection;

  let textPosition: number | null = null;
  document.descendants((node, position) => {
    if (textPosition !== null) return false;
    if (node.isTextblock && node.type.name !== "code_block") {
      textPosition = position + 1;
      return false;
    }
    return true;
  });
  if (textPosition !== null) return TextSelection.create(document, textPosition);
  return selectionOutsideNode(document, selection.from, selection.node.nodeSize) ?? selection;
}

function createEditorState(
  document: ProseMirrorNode,
  plugins: EditorState["plugins"],
): EditorState {
  return EditorState.create({
    doc: document,
    plugins,
    selection: safeInitialSelection(document),
  });
}

function footnoteDefinitionLabels(document: ProseMirrorNode): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  document.forEach((node) => {
    const sourceId = node.attrs.sourceId;
    if (
      node.type.name === "footnote_definition" &&
      typeof sourceId === "string" &&
      sourceId.length > 0
    ) {
      labels.set(sourceId, String(node.attrs.label));
    }
  });
  return labels;
}

/** Keep references and their definition rename in the same undoable transaction. */
function rebindRenamedFootnotes(
  transaction: Transaction,
  previousDocument: ProseMirrorNode,
): Transaction {
  if (!transaction.docChanged) return transaction;
  const previousLabels = footnoteDefinitionLabels(previousDocument);
  if (previousLabels.size === 0) return transaction;
  const renamedLabels = new Map<string, string>();
  transaction.doc.forEach((node) => {
    const sourceId = node.attrs.sourceId;
    if (
      node.type.name !== "footnote_definition" ||
      typeof sourceId !== "string" ||
      sourceId.length === 0
    ) {
      return;
    }
    const previous = previousLabels.get(sourceId);
    const next = String(node.attrs.label);
    if (previous !== undefined && previous !== next && next.length > 0) {
      renamedLabels.set(previous, next);
    }
  });
  if (renamedLabels.size === 0) return transaction;

  const references: Array<{ readonly position: number; readonly label: string }> = [];
  transaction.doc.descendants((node, position) => {
    if (node.type.name !== "footnote_reference") return true;
    const label = renamedLabels.get(String(node.attrs.label));
    if (label !== undefined) references.push({ position, label });
    return false;
  });
  for (const reference of references) {
    const node = transaction.doc.nodeAt(reference.position);
    if (!node) continue;
    transaction.setNodeMarkup(reference.position, undefined, {
      ...node.attrs,
      label: reference.label,
    });
  }
  return transaction;
}

function sameTextTree(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  if (
    before.type !== after.type ||
    before.text !== after.text ||
    before.childCount !== after.childCount
  )
    return false;
  for (let i = 0; i < before.childCount; i += 1) {
    if (!sameTextTree(before.child(i), after.child(i))) return false;
  }
  return true;
}

/** Attribute/mark rebinding must not delete text, its selection, or its undo mappings. */
function rebindNodeMarkup(
  transaction: Transaction,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  position: number,
): void {
  if (!before.sameMarkup(after)) {
    if (before.isText) {
      transaction.removeMark(position, position + before.nodeSize);
      for (const mark of after.marks)
        transaction.addMark(position, position + before.nodeSize, mark);
    } else {
      for (const [name, value] of Object.entries(after.attrs)) {
        if (before.attrs[name] !== value) transaction.setNodeAttribute(position, name, value);
      }
      for (const mark of before.marks) {
        if (!mark.isInSet(after.marks)) transaction.removeNodeMark(position, mark);
      }
      for (const mark of after.marks) {
        if (!mark.isInSet(before.marks)) transaction.addNodeMark(position, mark);
      }
    }
  }
  before.forEach((child, offset, index) =>
    rebindNodeMarkup(transaction, child, after.child(index), position + 1 + offset),
  );
}

/**
 * Framework-neutral ProseMirror session. A later React adapter owns one
 * persistent EditorView and delegates every transaction here.
 */
export class ScientProseMirrorSession {
  private projection: ScientMarkdownProjection;
  private documentSession: MarkdownDocumentSession;
  private editorState: EditorState;
  private projectedBlockRanges: ReadonlyArray<{ readonly from: number; readonly to: number }>;

  constructor(private readonly options: ScientProseMirrorSessionOptions) {
    this.projection = createScientMarkdownProjection(options.source);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.documentSession = createMarkdownDocumentSession({
      source: options.authoritativeSource ?? options.source,
      revision: options.revision,
      draftSource: options.source,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    this.editorState = createEditorState(this.projection.document, [
      ...buildScientMarkdownPlugins(),
    ]);
  }

  get state(): EditorState {
    return this.editorState;
  }

  get session(): MarkdownDocumentSession {
    return this.documentSession;
  }

  referenceDefinitionForLabel(label: string) {
    return findScientMarkdownReferenceDefinition(
      scientMarkdownParser.tokenizer,
      this.documentSession.draftSource,
      label,
    );
  }

  sourceOffsetForDocumentPosition(position: number): number | null {
    let matchedIndex = -1;
    this.editorState.doc.forEach((node, offset, index) => {
      if (matchedIndex < 0 && position >= offset && position <= offset + node.nodeSize) {
        matchedIndex = index;
      }
    });
    return matchedIndex < 0 ? null : (this.projectedBlockRanges[matchedIndex]?.from ?? null);
  }

  documentPositionForSourceOffset(sourceOffset: number): number | null {
    if (this.projectedBlockRanges.length === 0) return null;
    const clamped = Math.min(Math.max(0, sourceOffset), this.documentSession.draftSource.length);
    let matchedIndex = this.projectedBlockRanges.findIndex(
      // Ledger ranges include trailing trivia up to the next block's start.
      // That shared boundary belongs to the next block; EOF falls back below.
      (range) => clamped >= range.from && clamped < range.to,
    );
    if (matchedIndex < 0) {
      matchedIndex = this.projectedBlockRanges.findIndex((range) => clamped < range.from);
      if (matchedIndex < 0) matchedIndex = this.projectedBlockRanges.length - 1;
    }
    let documentPosition = 0;
    for (let index = 0; index < matchedIndex; index += 1) {
      const child = this.editorState.doc.child(index);
      documentPosition += child.nodeSize;
    }
    return documentPosition;
  }

  setMode(mode: MarkdownDocumentMode): void {
    this.documentSession = setMarkdownDocumentMode(this.documentSession, mode);
  }

  replaceUserSource(source: string): EditorState {
    const nextSession = applyUserMarkdownSource(this.documentSession, source);
    if (nextSession === this.documentSession) return this.editorState;
    this.documentSession = nextSession;
    this.projection = createScientMarkdownProjection(source);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = createEditorState(this.projection.document, this.editorState.plugins);
    const intent = beginMarkdownSave(nextSession);
    this.options.onUserSourceChange?.(source, intent);
    return this.editorState;
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    const nextSession = confirmMarkdownSave(this.documentSession, intent, revision);
    if (nextSession === this.documentSession) return;
    this.documentSession = nextSession;
    // Persistence changes the CAS baseline, not the projection's source
    // identities. Keep the ledger paired with the document it actually parsed;
    // this also preserves undo history and newer in-flight edits.
  }

  /** Persistence owns document truth; metadata-only acknowledgements preserve the editor state. */
  prepareExternalUpdate(update: MarkdownExternalUpdate): (() => void) | null {
    if (this.documentSession.draftSource !== update.previousSource) return null;
    const before = this.editorState;
    const prepared = prepareScientExternalProjection(before, this.projectedBlockRanges, update);
    if (!prepared) return null;
    return () => {
      if (this.editorState !== before) throw new Error("External rich update became stale");
      this.editorState = prepared.state;
      this.projection = prepared.projection;
      this.projectedBlockRanges = blockRanges(prepared.projection);
      this.documentSession = {
        ...this.documentSession,
        draftSource: update.source,
        editVersion: update.editVersion,
      };
    };
  }

  synchronizePersistence(snapshot: MarkdownDocumentSession): boolean {
    const sourceChanged = snapshot.draftSource !== this.documentSession.draftSource;
    this.documentSession = { ...snapshot, mode: this.documentSession.mode };
    if (!sourceChanged) return false;
    this.projection = createScientMarkdownProjection(snapshot.draftSource);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = createEditorState(this.projection.document, this.editorState.plugins);
    return true;
  }

  /** A save intent for the current draft against the current baseline revision. */
  createSaveIntent(): MarkdownSaveIntent | null {
    return beginMarkdownSave(this.documentSession);
  }

  receiveExternalSource(input: {
    readonly source: string;
    readonly revision: string;
  }): ScientExternalSourceResult {
    if (
      input.source === this.documentSession.baselineSource &&
      input.revision === this.documentSession.baselineRevision
    ) {
      return "unchanged";
    }
    const previousDraft = this.documentSession.draftSource;
    const nextSession = receiveExternalMarkdownSource(this.documentSession, input);
    this.documentSession = nextSession;
    if (nextSession.conflict !== null) return "conflict";
    if (nextSession.draftSource === previousDraft) return "unchanged";

    this.projection = createScientMarkdownProjection(nextSession.draftSource);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = createEditorState(this.projection.document, this.editorState.plugins);
    return "adopted";
  }

  resolveExternalConflict(resolution: ScientExternalConflictResolution): EditorState {
    if (this.documentSession.conflict === null) return this.editorState;
    this.documentSession =
      resolution === "disk"
        ? resolveMarkdownConflictWithDisk(this.documentSession)
        : resolveMarkdownConflictWithLocal(this.documentSession);
    if (resolution === "local") return this.editorState;
    this.projection = createScientMarkdownProjection(this.documentSession.draftSource);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = createEditorState(this.projection.document, this.editorState.plugins);
    return this.editorState;
  }

  /** Keep the current document while adopting a host-provided disk snapshot as its CAS baseline. */
  rebaseLocalChanges(input: { readonly source: string; readonly revision: string }): EditorState {
    this.documentSession = rebaseLocalMarkdownDraft(this.documentSession, input);
    return this.editorState;
  }

  /** Discard is valid even when disk has not changed and no conflict object exists. */
  discardLocalChanges(input: { readonly source: string; readonly revision: string }): EditorState {
    this.documentSession = {
      ...this.documentSession,
      baselineSource: input.source,
      baselineRevision: input.revision,
      draftSource: input.source,
      editVersion: this.documentSession.editVersion + 1,
      conflict: null,
    };
    this.projection = createScientMarkdownProjection(input.source);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = createEditorState(this.projection.document, this.editorState.plugins);
    return this.editorState;
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): EditorState {
    if (origin === "user") transaction = rebindRenamedFootnotes(transaction, this.editorState.doc);
    transaction.setMeta(scientMarkdownTransactionOriginKey, origin);
    const applied = this.editorState.applyTransaction(transaction);
    let nextState = applied.state;
    this.editorState = nextState;
    this.projection = withProjectedDocument(this.projection, nextState.doc);

    if (
      origin !== "user" ||
      !applied.transactions.some((appliedTransaction) => appliedTransaction.docChanged)
    ) {
      return nextState;
    }
    const projected = projectScientMarkdownSource(this.projection, nextState.doc);
    const references = refreshScientMarkdownReferences(this.projection, projected);
    if (references) {
      const refresh = nextState.tr.setMeta("addToHistory", false);
      for (const replacement of references.replacements) {
        const from = refresh.mapping.map(replacement.from);
        const before = refresh.doc.nodeAt(from)!;
        const after = replacement.node;
        if (sameTextTree(before, after)) rebindNodeMarkup(refresh, before, after, from);
        else if (before.sameMarkup(after)) {
          // Removing/adding a definition can reveal/hide reference delimiters.
          // Replace only the changed inline range, not the containing block.
          const start = before.content.findDiffStart(after.content);
          const end = before.content.findDiffEnd(after.content);
          if (start !== null && end) {
            const overlap = Math.max(0, start - Math.min(end.a, end.b));
            refresh.replaceWith(
              from + 1 + start,
              from + 1 + end.a + overlap,
              after.content.cut(start, end.b + overlap),
            );
          }
        } else refresh.replaceWith(from, refresh.mapping.map(replacement.to), after);
      }
      if (refresh.docChanged) nextState = nextState.applyTransaction(refresh).state;
      this.editorState = nextState;
      this.projection = withProjectedDocument(references.projection, nextState.doc);
    }
    const source = projected.source;
    this.projectedBlockRanges = projected.blockRanges;
    const nextSession = applyUserMarkdownSource(this.documentSession, source);
    if (nextSession === this.documentSession) return nextState;
    this.documentSession = nextSession;
    const intent = beginMarkdownSave(nextSession);
    try {
      this.options.onUserSourceChange?.(source, intent);
    } catch (error) {
      console.error("Scient Markdown onUserSourceChange error:", error);
    }
    return nextState;
  }
}
