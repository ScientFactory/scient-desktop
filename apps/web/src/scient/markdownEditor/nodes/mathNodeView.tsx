import { createRoot, type Root } from "react-dom/client";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

import { ScientDisplayMath, ScientInlineMath } from "~/scient/math/ScientMath";

class ScientMathNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly renderHost: HTMLSpanElement;
  private readonly sourceEditor: HTMLInputElement | HTMLTextAreaElement;
  private readonly reactRoot: Root;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    const display = node.type.name === "display_math";
    this.dom = document.createElement(display ? "div" : "span");
    this.dom.className = display
      ? "scient-markdown-math is-display"
      : "scient-markdown-math is-inline";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-math", display ? "display" : "inline");

    this.renderHost = document.createElement("span");
    this.renderHost.className = "scient-markdown-math-render";
    this.dom.append(this.renderHost);
    this.sourceEditor = document.createElement(display ? "textarea" : "input");
    this.sourceEditor.className = "scient-markdown-math-source";
    this.sourceEditor.dir = "ltr";
    this.sourceEditor.hidden = true;
    this.sourceEditor.setAttribute(
      "aria-label",
      display ? "Display math source" : "Inline math source",
    );
    this.sourceEditor.addEventListener("input", this.handleInput);
    this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.append(this.sourceEditor);
    this.reactRoot = createRoot(this.renderHost);
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = String(node.attrs.tex);
    }
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
    this.sourceEditor.hidden = false;
    this.sourceEditor.value = String(this.node.attrs.tex);
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
    this.sourceEditor.removeEventListener("input", this.handleInput);
    this.sourceEditor.removeEventListener("keydown", this.handleKeyDown);
    this.reactRoot.unmount();
  }

  private readonly handleInput = () => {
    const position = this.getPos();
    if (position === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        tex: this.sourceEditor.value,
      }),
    );
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.view.focus();
  };

  private render(): void {
    const tex = String(this.node.attrs.tex);
    this.sourceEditor.value = tex;
    this.reactRoot.render(
      this.node.type.name === "display_math" ? (
        <ScientDisplayMath tex={tex} />
      ) : (
        <ScientInlineMath tex={tex} />
      ),
    );
  }
}

export function createScientMathNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientMathNodeView(node, view, getPos);
}
