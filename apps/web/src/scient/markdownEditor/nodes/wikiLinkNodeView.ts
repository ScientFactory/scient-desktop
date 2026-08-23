import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

class ScientWikiLinkNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly label = document.createElement("span");
  private readonly sourceEditor = document.createElement("input");
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-wiki-link";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-wiki-link", "true");
    this.label.className = "scient-markdown-wiki-link-label";
    this.dom.append(this.label);
    this.sourceEditor.className = "scient-markdown-wiki-link-source";
    this.sourceEditor.dir = "auto";
    this.sourceEditor.hidden = true;
    this.sourceEditor.setAttribute("aria-label", "Wiki link target and label");
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
    this.sourceEditor.value = this.sourceValue();
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

  private readonly handleInput = () => {
    const position = this.getPos();
    if (position === undefined) return;
    const separator = this.sourceEditor.value.indexOf("|");
    const target = (
      separator < 0 ? this.sourceEditor.value : this.sourceEditor.value.slice(0, separator)
    ).trim();
    const label = separator < 0 ? null : this.sourceEditor.value.slice(separator + 1).trim();
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        label: label && label.length > 0 ? label : null,
        target,
      }),
    );
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    event.preventDefault();
    this.view.focus();
  };

  private sourceValue(): string {
    const target = String(this.node.attrs.target);
    return typeof this.node.attrs.label === "string"
      ? `${target}|${this.node.attrs.label}`
      : target;
  }

  private render(): void {
    const target = String(this.node.attrs.target);
    this.label.textContent = String(this.node.attrs.label ?? target);
    this.dom.setAttribute("data-target", target);
    this.dom.title = target;
    if (this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = this.sourceValue();
    }
  }
}

export function createScientWikiLinkNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientWikiLinkNodeView(node, view, getPos);
}
