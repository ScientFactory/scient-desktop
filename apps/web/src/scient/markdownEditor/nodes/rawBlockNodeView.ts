import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";

import { leaveAtomEditor } from "../prosemirror/safeSelection";

export type ScientMarkdownRawSourceEditorRegistrar = (editor: HTMLTextAreaElement) => () => void;

function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "definition":
      return "Reference definition";
    case "html":
      return "HTML source";
    case "toml":
      return "TOML source";
    case "yaml":
      return "YAML source";
    default:
      return `${kind} source`;
  }
}

class ScientRawBlockNodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly kind = document.createElement("span");
  private readonly sourceEditor = document.createElement("textarea");
  private readonly unregisterSourceEditor: (() => void) | undefined;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-source-island";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-source-island", "true");
    this.kind.className = "scient-markdown-source-island-kind";
    this.dom.append(this.kind);
    this.sourceEditor.className = "scient-markdown-source-island-editor";
    this.sourceEditor.dir = "ltr";
    this.sourceEditor.rows = 3;
    this.sourceEditor.spellcheck = false;
    this.sourceEditor.tabIndex = -1;
    this.sourceEditor.readOnly = !this.view.editable;
    this.sourceEditor.setAttribute("aria-label", "Markdown source block");
    this.sourceEditor.addEventListener("mousedown", this.handleMouseDown);
    this.sourceEditor.addEventListener("input", this.handleInput);
    this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.append(this.sourceEditor);
    this.unregisterSourceEditor = registerSourceEditor?.(this.sourceEditor);
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
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
  }

  stopEvent(event: Event): boolean {
    return event.target === this.sourceEditor;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.unregisterSourceEditor?.();
    this.sourceEditor.removeEventListener("mousedown", this.handleMouseDown);
    this.sourceEditor.removeEventListener("input", this.handleInput);
    this.sourceEditor.removeEventListener("keydown", this.handleKeyDown);
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const selection = this.view.state.selection;
    if (selection instanceof NodeSelection && selection.from === position) return;
    // Select the atom before the browser places the textarea caret. Keeping
    // the default mouse action gives direct, one-click editing in this field.
    this.view.dispatch(
      this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)),
    );
  };

  private readonly handleInput = (event: Event) => {
    if (
      this.sourceEditor.readOnly ||
      !this.view.editable ||
      (event instanceof InputEvent && event.isComposing)
    ) {
      return;
    }
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
    leaveAtomEditor(this.view, this.getPos, this.node);
  };

  private render(): void {
    const source = String(this.node.attrs.source);
    const kind = String(this.node.attrs.sourceKind);
    const label = sourceKindLabel(kind);
    const definition = kind === "definition";
    this.kind.textContent = definition ? "Reference" : label;
    this.dom.setAttribute("data-scient-markdown-source-kind", kind);
    this.sourceEditor.setAttribute("aria-label", label);
    this.sourceEditor.rows = definition ? 1 : 3;
    this.sourceEditor.tabIndex = definition ? 0 : -1;
    if (this.sourceEditor !== document.activeElement) this.sourceEditor.value = source;
  }
}

export function createScientRawBlockNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
): NodeView {
  return new ScientRawBlockNodeView(node, view, getPos, registerSourceEditor);
}
