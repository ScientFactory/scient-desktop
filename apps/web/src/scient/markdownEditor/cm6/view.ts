import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  applyUserMarkdownSource,
  beginMarkdownSave,
  confirmMarkdownSave,
  createMarkdownDocumentSession,
  receiveExternalMarkdownSource,
  resolveMarkdownConflictWithDisk,
  resolveMarkdownConflictWithLocal,
  type MarkdownDocumentSession,
  type MarkdownSaveIntent,
} from "@scientfactory/scient-markdown";

import { markdownEditingKeymap } from "./keymap";
import { livePreview } from "./livePreview";
import { revealFreezeExtension } from "./reveal";
import { livePreviewTheme } from "./theme";

const ExternalSync = Annotation.define<boolean>();

export interface ScientCm6EditorViewOptions {
  readonly source: string;
  readonly revision: string;
  readonly placeholder: string;
  readonly onUserSourceChange: (source: string, intent: MarkdownSaveIntent) => void;
  readonly resolveImageSource?: (authoredSource: string) => Promise<string | null>;
  readonly onOpenLink?: (target: string) => void;
}

export type ScientCm6ExternalResult = "adopted" | "same" | "conflict";
export type ScientCm6ConflictResolution = "disk" | "local";

/**
 * One CM6-backed Markdown document controller. The editor buffer is the
 * file's bytes and is always editable; the live preview is a decoration
 * projection over it. The document is the same across render states.
 */
export class ScientCm6EditorView {
  private readonly options: ScientCm6EditorViewOptions;
  private session: MarkdownDocumentSession;
  private cmView: EditorView | null = null;

  constructor(options: ScientCm6EditorViewOptions) {
    this.options = options;
    this.session = createMarkdownDocumentSession({
      source: options.source,
      revision: options.revision,
    });
  }

  mount(element: HTMLElement): EditorView {
    if (this.cmView !== null) return this.cmView;
    this.cmView = new EditorView({ state: this.createState(), parent: element });
    return this.cmView;
  }

  get view(): EditorView | null {
    return this.cmView;
  }

  get sessionState(): MarkdownDocumentSession {
    return this.session;
  }

  focus(): void {
    this.cmView?.focus();
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    this.session = confirmMarkdownSave(this.session, intent, revision);
  }

  /** A save intent for the current draft against the current baseline revision. */
  createSaveIntent(): MarkdownSaveIntent | null {
    return beginMarkdownSave(this.session);
  }

  receiveExternalSource(input: {
    readonly source: string;
    readonly revision: string;
  }): ScientCm6ExternalResult {
    const next = receiveExternalMarkdownSource(this.session, input);
    if (next.conflict !== null) {
      this.session = next;
      return "conflict";
    }
    const adopted = next.draftSource !== this.session.draftSource;
    this.session = next;
    if (adopted) {
      this.setBuffer(next.draftSource);
      return "adopted";
    }
    return "same";
  }

  resolveExternalConflict(resolution: ScientCm6ConflictResolution): void {
    this.session =
      resolution === "disk"
        ? resolveMarkdownConflictWithDisk(this.session)
        : resolveMarkdownConflictWithLocal(this.session);
    if (resolution === "disk") this.setBuffer(this.session.draftSource);
  }

  private createState(): EditorState {
    return EditorState.create({
      doc: this.session.draftSource,
      extensions: [
        history(),
        markdownEditingKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        EditorView.lineWrapping,
        livePreviewTheme,
        revealFreezeExtension,
        livePreview({
          placeholder: this.options.placeholder,
          ...(this.options.resolveImageSource
            ? { resolveImageSource: this.options.resolveImageSource }
            : {}),
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((transaction) => transaction.annotation(ExternalSync))) {
            return;
          }
          this.handleUserDocChange();
        }),
        EditorView.domEventHandlers({
          click: (event, view) => this.handleLinkClick(event, view),
        }),
      ],
    });
  }

  private handleUserDocChange(): void {
    const view = this.cmView;
    if (!view) return;
    this.session = applyUserMarkdownSource(this.session, view.state.doc.toString());
    const intent = beginMarkdownSave(this.session);
    if (intent) this.options.onUserSourceChange(intent.source, intent);
  }

  private setBuffer(source: string): void {
    const view = this.cmView;
    if (!view) return;
    if (view.state.doc.toString() === source) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
      annotations: ExternalSync.of(true),
    });
  }

  private handleLinkClick(event: MouseEvent, view: EditorView): boolean {
    if (!(event.metaKey || event.ctrlKey) || !this.options.onOpenLink) return false;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return false;
    const { state } = view;
    let target: string | null = null;
    syntaxTree(state).iterate({
      from: Math.max(0, position - 2),
      to: Math.min(state.doc.length, position + 2),
      enter: (node) => {
        if (node.name !== "Link" || target !== null) return;
        const linkText = state.sliceDoc(node.from, node.to);
        const match = /\]\([^)\s]+\)$/u.exec(linkText);
        if (match) {
          target = match[0].slice(3, -1);
        }
      },
    });
    if (target === null) return false;
    this.options.onOpenLink(target);
    return true;
  }
}
