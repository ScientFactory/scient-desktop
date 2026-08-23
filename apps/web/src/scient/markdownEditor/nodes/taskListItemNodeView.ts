import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

class ScientTaskListItemNodeView implements NodeView {
  readonly dom = document.createElement("li");
  readonly contentDOM = document.createElement("div");
  private checkbox: HTMLInputElement | null = null;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.contentDOM.className = "scient-markdown-task-content";
    this.dom.append(this.contentDOM);
    this.renderTaskState();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.renderTaskState();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.checkbox;
  }

  destroy(): void {
    this.removeCheckbox();
  }

  private readonly handleChange = () => {
    if (!this.checkbox || !this.view.editable) {
      if (this.checkbox) this.checkbox.checked = Boolean(this.node.attrs.taskChecked);
      return;
    }
    const position = this.getPos();
    if (position === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        taskChecked: this.checkbox.checked,
      }),
    );
  };

  private removeCheckbox(): void {
    this.checkbox?.removeEventListener("change", this.handleChange);
    this.checkbox?.remove();
    this.checkbox = null;
  }

  private renderTaskState(): void {
    const checked = this.node.attrs.taskChecked;
    if (typeof checked !== "boolean") {
      this.dom.removeAttribute("data-task-checked");
      this.removeCheckbox();
      return;
    }
    this.dom.setAttribute("data-task-checked", String(checked));
    if (!this.checkbox) {
      this.checkbox = document.createElement("input");
      this.checkbox.type = "checkbox";
      this.checkbox.className = "scient-markdown-task-checkbox";
      this.checkbox.setAttribute("aria-label", "Toggle task");
      this.checkbox.addEventListener("change", this.handleChange);
      this.dom.prepend(this.checkbox);
    }
    this.checkbox.checked = checked;
    this.checkbox.disabled = !this.view.editable;
  }
}

export function createScientTaskListItemNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientTaskListItemNodeView(node, view, getPos);
}
