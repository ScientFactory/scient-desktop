import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

class ScientRawBlockNodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly kind = document.createElement("span");
  private readonly preview = document.createElement("pre");
  private readonly sourceEditor = document.createElement("textarea");
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-source-island";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-source-island", "true");
    this.kind.className = "scient-markdown-source-island-kind";
    this.dom.append(this.kind);
    this.preview.className = "scient-markdown-source-island-preview";
    this.dom.append(this.preview);
    this.sourceEditor.className = "scient-markdown-source-island-editor";
    this.sourceEditor.dir = "auto";
    this.sourceEditor.hidden = true;
    this.sourceEditor.setAttribute("aria-label", "Markdown source block");
    this.sourceEditor.addEventListener("input", this.handleInput);
    this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.append(this.sourceEditor);
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
    this.sourceEditor.hidden = false;
    this.sourceEditor.value = String(this.node.attrs.source);
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
  }

  private readonly handleInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const position = this.getPos();
    if (position === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        source: this.sourceEditor.value,
      }),
    );
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    event.preventDefault();
    this.view.focus();
  };

  private render(): void {
    const source = String(this.node.attrs.source);
    const kind = String(this.node.attrs.sourceKind);
    this.kind.textContent = kind === "html" ? "HTML source" : `${kind} source`;
    this.preview.textContent = source;
    if (this.sourceEditor !== document.activeElement) this.sourceEditor.value = source;
  }
}

export function createScientRawBlockNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientRawBlockNodeView(node, view, getPos);
}
