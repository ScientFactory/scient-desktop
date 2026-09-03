import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import type {
  ScientRichFenceAuthoringActions,
  ScientRichFenceContextMenuHandler,
} from "~/scient/presentation/RichFenceSourceActions";
import { resolveScientRichFenceKind } from "~/scient/presentation/ScientRichFence";

import { leaveAtomEditor } from "../prosemirror/safeSelection";
import type { ScientNestedCodeEditor } from "./codeMirrorCodeEditor";
import type {
  ScientMarkdownExternalPresentationRegistrar,
  ScientMarkdownTheme,
  ScientMarkdownThemeResolver,
} from "./externalPresentation";
import { ScientEditableRichFence } from "./ScientEditableRichFence";

type ScientCodeEditorModule = typeof import("./codeMirrorCodeEditor");

let codeEditorModulePromise: Promise<ScientCodeEditorModule> | null = null;

function loadCodeEditorModule(): Promise<ScientCodeEditorModule> {
  codeEditorModulePromise ??= import("./codeMirrorCodeEditor").catch((error: unknown) => {
    codeEditorModulePromise = null;
    throw error;
  });
  return codeEditorModulePromise;
}

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
  private nestedEditor: ScientNestedCodeEditor | null = null;
  private reactRoot: Root | null = null;
  private node: ProseMirrorNode;
  private destroyed = false;
  private highlightVersion = 0;
  private selected = false;
  private pendingPointerCoordinates: { x: number; y: number } | null = null;
  private readonly authoringActions: ScientRichFenceAuthoringActions;
  private readonly unregisterExternalPresentation: (() => void) | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly resolveTheme: ScientMarkdownThemeResolver = documentTheme,
    registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
    showRichFenceContextMenu?: ScientRichFenceContextMenuHandler,
  ) {
    this.node = node;
    this.authoringActions = {
      onEditSource: this.requestSourceEdit,
      ...(showRichFenceContextMenu ? { showContextMenu: showRichFenceContextMenu } : {}),
    };
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
    this.loadError.className = "scient-markdown-code-load-error";
    this.loadError.hidden = true;
    this.loadError.setAttribute("role", "status");
    this.loadError.append("Code editor could not open. Markdown source is still available.");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.setAttribute("aria-label", "Retry code editor");
    retry.addEventListener("click", () => void this.activateEditor());
    this.loadError.append(retry);
    this.dom.append(this.loadError);
    // Ordinary code keeps direct block activation. Rich cards own every event
    // inside their rendered surface and expose source editing explicitly.
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.dom.addEventListener("pointerenter", this.handlePointerEnter);
    this.unregisterExternalPresentation = registerExternalPresentation?.((change) => {
      if (change === "appearance") this.render();
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
    this.selected = true;
    this.dom.classList.add("is-selected");
    if (!this.isRichFence()) {
      // Invalidate an in-flight syntax render before the surface swaps to
      // CodeMirror, which owns highlighting for the active editor.
      this.highlightVersion += 1;
      void this.activateEditor();
    }
  }

  deselectNode(): void {
    this.selected = false;
    this.pendingPointerCoordinates = null;
    this.dom.classList.remove("is-selected");
    this.rendered.hidden = false;
    this.editorHost.hidden = true;
    this.loadError.hidden = true;
    if (!this.isRichFence()) this.render();
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
    this.highlightVersion += 1;
    this.nestedEditor?.destroy();
    this.nestedEditor = null;
    this.reactRoot?.unmount();
    this.reactRoot = null;
    this.unregisterExternalPresentation?.();
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.dom.removeEventListener("pointerenter", this.handlePointerEnter);
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
    if (this.editorHost.contains(event.target) || this.isRichFenceRenderedTarget(event.target)) {
      return;
    }
    if (event.target.closest("button, a, input, select, textarea, [role='button']")) return;
    if (!this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    event.preventDefault();
    if (this.isRichFence()) {
      // A rich card only becomes the selection; its source editor opens below
      // the card through the explicit action, never from a bare click.
      if (!this.selected) this.selectSelf(position);
      return;
    }
    // Only a click on the rendered code carries a caret target. Header clicks
    // open (or refocus) the editor without moving its caret.
    this.pendingPointerCoordinates = this.rendered.contains(event.target)
      ? { x: event.clientX, y: event.clientY }
      : null;
    if (this.selected) {
      // Already the node selection (for example after a failed editor load), so
      // the view will not call selectNode again; activate from the click itself.
      void this.activateEditor();
      return;
    }
    this.selectSelf(position);
    // The view runs selectNode synchronously inside dispatch. If it did not, the
    // click opened nothing and must not steer a later activation.
    if (!this.selected) this.pendingPointerCoordinates = null;
  };

  private selectSelf(position: number): void {
    this.view.dispatch(
      this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)),
    );
  }

  private readonly handlePointerEnter = () => {
    if (!this.view.editable || this.isRichFence()) return;
    // Warm the shared editor module before the first click without creating a
    // CodeMirror instance for every code block in a long document.
    void loadCodeEditorModule().catch(() => undefined);
  };

  private readonly requestSourceEdit = () => {
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
    void this.activateEditor();
  };

  private async activateEditor(): Promise<void> {
    if (this.destroyed || !this.selected || !this.view.editable) return;
    this.loadError.hidden = true;
    if (!this.nestedEditor) {
      try {
        const { createScientNestedCodeEditor } = await loadCodeEditorModule();
        if (this.destroyed || !this.selected || !this.view.editable) return;
        // Concurrent selections can share the same pending module import. Only
        // one continuation may create the nested editor; never focus after exit.
        this.editorHost.hidden = false;
        this.nestedEditor ??= createScientNestedCodeEditor({
          parent: this.editorHost,
          code: this.node.textContent,
          language: codeLanguage(this.node),
          onEscape: () => leaveAtomEditor(this.view, this.getPos, this.node),
          onUserCodeChange: (code) => this.replaceCode(code),
        });
      } catch {
        if (this.destroyed || !this.selected || !this.view.editable || this.nestedEditor) return;
        this.pendingPointerCoordinates = null;
        this.editorHost.replaceChildren();
        this.editorHost.hidden = true;
        this.rendered.hidden = false;
        this.loadError.hidden = false;
        return;
      }
    }
    this.loadError.hidden = true;
    // Keep the rendered code (and its height) until the lazy editor is ready.
    // Rich fences stay visible alongside their editable source.
    this.rendered.hidden = !this.dom.hasAttribute("data-scient-markdown-rich-fence");
    this.editorHost.hidden = false;
    const pointerCoordinates = this.pendingPointerCoordinates;
    this.pendingPointerCoordinates = null;
    if (pointerCoordinates) {
      this.nestedEditor.focusAt(pointerCoordinates);
    } else {
      this.nestedEditor.focus();
    }
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
      const theme = this.resolveTheme();
      this.reactRoot.render(
        createElement(ScientEditableRichFence, {
          authoringActions: this.authoringActions,
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
    if (this.selected) return;
    const theme = this.resolveTheme();
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
  resolveTheme?: ScientMarkdownThemeResolver,
  registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
  showRichFenceContextMenu?: ScientRichFenceContextMenuHandler,
): NodeView {
  return new ScientCodeBlockNodeView(
    node,
    view,
    getPos,
    resolveTheme,
    registerExternalPresentation,
    showRichFenceContextMenu,
  );
}
