import {
  applyUserMarkdownSource,
  beginMarkdownSave,
  confirmMarkdownSave,
  createMarkdownDocumentSession,
  receiveExternalMarkdownSource,
  resolveMarkdownConflictWithDisk,
  resolveMarkdownConflictWithLocal,
  setMarkdownDocumentMode,
  type MarkdownDocumentMode,
  type MarkdownDocumentSession,
  type MarkdownSaveIntent,
} from "@scientfactory/scient-markdown";
import type { Transaction } from "prosemirror-state";
import { EditorState, PluginKey } from "prosemirror-state";

import {
  createScientMarkdownProjection,
  projectScientMarkdownSource,
  withProjectedDocument,
  type ScientMarkdownProjection,
} from "./projection";
import { buildScientMarkdownPlugins } from "./plugins";

export type ScientMarkdownTransactionOrigin = "user" | "external" | "system";

export const scientMarkdownTransactionOriginKey = new PluginKey<ScientMarkdownTransactionOrigin>(
  "scientMarkdownTransactionOrigin",
);

export interface ScientProseMirrorSessionOptions {
  readonly source: string;
  readonly revision: string;
  readonly mode?: MarkdownDocumentMode;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent) => void;
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
      source: options.source,
      revision: options.revision,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    this.editorState = EditorState.create({
      doc: this.projection.document,
      plugins: [...buildScientMarkdownPlugins()],
    });
  }

  get state(): EditorState {
    return this.editorState;
  }

  get session(): MarkdownDocumentSession {
    return this.documentSession;
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
      (range) => clamped >= range.from && clamped <= range.to,
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
    this.editorState = EditorState.create({
      doc: this.projection.document,
      plugins: this.editorState.plugins,
    });
    const intent = beginMarkdownSave(nextSession);
    if (intent !== null) this.options.onUserSourceChange?.(source, intent);
    return this.editorState;
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    const nextSession = confirmMarkdownSave(this.documentSession, intent, revision);
    if (nextSession === this.documentSession) return;
    this.documentSession = nextSession;
    const confirmedProjection = createScientMarkdownProjection(intent.source);
    this.projection = {
      ...confirmedProjection,
      document: this.editorState.doc,
    };
    if (intent.source === nextSession.draftSource) {
      this.projectedBlockRanges = blockRanges(confirmedProjection);
    }
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
    if (input.source === previousDraft) return "unchanged";

    this.projection = createScientMarkdownProjection(nextSession.draftSource);
    this.projectedBlockRanges = blockRanges(this.projection);
    this.editorState = EditorState.create({
      doc: this.projection.document,
      plugins: this.editorState.plugins,
    });
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
    this.editorState = EditorState.create({
      doc: this.projection.document,
      plugins: this.editorState.plugins,
    });
    return this.editorState;
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): EditorState {
    transaction.setMeta(scientMarkdownTransactionOriginKey, origin);
    const applied = this.editorState.applyTransaction(transaction);
    const nextState = applied.state;
    this.editorState = nextState;
    this.projection = withProjectedDocument(this.projection, nextState.doc);

    if (
      origin !== "user" ||
      !applied.transactions.some((appliedTransaction) => appliedTransaction.docChanged)
    ) {
      return nextState;
    }
    const projected = projectScientMarkdownSource(this.projection, nextState.doc);
    const source = projected.source;
    this.projectedBlockRanges = projected.blockRanges;
    const nextSession = applyUserMarkdownSource(this.documentSession, source);
    if (nextSession === this.documentSession) return nextState;
    this.documentSession = nextSession;
    const intent = beginMarkdownSave(nextSession);
    if (intent !== null) {
      try {
        this.options.onUserSourceChange?.(source, intent);
      } catch (error) {
        console.error("Scient Markdown onUserSourceChange error:", error);
      }
    }
    return nextState;
  }
}
