import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

function sourceValue(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "citation":
      return String(node.attrs.source);
    case "footnote_reference":
      return String(node.attrs.label);
    default:
      return String(node.attrs.source);
  }
}

function visibleLabel(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "citation":
      return `[${String(node.attrs.source)}]`;
    case "footnote_reference":
      return String(node.attrs.label);
    default:
      return `Footnote ${String(node.attrs.label)}`;
  }
}

class ScientReferenceNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly label = document.createElement("span");
  private readonly sourceEditor: HTMLInputElement | HTMLTextAreaElement;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    const definition = node.type.name === "footnote_definition";
    this.dom = document.createElement(
      definition ? "aside" : node.type.name === "footnote_reference" ? "sup" : "span",
    );
    this.dom.className = definition
      ? "scient-markdown-footnote-definition"
      : "scient-markdown-reference";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-reference", node.type.name);
    this.label.className = "scient-markdown-reference-label";
    this.dom.append(this.label);
    this.sourceEditor = document.createElement(definition ? "textarea" : "input");
    this.sourceEditor.className = "scient-markdown-reference-source";
    this.sourceEditor.dir = "auto";
    this.sourceEditor.hidden = true;
    this.sourceEditor.setAttribute(
      "aria-label",
      definition
        ? "Footnote definition source"
        : node.type.name === "citation"
          ? "Citation source"
          : "Footnote label",
    );
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
    this.sourceEditor.value = sourceValue(this.node);
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
    const value = this.sourceEditor.value;
    const attrs =
      this.node.type.name === "citation"
        ? { ...this.node.attrs, source: value }
        : this.node.type.name === "footnote_reference"
          ? { ...this.node.attrs, label: value }
          : {
              ...this.node.attrs,
              label: /^\[\^([^\]\r\n]+)\]:/u.exec(value)?.[1] ?? this.node.attrs.label,
              source: value,
            };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(position, undefined, attrs));
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    event.preventDefault();
    this.view.focus();
  };

  private render(): void {
    this.label.textContent = visibleLabel(this.node);
    if (this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = sourceValue(this.node);
    }
  }
}

export function createScientReferenceNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientReferenceNodeView(node, view, getPos);
}
