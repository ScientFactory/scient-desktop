import { createRoot, type Root } from "react-dom/client";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { closeHistory, undo, redo } from "prosemirror-history";
import { MathInputController } from "~/scient/math/input/controller";
import { MathInputTools } from "~/scient/math/input/MathInputTools";
import { isPlausibleScientSingleDollarTex } from "~/scient/math/scientSingleDollarMath";
import { matchesScientMarkdownShortcut } from "../shortcuts";

import {
  getScientKatexRuntimePromise,
  renderCachedScientMath,
  ScientDisplayMath,
  ScientInlineMath,
} from "~/scient/math/ScientMath";

import {
  computedTextDirection,
  handleInlineAtomEditorKeyDown,
  leaveAtomEditor,
} from "../prosemirror/safeSelection";

class ScientMathNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly renderHost: HTMLSpanElement;
  private readonly sourceEditor: HTMLInputElement | HTMLTextAreaElement;
  private readonly retainedNotice: HTMLSpanElement;
  private readonly reactRoot: Root;
  private toolsRoot: Root | null = null;
  private readonly mathInput: MathInputController;
  private readonly toolsHost: HTMLSpanElement;
  private readonly releaseMathInput: () => void;
  private node: ProseMirrorNode;
  private destroyed = false;
  private validationVersion = 0;
  private lastValidTex: string | null = null;
  private renderedTex: string | undefined;
  private validationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    const display = this.isDisplay(node);
    // An authored \\[...\\] pair can be display-styled inside prose. Keep its
    // NodeView DOM inline-valid; only a top-level display_math node owns a div.
    this.dom = document.createElement(node.type.name === "display_math" ? "div" : "span");
    this.dom.className = display
      ? "scient-markdown-math is-display"
      : "scient-markdown-math is-inline";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-math", display ? "display" : "inline");

    this.renderHost = document.createElement("span");
    this.renderHost.className = "scient-markdown-math-render";
    this.renderHost.addEventListener("click", this.handleRenderClick);
    this.dom.append(this.renderHost);
    // Even inline equations may contain a multiline matrix. An <input> would
    // silently remove newlines and diverge from the saved equation.
    this.sourceEditor = document.createElement("textarea");
    this.sourceEditor.className = "scient-markdown-math-source";
    this.sourceEditor.dir = "ltr";
    this.sourceEditor.dataset.scientMarkdownAtomEditor = "true";
    this.sourceEditor.hidden = true;
    if (this.sourceEditor instanceof HTMLTextAreaElement) this.sourceEditor.rows = 1;
    this.sourceEditor.setAttribute(
      "aria-label",
      display ? "Display math source" : "Inline math source",
    );
    this.sourceEditor.addEventListener("input", this.handleInput);
    this.sourceEditor.addEventListener("compositionend", this.handleInput);
    this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.append(this.sourceEditor);
    this.toolsHost = document.createElement("span");
    this.toolsHost.className = "scient-markdown-math-tools-host";
    this.toolsHost.hidden = true;
    this.dom.append(this.toolsHost);
    const controller = new MathInputController({
      read: () => ({
        source: this.sourceEditor.value,
        selection: {
          from: this.sourceEditor.selectionStart ?? 0,
          to: this.sourceEditor.selectionEnd ?? 0,
        },
        format: "tex",
        editable: this.view.editable && !this.sourceEditor.hidden,
      }),
      apply: (expected, edit) => {
        const position = this.getPos();
        const current = position === undefined ? null : this.view.state.doc.nodeAt(position);
        if (
          position === undefined ||
          !this.view.editable ||
          !current ||
          current.type !== this.node.type ||
          String(current.attrs.tex) !== expected.source ||
          this.sourceEditor.value !== expected.source
        )
          return false;
        const next =
          expected.source.slice(0, edit.from) + edit.insert + expected.source.slice(edit.to);
        if (next !== expected.source) this.writeTex(position, next, true);
        this.sourceEditor.value = next;
        this.sourceEditor.setSelectionRange(edit.selection.from, edit.selection.to);
        return true;
      },
      focus: () => this.sourceEditor.focus(),
    });
    this.releaseMathInput = controller.attach(this.sourceEditor);
    this.mathInput = controller;
    this.retainedNotice = document.createElement("span");
    this.retainedNotice.className = "scient-markdown-math-retained";
    this.retainedNotice.textContent = "Preview kept at the last valid equation.";
    this.retainedNotice.setAttribute("role", "status");
    this.retainedNotice.hidden = true;
    this.dom.append(this.retainedNotice);
    this.reactRoot = createRoot(this.renderHost);
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || this.isDisplay(node) !== this.isDisplay(this.node)) {
      return false;
    }
    this.node = node;
    if (this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = String(node.attrs.tex);
    }
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
    if (this.view.editable) this.showSourceEditor();
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
    this.sourceEditor.hidden = true;
    this.toolsHost.hidden = true;
  }

  stopEvent(event: Event): boolean {
    return (
      event.target === this.sourceEditor ||
      (event.target instanceof Node && this.toolsHost.contains(event.target))
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.releaseMathInput();
    this.toolsRoot?.unmount();
    this.destroyed = true;
    this.validationVersion += 1;
    clearTimeout(this.validationTimer);
    this.renderHost.removeEventListener("click", this.handleRenderClick);
    this.sourceEditor.removeEventListener("input", this.handleInput);
    this.sourceEditor.removeEventListener("compositionend", this.handleInput);
    this.sourceEditor.removeEventListener("keydown", this.handleKeyDown);
    this.reactRoot.unmount();
  }

  private readonly handleInput = (event: Event) => {
    if (!this.view.editable) return;
    if (event instanceof InputEvent && event.isComposing) return;
    const position = this.getPos();
    if (position === undefined) return;
    const currentNode = this.view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode.type !== this.node.type ||
      this.sourceEditor.value === String(currentNode.attrs.tex)
    ) {
      return;
    }
    this.writeTex(position, this.sourceEditor.value, false);
  };

  private writeTex(position: number, tex: string, separateHistory: boolean): void {
    const tr = this.view.state.tr.setNodeAttribute(position, "tex", tex);
    // A partially typed expression is still an explicitly authored equation.
    // Keep it parseable after save/reopen, without relaxing currency detection.
    if (
      !this.isDisplay(this.node) &&
      this.node.attrs.delimiter === "$" &&
      !isPlausibleScientSingleDollarTex(tex)
    )
      tr.setNodeAttribute(position, "delimiter", "\\(");
    this.view.dispatch(separateHistory ? closeHistory(tr) : tr);
  }

  private readonly handleRenderClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0 || !this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const selection = this.view.state.selection;
    if (!(selection instanceof NodeSelection) || selection.from !== position) {
      this.view.dispatch(
        this.view.state.tr
          .setSelection(NodeSelection.create(this.view.state.doc, position))
          .setMeta("addToHistory", false),
      );
    }
    this.showSourceEditor();
    this.sourceEditor.focus();
    const caret = this.sourceEditor.value.length;
    this.sourceEditor.setSelectionRange(caret, caret);
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.isComposing || event.defaultPrevented || !this.view.editable) return;
    const isUndo = matchesScientMarkdownShortcut(event, "undo");
    const isRedo = matchesScientMarkdownShortcut(event, "redo");
    if (isUndo || isRedo) {
      // Never fall back to the textarea's independent browser history, even
      // when the document has nothing left to undo.
      event.preventDefault();
      event.stopPropagation();
      const replay = isRedo ? redo : undo;
      if (replay(this.view.state, this.view.dispatch)) {
        const position = this.getPos();
        const node = position === undefined ? null : this.view.state.doc.nodeAt(position);
        if (node?.type === this.node.type) this.sourceEditor.value = String(node.attrs.tex);
      }
      return;
    }
    if (
      !this.isDisplay(this.node) &&
      handleInlineAtomEditorKeyDown({
        editor: this.sourceEditor,
        event,
        fieldDirection: computedTextDirection(this.sourceEditor, "ltr"),
        getPos: this.getPos,
        node: this.node,
        surroundingDirection: computedTextDirection(this.dom, "ltr"),
        view: this.view,
      })
    ) {
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    leaveAtomEditor(this.view, this.getPos, this.node);
  };

  private render(): void {
    const tex = String(this.node.attrs.tex);
    if (this.sourceEditor !== document.activeElement) this.sourceEditor.value = tex;
    if (this.renderedTex === tex) return;
    const initial = this.renderedTex === undefined;
    this.renderedTex = tex;
    clearTimeout(this.validationTimer);
    const version = ++this.validationVersion;
    this.dom.setAttribute("data-scient-markdown-math-validity", "pending");
    if (this.lastValidTex !== null)
      this.renderPreview(this.lastValidTex, this.lastValidTex !== tex);
    else if (initial) this.renderPreview(tex, false);
    const display = this.isDisplay(this.node);
    const validate = () => {
      void getScientKatexRuntimePromise()
        .then((runtime) => {
          if (this.destroyed || version !== this.validationVersion) return undefined;
          return renderCachedScientMath(runtime, tex, display);
        })
        .then((html) => {
          if (this.destroyed || html === undefined || version !== this.validationVersion) return;
          if (html !== null) {
            this.lastValidTex = tex;
            this.dom.setAttribute("data-scient-markdown-math-validity", "valid");
            this.renderPreview(tex, false);
            return;
          }
          this.settleInvalid(version, tex);
        })
        .catch(() => this.settleInvalid(version, tex));
    };
    if (initial) validate();
    else this.validationTimer = setTimeout(validate, 100);
  }

  private showSourceEditor(): void {
    if (!this.toolsRoot) {
      this.toolsRoot = createRoot(this.toolsHost);
      this.toolsRoot.render(<MathInputTools controller={this.mathInput} />);
    }
    this.sourceEditor.hidden = false;
    this.toolsHost.hidden = false;
    this.sourceEditor.value = String(this.node.attrs.tex);
  }

  private settleInvalid(version: number, tex: string): void {
    if (this.destroyed || version !== this.validationVersion) return;
    this.dom.setAttribute("data-scient-markdown-math-validity", "invalid");
    this.renderPreview(this.lastValidTex ?? tex, this.lastValidTex !== null);
  }

  private renderPreview(tex: string, retained: boolean): void {
    if (this.destroyed) return;
    this.retainedNotice.hidden = !retained;
    this.dom.setAttribute(
      "data-scient-markdown-math-source-state",
      retained ? "retained" : "current",
    );
    this.reactRoot.render(
      this.isDisplay(this.node) ? <ScientDisplayMath tex={tex} /> : <ScientInlineMath tex={tex} />,
    );
  }

  private isDisplay(node: ProseMirrorNode): boolean {
    return node.type.name === "display_math" || node.attrs.display === true;
  }
}

export function createScientMathNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientMathNodeView(node, view, getPos);
}
