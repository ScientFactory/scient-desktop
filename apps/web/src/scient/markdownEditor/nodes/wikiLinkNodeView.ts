import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

let nextWikiListId = 1;

class ScientWikiLinkNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly label = document.createElement("span");
  private readonly sourceEditor = document.createElement("input");
  private readonly suggestions = document.createElement("datalist");
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly onOpen: ((target: string) => void) | undefined,
    private readonly getSuggestions: (() => ReadonlyArray<string>) | undefined,
    private readonly targetExists: ((target: string) => boolean | null) | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-wiki-link";
    this.dom.contentEditable = "false";
    this.dom.tabIndex = 0;
    this.dom.setAttribute("role", "link");
    this.dom.setAttribute("data-scient-markdown-wiki-link", "true");
    this.label.className = "scient-markdown-wiki-link-label";
    this.dom.append(this.label);
    this.sourceEditor.className = "scient-markdown-wiki-link-source";
    this.sourceEditor.dir = "auto";
    this.sourceEditor.hidden = true;
    this.sourceEditor.setAttribute("aria-label", "Wiki link target and label");
    this.suggestions.id = `scient-markdown-wiki-targets-${nextWikiListId}`;
    nextWikiListId += 1;
    this.sourceEditor.setAttribute("list", this.suggestions.id);
    this.sourceEditor.addEventListener("input", this.handleInput);
    this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.addEventListener("click", this.handleClick);
    this.dom.addEventListener("keydown", this.handleLinkKeyDown);
    this.dom.append(this.sourceEditor, this.suggestions);
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
    this.populateSuggestions();
    this.render();
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
    this.dom.removeEventListener("click", this.handleClick);
    this.dom.removeEventListener("keydown", this.handleLinkKeyDown);
  }

  private readonly handleInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
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

  private readonly handleClick = (event: MouseEvent) => {
    if (!this.onOpen || (this.view.editable && !(event.metaKey || event.ctrlKey))) return;
    event.preventDefault();
    this.onOpen(String(this.node.attrs.target));
  };

  private readonly handleLinkKeyDown = (event: KeyboardEvent) => {
    if (event.target === this.sourceEditor || event.key !== "Enter" || !this.onOpen) return;
    if (this.view.editable && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    this.onOpen(String(this.node.attrs.target));
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

  private populateSuggestions(): void {
    this.suggestions.replaceChildren(
      ...(this.getSuggestions?.() ?? []).slice(0, 300).map((target) => {
        const option = document.createElement("option");
        option.value = target;
        return option;
      }),
    );
  }

  private render(): void {
    const target = String(this.node.attrs.target);
    this.label.textContent = String(this.node.attrs.label ?? target);
    this.dom.setAttribute("data-target", target);
    this.dom.setAttribute("aria-label", `Open wiki link ${target}`);
    const exists = this.targetExists?.(target) ?? null;
    this.dom.classList.toggle("is-missing", exists === false);
    this.dom.setAttribute(
      "data-scient-markdown-wiki-target-state",
      exists === null ? "unknown" : exists ? "present" : "missing",
    );
    this.sourceEditor.setAttribute("aria-invalid", exists === false ? "true" : "false");
    this.dom.title = exists === false ? `Missing Markdown target: ${target}` : target;
    if (this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = this.sourceValue();
    }
  }
}

export function createScientWikiLinkNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  onOpen?: (target: string) => void,
  getSuggestions?: () => ReadonlyArray<string>,
  targetExists?: (target: string) => boolean | null,
): NodeView {
  return new ScientWikiLinkNodeView(node, view, getPos, onOpen, getSuggestions, targetExists);
}
