import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  ScientRichFenceAuthoringActions,
  ScientRichFenceContextMenuHandler,
} from "~/scient/presentation/RichFenceSourceActions";
import { resolveScientRichFenceKind } from "~/scient/presentation/ScientRichFence";

import { leaveAtomEditor } from "../prosemirror/safeSelection";
import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditor,
  type ScientNestedCodeEditorRegistrar,
} from "./codeMirrorCodeEditor";
import type {
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownTheme,
  ScientMarkdownThemeResolver,
} from "./externalPresentation";
import { ScientEditableRichFence } from "./ScientEditableRichFence";

export type ScientMarkdownCodeEditorRegistrar = ScientNestedCodeEditorRegistrar;

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

function documentTheme(): ScientMarkdownTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

class ScientCodeBlockNodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly languageLabel = document.createElement("span");
  private readonly rendered = document.createElement("div");
  private readonly editorHost = document.createElement("div");
  private readonly loadError = document.createElement("div");
  private readonly retryButton = document.createElement("button");
  private nestedEditor: ScientNestedCodeEditor | null = null;
  private unregisterCodeEditor: (() => void) | undefined;
  private reactRoot: Root | null = null;
  private node: ProseMirrorNode;
  private destroyed = false;
  private selected = false;
  private selectingFromEditorPointer = false;
  private richSourceOpen = false;
  private inlineSourceHost: HTMLElement | null = null;
  private focusSourceOnMount = false;
  private readonly authoringActions: ScientRichFenceAuthoringActions;
  private readonly unregisterExternalPresentation: (() => void) | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly resolveTheme: ScientMarkdownThemeResolver = documentTheme,
    registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
    showRichFenceContextMenu?: ScientRichFenceContextMenuHandler,
    private readonly registerCodeEditor?: ScientMarkdownCodeEditorRegistrar,
  ) {
    this.node = node;
    this.authoringActions = {
      onEditSource: this.requestSourceEdit,
      ...(showRichFenceContextMenu ? { showContextMenu: showRichFenceContextMenu } : {}),
    };
    this.dom.className = "scient-markdown-code-block";
    this.dom.contentEditable = "false";
    this.dom.dir = "ltr";
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
    this.loadError.className = "scient-markdown-code-load-error";
    this.loadError.hidden = true;
    this.loadError.setAttribute("role", "status");
    this.loadError.append("Code editor could not open. Markdown source is still available.");
    this.retryButton.type = "button";
    this.retryButton.textContent = "Retry";
    this.retryButton.setAttribute("aria-label", "Retry code editor");
    this.retryButton.addEventListener("click", this.retryEditor);
    this.loadError.append(this.retryButton);
    this.dom.append(this.loadError);
    // Ordinary code is always one CodeMirror surface. Rich cards own every
    // event in their rendered surface and expose source editing explicitly.
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.editorHost.addEventListener("focusin", this.handleEditorFocus);
    this.unregisterExternalPresentation = registerExternalPresentation?.((change) => {
      if ((change === "appearance" || change === "mode") && this.isRichFence()) {
        if (!this.view.editable) {
          this.richSourceOpen = false;
          this.loadError.hidden = true;
        }
        this.render();
      }
    });
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.selected = true;
    if (!this.isRichFence() && this.view.editable) {
      this.activateEditor(!this.selectingFromEditorPointer);
    }
  }

  deselectNode(): void {
    this.selected = false;
    if (!this.isRichFence()) return;
    this.richSourceOpen = false;
    this.editorHost.hidden = !this.inlineSourceHost;
    this.loadError.hidden = true;
    this.render();
  }

  stopEvent(event: Event): boolean {
    if (this.editorHost.contains(event.target as globalThis.Node)) return true;
    if (this.isRichFenceRenderedTarget(event.target)) return true;
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
    this.unregisterCodeEditor?.();
    this.unregisterCodeEditor = undefined;
    this.nestedEditor?.destroy();
    this.nestedEditor = null;
    this.reactRoot?.unmount();
    this.reactRoot = null;
    this.unregisterExternalPresentation?.();
    this.retryButton.removeEventListener("click", this.retryEditor);
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.editorHost.removeEventListener("focusin", this.handleEditorFocus);
  }

  private isRichFenceRenderedTarget(target: EventTarget | null): boolean {
    return (
      this.isRichFence() && target instanceof globalThis.Node && this.rendered.contains(target)
    );
  }

  private isRichFence(): boolean {
    return this.dom.hasAttribute("data-scient-markdown-rich-fence");
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (this.editorHost.contains(event.target)) {
      if (!this.view.editable) return;
      if (this.inlineSourceHost) {
        this.openSourceEditor(false);
        return;
      }
      if (this.isRichFence() || this.selected) return;
      const position = this.getPos();
      if (position !== undefined) {
        this.selectingFromEditorPointer = true;
        try {
          this.selectSelf(position);
        } finally {
          this.selectingFromEditorPointer = false;
        }
      }
      // Keep the native CodeMirror pointer event. It owns exact caret placement.
      return;
    }
    if (this.isRichFenceRenderedTarget(event.target)) return;
    if (event.target.closest("button, a, input, select, textarea, [role='button']")) return;
    if (!this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    event.preventDefault();
    if (this.isRichFence()) {
      // A bare click selects the visual fence. Its visible source or explicit
      // source action owns entry into editing.
      if (!this.selected) this.selectSelf(position);
      return;
    }
    if (!this.selected) this.selectSelf(position);
    else this.activateEditor(true);
  };

  private selectSelf(position: number): void {
    this.view.dispatch(
      this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)),
    );
  }

  private readonly requestSourceEdit = () => this.openSourceEditor(true);

  private readonly handleEditorFocus = () => {
    if (this.inlineSourceHost) this.openSourceEditor(false);
  };

  private openSourceEditor(focus: boolean): void {
    if (this.destroyed || !this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const selection = this.view.state.selection;
    if (!(selection instanceof NodeSelection && selection.from === position)) {
      this.view.dispatch(
        this.view.state.tr
          .setSelection(NodeSelection.create(this.view.state.doc, position))
          .setMeta("addToHistory", false),
      );
    }
    if (this.richSourceOpen && !focus) return;
    this.richSourceOpen = true;
    this.render(focus);
  }

  private readonly mountSourceEditor = (host: HTMLElement): (() => void) => {
    this.inlineSourceHost = host;
    this.editorHost.classList.add("is-inline-rich-source");
    host.append(this.editorHost);
    const focus = this.focusSourceOnMount;
    this.focusSourceOnMount = false;
    this.activateEditor(focus);
    return () => {
      this.inlineSourceHost = null;
      if (this.destroyed) return;
      this.editorHost.classList.remove("is-inline-rich-source");
      this.dom.insertBefore(this.editorHost, this.loadError);
      this.editorHost.hidden = !this.richSourceOpen;
    };
  };

  private readonly retryEditor = () => {
    if (this.destroyed) return;
    if (this.inlineSourceHost) {
      this.activateEditor(false);
    } else if (this.isRichFence()) {
      if (!this.view.editable || !this.selected) return;
      this.richSourceOpen = true;
      this.render(true);
    } else {
      this.activateEditor(this.view.editable);
    }
  };

  private ensureEditor(): ScientNestedCodeEditor | null {
    if (this.nestedEditor) return this.nestedEditor;
    this.editorHost.replaceChildren();
    try {
      const editor = createScientNestedCodeEditor({
        parent: this.editorHost,
        code: this.node.textContent,
        editable: this.view.editable,
        language: codeLanguage(this.node),
        onEscape: () => leaveAtomEditor(this.view, this.getPos, this.node),
        onUserCodeChange: (code) => this.replaceCode(code),
      });
      let unregister: (() => void) | undefined;
      try {
        unregister = this.registerCodeEditor?.(editor);
      } catch (error) {
        editor.destroy();
        throw error;
      }
      this.nestedEditor = editor;
      this.unregisterCodeEditor = unregister;
      return editor;
    } catch {
      this.editorHost.replaceChildren();
      return null;
    }
  }

  private activateEditor(focus: boolean): void {
    if (this.destroyed) return;
    if (this.isRichFence() && !this.inlineSourceHost && (!this.selected || !this.richSourceOpen))
      return;
    const editor = this.ensureEditor();
    if (!editor) {
      this.editorHost.hidden = !this.inlineSourceHost;
      if (this.inlineSourceHost) {
        this.editorHost.classList.add("is-source-fallback");
        this.editorHost.textContent = this.node.textContent;
      }
      this.rendered.hidden = false;
      this.loadError.hidden = false;
      return;
    }
    editor.replaceExternalCode(this.node.textContent, codeLanguage(this.node));
    this.editorHost.classList.remove("is-source-fallback");
    this.loadError.hidden = true;
    this.rendered.hidden = !this.isRichFence();
    this.editorHost.hidden = false;
    if (focus && this.view.editable) editor.focus();
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

  private render(focusEditor = false): void {
    const language = codeLanguage(this.node);
    const code = this.node.textContent;
    const richKind = resolveScientRichFenceKind(language);
    const metadata = fenceMetadata(this.node);
    this.languageLabel.textContent = language === "text" ? "Plain text" : language;
    this.dom.classList.toggle(
      "is-empty",
      code.length === 0 && language === "text" && richKind === null,
    );
    this.nestedEditor?.replaceExternalCode(code, language);
    if (richKind) {
      this.dom.setAttribute("data-scient-markdown-rich-fence", richKind);
      this.rendered.hidden = false;
      if (this.inlineSourceHost || (richKind !== "mermaid" && this.richSourceOpen)) {
        this.activateEditor(focusEditor);
      } else {
        this.editorHost.hidden = true;
        this.focusSourceOnMount = focusEditor;
      }
      this.reactRoot ??= createRoot(this.rendered);
      const theme = this.resolveTheme();
      this.reactRoot.render(
        createElement(ScientEditableRichFence, {
          authoringActions: this.view.editable ? this.authoringActions : undefined,
          sourceEditor:
            richKind === "mermaid"
              ? {
                  open: this.richSourceOpen,
                  mount: this.mountSourceEditor,
                }
              : undefined,
          kind: richKind,
          language,
          source: code,
          theme,
          title: null,
          ...(metadata ? { fenceMeta: metadata } : {}),
        }),
      );
      return;
    }

    this.dom.removeAttribute("data-scient-markdown-rich-fence");
    this.richSourceOpen = false;
    if (this.reactRoot) {
      this.reactRoot.unmount();
      this.reactRoot = null;
    }
    this.rendered.textContent = code;
    const editor = this.ensureEditor();
    if (editor) {
      editor.replaceExternalCode(code, language);
      this.rendered.hidden = true;
      this.editorHost.hidden = false;
      this.loadError.hidden = true;
    } else {
      this.rendered.hidden = false;
      this.editorHost.hidden = true;
      this.loadError.hidden = false;
    }
  }
}

export function createScientCodeBlockNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  resolveTheme?: ScientMarkdownThemeResolver,
  registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
  showRichFenceContextMenu?: ScientRichFenceContextMenuHandler,
  registerCodeEditor?: ScientMarkdownCodeEditorRegistrar,
): NodeView {
  return new ScientCodeBlockNodeView(
    node,
    view,
    getPos,
    resolveTheme,
    registerExternalPresentation,
    showRichFenceContextMenu,
    registerCodeEditor,
  );
}
