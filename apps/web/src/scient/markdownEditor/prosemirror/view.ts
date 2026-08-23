import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import type { Transaction } from "prosemirror-state";
import { EditorView, type DirectEditorProps } from "prosemirror-view";

import {
  ScientProseMirrorSession,
  scientMarkdownTransactionOriginKey,
  type ScientExternalSourceResult,
  type ScientMarkdownTransactionOrigin,
} from "./session";

export interface ScientMarkdownEditorViewOptions {
  readonly source: string;
  readonly revision: string;
  readonly mode?: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent) => void;
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

  constructor(private readonly options: ScientMarkdownEditorViewOptions) {
    this.mode = options.mode ?? "read";
    this.session = new ScientProseMirrorSession(options);
  }

  get view(): EditorView | null {
    return this.editorView;
  }

  mount(element: HTMLElement): EditorView {
    if (this.editorView !== null) return this.editorView;
    this.editorView = new EditorView(element, this.directProps());
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
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): void {
    if (this.editorView === null) throw new Error("Scient Markdown EditorView is not mounted.");
    const state = this.session.applyTransaction(transaction, origin);
    this.editorView.updateState(state);
  }

  replaceUserSource(source: string): void {
    const state = this.session.replaceUserSource(source);
    this.editorView?.updateState(state);
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    this.session.confirmSave(intent, revision);
  }

  receiveExternalSource(input: {
    readonly source: string;
    readonly revision: string;
  }): ScientExternalSourceResult {
    const result = this.session.receiveExternalSource(input);
    if (result === "adopted") this.editorView?.updateState(this.session.state);
    return result;
  }

  destroy(): void {
    this.editorView?.destroy();
    this.editorView = null;
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
    };
  }
}
