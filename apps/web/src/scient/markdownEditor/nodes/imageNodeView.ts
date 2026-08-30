import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

export type ScientMarkdownImageSourceResolver = (
  source: string,
) => string | null | Promise<string | null>;

class ScientImageNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly image = document.createElement("img");
  private readonly caption = document.createElement("span");
  private readonly placeholder = document.createElement("span");
  private readonly editor = document.createElement("span");
  private readonly sourceInput = document.createElement("input");
  private readonly altInput = document.createElement("input");
  private readonly titleInput = document.createElement("input");
  private node: ProseMirrorNode;
  private resolveVersion = 0;
  private requestedSource: string | null = null;
  private destroyed = false;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly resolveSource: ScientMarkdownImageSourceResolver | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-image";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-image", "true");
    this.image.className = "scient-markdown-image-render";
    this.dom.append(this.image);
    this.caption.className = "scient-markdown-image-caption";
    this.dom.append(this.caption);
    this.placeholder.className = "scient-markdown-image-placeholder";
    this.placeholder.textContent = "Choose an image path";
    this.dom.append(this.placeholder);
    this.editor.className = "scient-markdown-image-editor";
    this.editor.hidden = true;
    this.sourceInput.type = "text";
    this.sourceInput.dir = "ltr";
    this.sourceInput.placeholder = "Relative image path";
    this.sourceInput.setAttribute("aria-label", "Image path");
    this.altInput.type = "text";
    this.altInput.dir = "auto";
    this.altInput.placeholder = "Describe the image";
    this.altInput.setAttribute("aria-label", "Image alternative text");
    this.titleInput.type = "text";
    this.titleInput.dir = "auto";
    this.titleInput.placeholder = "Optional title or caption";
    this.titleInput.setAttribute("aria-label", "Image title or caption");
    this.sourceInput.addEventListener("input", this.handleInput);
    this.altInput.addEventListener("input", this.handleInput);
    this.titleInput.addEventListener("input", this.handleInput);
    this.editor.append(this.sourceInput, this.altInput, this.titleInput);
    this.dom.append(this.editor);
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
    this.editor.hidden = false;
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
    this.editor.hidden = true;
  }

  stopEvent(event: Event): boolean {
    return this.editor.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.resolveVersion += 1;
    this.sourceInput.removeEventListener("input", this.handleInput);
    this.altInput.removeEventListener("input", this.handleInput);
    this.titleInput.removeEventListener("input", this.handleInput);
  }

  private readonly handleInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const position = this.getPos();
    if (position === undefined) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        alt: this.altInput.value,
        src: this.sourceInput.value,
        title: this.titleInput.value.trim().length > 0 ? this.titleInput.value : null,
      }),
    );
  };

  private render(): void {
    const source = String(this.node.attrs.src);
    const alt = String(this.node.attrs.alt ?? "");
    const title = typeof this.node.attrs.title === "string" ? this.node.attrs.title : "";
    this.sourceInput.value = source;
    this.altInput.value = alt;
    this.titleInput.value = title;
    this.image.alt = alt;
    this.image.title = title;
    this.caption.textContent = title;
    this.caption.hidden = title.length === 0;
    if (source.length === 0) {
      this.requestedSource = source;
      this.resolveVersion += 1;
      this.image.removeAttribute("src");
      this.image.hidden = true;
      this.placeholder.hidden = false;
      this.placeholder.textContent = "Choose an image path";
      return;
    }
    if (source === this.requestedSource) return;
    this.requestedSource = source;
    this.image.removeAttribute("src");
    this.image.hidden = true;
    this.placeholder.hidden = false;
    this.placeholder.textContent = `Loading ${source}`;
    const version = ++this.resolveVersion;
    void Promise.resolve(this.resolveSource ? this.resolveSource(source) : source)
      .then((resolved) => {
        if (this.destroyed || version !== this.resolveVersion) return;
        if (resolved) {
          this.image.src = resolved;
          this.image.hidden = false;
          this.placeholder.hidden = true;
        } else {
          this.image.removeAttribute("src");
          this.image.hidden = true;
          this.placeholder.hidden = false;
          this.placeholder.textContent = `Unable to resolve ${source}`;
        }
      })
      .catch(() => {
        if (this.destroyed || version !== this.resolveVersion) return;
        this.image.removeAttribute("src");
        this.image.hidden = true;
        this.placeholder.hidden = false;
        this.placeholder.textContent = `Unable to resolve ${source}`;
      });
  }
}

export function createScientImageNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  resolveSource?: ScientMarkdownImageSourceResolver,
): NodeView {
  return new ScientImageNodeView(node, view, getPos, resolveSource);
}
