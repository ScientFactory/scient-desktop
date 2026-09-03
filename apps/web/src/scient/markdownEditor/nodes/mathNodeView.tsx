import { createRoot, type Root } from "react-dom/client";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";

import {
  getScientKatexRuntimePromise,
  ScientDisplayMath,
  ScientInlineMath,
} from "~/scient/math/ScientMath";

import { handleInlineAtomEditorKeyDown, leaveAtomEditor } from "../prosemirror/safeSelection";

class ScientMathNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly renderHost: HTMLSpanElement;
  private readonly sourceEditor: HTMLInputElement | HTMLTextAreaElement;
  private readonly retainedNotice: HTMLSpanElement;
  private readonly reactRoot: Root;
  private node: ProseMirrorNode;
  private destroyed = false;
  private validationVersion = 0;
  private lastValidVersion = 0;
  private lastValidTex: string | null = null;
  private currentValidity: boolean | null = null;

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
    this.sourceEditor = document.createElement(display ? "textarea" : "input");
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
  }

  stopEvent(event: Event): boolean {
    return event.target === this.sourceEditor;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.validationVersion += 1;
    this.renderHost.removeEventListener("click", this.handleRenderClick);
    this.sourceEditor.removeEventListener("input", this.handleInput);
    this.sourceEditor.removeEventListener("compositionend", this.handleInput);
    this.sourceEditor.removeEventListener("keydown", this.handleKeyDown);
    this.reactRoot.unmount();
  }

  private readonly handleInput = (event: Event) => {
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
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...currentNode.attrs,
        tex: this.sourceEditor.value,
      }),
    );
  };

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
    if (
      !this.isDisplay(this.node) &&
      this.sourceEditor instanceof HTMLInputElement &&
      handleInlineAtomEditorKeyDown({
        direction: "ltr",
        editor: this.sourceEditor,
        event,
        getPos: this.getPos,
        node: this.node,
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
    const version = ++this.validationVersion;
    this.currentValidity = null;
    this.dom.setAttribute("data-scient-markdown-math-validity", "pending");
    this.renderPreview(
      this.lastValidTex ?? tex,
      this.lastValidTex !== null && this.lastValidTex !== tex,
    );
    const display = this.isDisplay(this.node);
    void getScientKatexRuntimePromise()
      .then(({ renderScientTexToHtml }) => renderScientTexToHtml(tex, display))
      .then((html) => {
        if (this.destroyed) return;
        if (html !== null) {
          if (version >= this.lastValidVersion) {
            this.lastValidVersion = version;
            this.lastValidTex = tex;
          }
          if (version === this.validationVersion) {
            this.currentValidity = true;
            this.dom.setAttribute("data-scient-markdown-math-validity", "valid");
            this.renderPreview(tex, false);
          } else if (this.currentValidity === false && this.lastValidTex !== null) {
            this.renderPreview(this.lastValidTex, true);
          }
          return;
        }
        this.settleInvalid(version, tex);
      })
      .catch(() => this.settleInvalid(version, tex));
  }

  private showSourceEditor(): void {
    this.sourceEditor.hidden = false;
    this.sourceEditor.value = String(this.node.attrs.tex);
  }

  private settleInvalid(version: number, tex: string): void {
    if (this.destroyed || version !== this.validationVersion) return;
    this.currentValidity = false;
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
