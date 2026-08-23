import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { toggleMark } from "prosemirror-commands";
import type { Transaction } from "prosemirror-state";
import { EditorView, type DirectEditorProps } from "prosemirror-view";

import {
  ScientProseMirrorSession,
  scientMarkdownTransactionOriginKey,
  type ScientExternalSourceResult,
  type ScientExternalConflictResolution,
  type ScientMarkdownTransactionOrigin,
} from "./session";
import { buildScientMarkdownNodeViews, type ScientMarkdownImageSourceResolver } from "../nodes";
import {
  filterScientMarkdownSlashCommands,
  runScientMarkdownCommand,
  setSelectedTaskState,
  type ScientMarkdownCommand,
} from "./commands";
import { scientMarkdownSchema } from "./schema";

export interface ScientMarkdownEditorViewOptions {
  readonly source: string;
  readonly revision: string;
  readonly mode?: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent) => void;
  readonly onOpenWikiLink?: (target: string) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
}

export interface ScientMarkdownEditorSnapshot {
  readonly activeMarks: ReadonlyArray<string>;
  readonly blockType: string;
  readonly editable: boolean;
  readonly headingLevel: number | null;
  readonly inTable: boolean;
  readonly selectionEmpty: boolean;
  readonly slashActiveIndex: number;
  readonly slashQuery: string | null;
  readonly version: number;
}

function modeIsEditable(mode: MarkdownDocumentMode): boolean {
  return mode === "write" || mode === "split";
}

function accessibilityAttributes(
  mode: MarkdownDocumentMode,
  ariaLabel: string,
): Readonly<Record<string, string>> {
  const editable = modeIsEditable(mode);
  const common = {
    "aria-label": ariaLabel,
    class: `scient-markdown-document is-${mode}`,
    dir: "auto",
  };
  return editable
    ? { ...common, "aria-multiline": "true", role: "textbox" }
    : { ...common, role: "document" };
}

/**
 * Owns exactly one EditorView for a mounted document. Mode transitions update
 * view props in place and never recreate, parse, or transact the document.
 */
export class ScientMarkdownEditorView {
  readonly session: ScientProseMirrorSession;
  private editorView: EditorView | null = null;
  private mode: MarkdownDocumentMode;
  private readonly listeners = new Set<() => void>();
  private slashActiveIndex = 0;
  private snapshotVersion = 0;
  private snapshot: ScientMarkdownEditorSnapshot;

  constructor(private readonly options: ScientMarkdownEditorViewOptions) {
    this.mode = options.mode ?? "read";
    this.session = new ScientProseMirrorSession(options);
    this.snapshot = this.createSnapshot();
  }

  get view(): EditorView | null {
    return this.editorView;
  }

  getSnapshot = (): ScientMarkdownEditorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(element: HTMLElement): EditorView {
    if (this.editorView !== null) return this.editorView;
    this.editorView = new EditorView(element, this.directProps());
    this.syncNodeViewEditability();
    this.publishSnapshot();
    return this.editorView;
  }

  setMode(mode: MarkdownDocumentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.session.setMode(mode);
    this.editorView?.setProps({
      attributes: accessibilityAttributes(mode, this.options.ariaLabel),
      editable: () => modeIsEditable(mode),
    });
    this.syncNodeViewEditability();
    this.publishSnapshot();
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): void {
    if (this.editorView === null) throw new Error("Scient Markdown EditorView is not mounted.");
    const state = this.session.applyTransaction(transaction, origin);
    this.editorView.updateState(state);
    this.slashActiveIndex = 0;
    this.publishSnapshot();
  }

  replaceUserSource(source: string): void {
    const state = this.session.replaceUserSource(source);
    this.editorView?.updateState(state);
    this.slashActiveIndex = 0;
    this.publishSnapshot();
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    this.session.confirmSave(intent, revision);
  }

  receiveExternalSource(input: {
    readonly source: string;
    readonly revision: string;
  }): ScientExternalSourceResult {
    const result = this.session.receiveExternalSource(input);
    if (result === "adopted") {
      this.editorView?.updateState(this.session.state);
      this.slashActiveIndex = 0;
      this.publishSnapshot();
    }
    return result;
  }

  resolveExternalConflict(resolution: ScientExternalConflictResolution): void {
    const state = this.session.resolveExternalConflict(resolution);
    this.editorView?.updateState(state);
    this.publishSnapshot();
  }

  execute(command: ScientMarkdownCommand): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    if (command === "task-list") {
      if (!setSelectedTaskState(view.state, view.dispatch, false)) {
        if (!runScientMarkdownCommand(command, view.state, view.dispatch)) return false;
        setSelectedTaskState(view.state, view.dispatch, false);
      }
      view.focus();
      return true;
    }
    const handled = runScientMarkdownCommand(command, view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  setLink(href: string, title: string | null = null): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode) || href.trim().length === 0) return false;
    const handled = toggleMark(link, { href: href.trim(), title })(view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  removeLink(): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode)) return false;
    const transaction = view.state.tr.removeMark(
      view.state.selection.from,
      view.state.selection.to,
      link,
    );
    if (!transaction.docChanged) return false;
    view.dispatch(transaction);
    view.focus();
    return true;
  }

  destroy(): void {
    this.editorView?.destroy();
    this.editorView = null;
    this.listeners.clear();
  }

  private directProps(): DirectEditorProps {
    return {
      state: this.session.state,
      attributes: accessibilityAttributes(this.mode, this.options.ariaLabel),
      editable: () => modeIsEditable(this.mode),
      dispatchTransaction: (transaction) => {
        const taggedOrigin: unknown = transaction.getMeta(scientMarkdownTransactionOriginKey);
        const origin =
          taggedOrigin === "external" || taggedOrigin === "system" || taggedOrigin === "user"
            ? taggedOrigin
            : "user";
        this.applyTransaction(transaction, origin);
      },
      nodeViews: buildScientMarkdownNodeViews({
        ...(this.options.onOpenWikiLink ? { onOpenWikiLink: this.options.onOpenWikiLink } : {}),
        ...(this.options.resolveImageSource
          ? { resolveImageSource: this.options.resolveImageSource }
          : {}),
      }),
      handleKeyDown: (_view, event) => this.handleSlashKeyDown(event),
    };
  }

  private syncNodeViewEditability(): void {
    const editable = modeIsEditable(this.mode);
    this.editorView?.dom
      .querySelectorAll<HTMLInputElement>(".scient-markdown-task-checkbox")
      .forEach((checkbox) => {
        checkbox.disabled = !editable;
      });
  }

  private createSnapshot(): ScientMarkdownEditorSnapshot {
    const state = this.editorView?.state ?? this.session.state;
    const { selection } = state;
    const activeMarks = Object.values(scientMarkdownSchema.marks)
      .filter((mark) =>
        selection.empty
          ? (state.storedMarks ?? selection.$from.marks()).some((active) => active.type === mark)
          : state.doc.rangeHasMark(selection.from, selection.to, mark),
      )
      .map((mark) => mark.name);
    let blockType = selection.$from.parent.type.name;
    let headingLevel: number | null =
      blockType === "heading" ? Number(selection.$from.parent.attrs.level) : null;
    let inTable = false;
    for (let depth = selection.$from.depth; depth >= 0; depth -= 1) {
      const node = selection.$from.node(depth);
      if (node.type.name === "table") inTable = true;
      if (blockType === "paragraph" && node.isBlock && node.type.name !== "doc") {
        blockType = node.type.name;
        headingLevel = node.type.name === "heading" ? Number(node.attrs.level) : headingLevel;
      }
    }
    const slashQuery = this.slashQuery();
    const slashItems = slashQuery === null ? [] : filterScientMarkdownSlashCommands(slashQuery);
    return {
      activeMarks,
      blockType,
      editable: modeIsEditable(this.mode),
      headingLevel,
      inTable,
      selectionEmpty: selection.empty,
      slashActiveIndex: Math.min(this.slashActiveIndex, Math.max(0, slashItems.length - 1)),
      slashQuery,
      version: this.snapshotVersion,
    };
  }

  private publishSnapshot(): void {
    this.snapshotVersion += 1;
    this.snapshot = this.createSnapshot();
    this.listeners.forEach((listener) => listener());
  }

  private slashQuery(): string | null {
    const state = this.editorView?.state ?? this.session.state;
    const { selection } = state;
    if (!selection.empty || selection.$from.parent.type.name !== "paragraph") return null;
    const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, "\0", "\0");
    const match = /^\/([^\s/]*)$/u.exec(before);
    return match?.[1] ?? null;
  }

  private handleSlashKeyDown(event: KeyboardEvent): boolean {
    const query = this.slashQuery();
    if (query === null) return false;
    const items = filterScientMarkdownSlashCommands(query);
    if (items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.slashActiveIndex = (this.slashActiveIndex + direction + items.length) % items.length;
      this.publishSnapshot();
      return true;
    }
    if (event.key !== "Enter") return false;
    event.preventDefault();
    const item = items[Math.min(this.slashActiveIndex, items.length - 1)];
    if (!item) return false;
    return this.executeSlashCommand(item.command);
  }

  executeSlashCommand(command: ScientMarkdownCommand): boolean {
    const view = this.editorView;
    const query = this.slashQuery();
    if (!view || query === null || !modeIsEditable(this.mode)) return false;
    const from = view.state.selection.$from.start();
    view.dispatch(view.state.tr.delete(from, view.state.selection.from));
    this.slashActiveIndex = 0;
    return this.execute(command);
  }
}
