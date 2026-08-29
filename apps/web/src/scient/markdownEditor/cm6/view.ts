import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
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
  setMarkdownDocumentMode,
  type MarkdownDocumentMode,
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
  readonly mode: MarkdownDocumentMode;
  readonly placeholder: string;
  readonly onUserSourceChange: (source: string, intent: MarkdownSaveIntent) => void;
  readonly resolveImageSource?: (authoredSource: string) => Promise<string | null>;
  readonly onOpenLink?: (target: string) => void;
}

export type ScientCm6ExternalResult = "adopted" | "same" | "conflict";
export type ScientCm6ConflictResolution = "disk" | "local";

/**
 * One CM6-backed Markdown document controller. The editor buffer is the file's
 * bytes; Read/Write/Source are the same buffer with the live-preview
 * projection and editability reconfigured, never a different document.
 */
export class ScientCm6EditorView {
  private readonly options: ScientCm6EditorViewOptions;
  private readonly previewCompartment = new Compartment();
  private readonly editableCompartment = new Compartment();
  private session: MarkdownDocumentSession;
  private cmView: EditorView | null = null;

  constructor(options: ScientCm6EditorViewOptions) {
    this.options = options;
    this.session = createMarkdownDocumentSession({
      source: options.source,
      revision: options.revision,
      mode: options.mode,
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

  setMode(mode: MarkdownDocumentMode): void {
    if (this.session.mode === mode) return;
    this.session = setMarkdownDocumentMode(this.session, mode);
    this.applyMode();
    if (mode !== "read") this.focus();
  }

  focus(): void {
    this.cmView?.focus();
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    this.session = confirmMarkdownSave(this.session, intent, revision);
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
        this.previewCompartment.of(this.previewExtensions()),
        this.editableCompartment.of(this.editableExtensions()),
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

  private previewExtensions(): ExtensionList {
    if (this.session.mode === "source") return [];
    return [
      livePreview({
        placeholder: this.options.placeholder,
        ...(this.options.resolveImageSource
          ? { resolveImageSource: this.options.resolveImageSource }
          : {}),
      }),
    ];
  }

  private editableExtensions(): ExtensionList {
    return [
      EditorState.readOnly.of(this.session.mode === "read"),
      EditorView.editable.of(this.session.mode !== "read"),
    ];
  }

  private applyMode(): void {
    const view = this.cmView;
    if (!view) return;
    view.dispatch({
      effects: [
        this.previewCompartment.reconfigure(this.previewExtensions()),
        this.editableCompartment.reconfigure(this.editableExtensions()),
      ],
      annotations: ExternalSync.of(true),
    });
  }

  private handleUserDocChange(): void {
    const view = this.cmView;
    if (!view) return;
    this.session = applyUserMarkdownSource(this.session, view.state.doc.toString());
    if (this.session.mode === "read") return;
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

type ExtensionList = Parameters<Compartment["reconfigure"]>[0];
