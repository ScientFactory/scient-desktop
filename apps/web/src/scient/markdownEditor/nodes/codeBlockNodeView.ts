import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { resolveScientRichFenceKind } from "~/scient/presentation/ScientRichFence";

import type { ScientNestedCodeEditor } from "./codeMirrorCodeEditor";
import { ScientEditableRichFence } from "./ScientEditableRichFence";

function codeLanguage(node: ProseMirrorNode): string {
  return String(node.attrs.params).trim().split(/\s+/u)[0] || "text";
}

function fenceMetadata(node: ProseMirrorNode): string | undefined {
  const params = String(node.attrs.params).trim();
  const firstSpace = params.search(/\s/u);
  if (firstSpace < 0) return undefined;
  const metadata = params.slice(firstSpace).trim();
  return metadata.length > 0 ? metadata : undefined;
}

class ScientCodeBlockNodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly languageLabel = document.createElement("span");
  private readonly rendered = document.createElement("div");
  private readonly editorHost = document.createElement("div");
  private nestedEditor: ScientNestedCodeEditor | null = null;
  private reactRoot: Root | null = null;
  private node: ProseMirrorNode;
  private destroyed = false;
  private highlightVersion = 0;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-code-block";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-code-block", "true");
    const header = document.createElement("div");
    header.className = "scient-markdown-code-header";
    this.languageLabel.className = "scient-markdown-code-language";
    header.append(this.languageLabel);
    this.dom.append(header);
    this.rendered.className = "scient-markdown-code-render";
    this.dom.append(this.rendered);
    this.editorHost.className = "scient-markdown-code-editor";
    this.editorHost.hidden = true;
    this.dom.append(this.editorHost);
    // Clicking anywhere in the block opens the nested editor; without this a
    // reader has no visible way in, since editing waits for a node selection.
    this.dom.addEventListener("mousedown", (event) => {
      if (!(event.target instanceof Element)) return;
      if (this.editorHost.contains(event.target)) return;
      if (event.target.closest("button, a, input, select, textarea, [role='button']")) return;
      if (!this.view.editable) return;
      const position = this.getPos();
      if (position === undefined) return;
      event.preventDefault();
      this.view.dispatch(
        this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)),
      );
    });
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.nestedEditor?.replaceExternalCode(node.textContent);
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
    // Plain code in the editor duplicates the highlighted render, so hide it;
    // rich fences (diagrams, plots) stay visible as a live preview.
    this.rendered.hidden = !this.dom.hasAttribute("data-scient-markdown-rich-fence");
    this.editorHost.hidden = false;
    void this.activateEditor();
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
    this.rendered.hidden = false;
    this.editorHost.hidden = true;
  }

  stopEvent(event: Event): boolean {
    if (this.editorHost.contains(event.target as globalThis.Node)) return true;
    return (
      event.target instanceof Element &&
      event.target.closest("button, a, input, select, textarea, [role='button']") !== null
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.highlightVersion += 1;
    this.nestedEditor?.destroy();
    this.nestedEditor = null;
    this.reactRoot?.unmount();
    this.reactRoot = null;
  }

  private async activateEditor(): Promise<void> {
    if (this.nestedEditor) {
      this.nestedEditor.focus();
      return;
    }
    const { createScientNestedCodeEditor } = await import("./codeMirrorCodeEditor");
    if (this.destroyed) return;
    this.nestedEditor = createScientNestedCodeEditor({
      parent: this.editorHost,
      code: this.node.textContent,
      language: codeLanguage(this.node),
      onEscape: () => this.view.focus(),
      onUserCodeChange: (code) => this.replaceCode(code),
    });
    this.nestedEditor.focus();
  }

  private replaceCode(code: string): void {
    const position = this.getPos();
    if (position === undefined || code === this.node.textContent) return;
    this.view.dispatch(
      this.view.state.tr.replaceWith(
        position + 1,
        position + 1 + this.node.content.size,
        code.length > 0 ? this.node.type.schema.text(code) : [],
      ),
    );
  }

  private render(): void {
    const language = codeLanguage(this.node);
    const code = this.node.textContent;
    const richKind = resolveScientRichFenceKind(language);
    const metadata = fenceMetadata(this.node);
    this.languageLabel.textContent = language === "text" ? "Plain text" : language;
    this.dom.classList.toggle(
      "is-empty",
      code.length === 0 && language === "text" && richKind === null,
    );
    if (richKind) {
      this.highlightVersion += 1;
      this.reactRoot ??= createRoot(this.rendered);
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      this.reactRoot.render(
        createElement(ScientEditableRichFence, {
          kind: richKind,
          language,
          source: code,
          theme,
          title: null,
          ...(metadata ? { fenceMeta: metadata } : {}),
        }),
      );
      this.dom.setAttribute("data-scient-markdown-rich-fence", richKind);
      return;
    }
    this.dom.removeAttribute("data-scient-markdown-rich-fence");
    if (this.reactRoot) {
      this.reactRoot.unmount();
      this.reactRoot = null;
    }
    this.rendered.textContent = code;
    const version = ++this.highlightVersion;
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    void getSyntaxHighlighterPromise(language)
      .then((highlighter) => {
        if (this.destroyed || version !== this.highlightVersion) return;
        try {
          this.rendered.innerHTML = highlighter.codeToHtml(code, {
            lang: language,
            theme: resolveDiffThemeName(theme),
          });
        } catch {
          this.rendered.textContent = code;
        }
      })
      .catch(() => {
        if (!this.destroyed && version === this.highlightVersion) this.rendered.textContent = code;
      });
  }
}

export function createScientCodeBlockNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ScientCodeBlockNodeView(node, view, getPos);
}
