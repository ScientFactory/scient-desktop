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
  serializeScientMarkdownProjection,
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

/**
 * Framework-neutral ProseMirror session. A later React adapter owns one
 * persistent EditorView and delegates every transaction here.
 */
export class ScientProseMirrorSession {
  private projection: ScientMarkdownProjection;
  private documentSession: MarkdownDocumentSession;
  private editorState: EditorState;

  constructor(private readonly options: ScientProseMirrorSessionOptions) {
    this.projection = createScientMarkdownProjection(options.source);
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

  setMode(mode: MarkdownDocumentMode): void {
    this.documentSession = setMarkdownDocumentMode(this.documentSession, mode);
  }

  replaceUserSource(source: string): EditorState {
    const nextSession = applyUserMarkdownSource(this.documentSession, source);
    if (nextSession === this.documentSession) return this.editorState;
    this.documentSession = nextSession;
    this.projection = createScientMarkdownProjection(source);
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
    const nextSession = receiveExternalMarkdownSource(this.documentSession, input);
    this.documentSession = nextSession;
    if (nextSession.conflict !== null) return "conflict";
    if (nextSession.draftSource === this.projection.ledger.source) return "unchanged";

    this.projection = createScientMarkdownProjection(nextSession.draftSource);
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
    const source = serializeScientMarkdownProjection(this.projection, nextState.doc);
    const nextSession = applyUserMarkdownSource(this.documentSession, source);
    if (nextSession === this.documentSession) return nextState;
    this.documentSession = nextSession;
    const intent = beginMarkdownSave(nextSession);
    if (intent !== null) this.options.onUserSourceChange?.(source, intent);
    return nextState;
  }
}
