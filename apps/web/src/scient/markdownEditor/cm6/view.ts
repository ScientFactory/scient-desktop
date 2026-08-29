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

import type { ScientFindBarState } from "../ui/ScientFindBar";

import {
  clearCm6Find,
  configureCm6Find,
  navigateCm6Find,
  scientCm6FindField,
  scientCm6FindState,
  type ScientCm6FindConfig,
} from "./find";
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
  private findOpen = false;
  private findFocusRequest = 0;
  private readonly findListeners = new Set<() => void>();
  private findSnapshotCache: ScientFindBarState | null = null;

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

  subscribeFind = (listener: () => void): (() => void) => {
    this.findListeners.add(listener);
    return () => this.findListeners.delete(listener);
  };

  getFindSnapshot = (): ScientFindBarState => {
    if (this.findSnapshotCache === null) {
      const find = this.cmView ? scientCm6FindState(this.cmView.state) : null;
      this.findSnapshotCache = {
        editable: true,
        findActiveIndex: find?.activeIndex ?? 0,
        findCaseSensitive: find?.caseSensitive ?? false,
        findFocusRequest: this.findFocusRequest,
        findMatchCount: find?.matches.length ?? 0,
        findOpen: this.findOpen,
        findQuery: find?.query ?? "",
        findWholeWord: find?.wholeWord ?? false,
      };
    }
    return this.findSnapshotCache;
  };

  /** Opens the find bar and focuses its input (Mod-f). */
  requestFind(): void {
    this.findOpen = true;
    this.findFocusRequest += 1;
    this.notifyFind();
  }

  setFindOpen(open: boolean): void {
    if (this.findOpen === open) return;
    this.findOpen = open;
    if (!open) this.cmView?.dispatch({ effects: clearCm6Find.of(null) });
    this.notifyFind();
  }

  configureFind(input: ScientCm6FindConfig): void {
    this.cmView?.dispatch({ effects: configureCm6Find.of(input) });
  }

  navigateFind(direction: -1 | 1): void {
    const view = this.cmView;
    if (!view) return;
    view.dispatch({ effects: navigateCm6Find.of(direction) });
    const match = scientCm6FindState(view.state).matches[
      scientCm6FindState(view.state).activeIndex
    ];
    if (!match) return;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true,
    });
  }

  replaceFind(replacement: string, all: boolean): boolean {
    const view = this.cmView;
    if (!view) return false;
    const find = scientCm6FindState(view.state);
    if (find.matches.length === 0) return false;
    if (all) {
      view.dispatch({
        changes: find.matches.map((match) => ({
          from: match.from,
          to: match.to,
          insert: replacement,
        })),
      });
      return true;
    }
    const match = find.matches[find.activeIndex];
    if (!match) return false;
    view.dispatch({ changes: { from: match.from, to: match.to, insert: replacement } });
    return true;
  }

  private notifyFind(): void {
    this.findSnapshotCache = null;
    this.findListeners.forEach((listener) => listener());
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
        markdownEditingKeymap({ onFind: () => this.requestFind() }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        EditorView.lineWrapping,
        livePreviewTheme,
        revealFreezeExtension,
        scientCm6FindField,
        livePreview({
          placeholder: this.options.placeholder,
          ...(this.options.resolveImageSource
            ? { resolveImageSource: this.options.resolveImageSource }
            : {}),
        }),
        EditorView.updateListener.of((update) => {
          if (
            update.transactions.some(
              (transaction) => transaction.docChanged || transaction.effects.length > 0,
            )
          ) {
            this.notifyFind();
          }
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
