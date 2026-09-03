import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";

import { leaveAtomEditor } from "../prosemirror/safeSelection";
import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditor,
  type ScientNestedCodeEditorRegistrar,
} from "./codeMirrorCodeEditor";

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
      return kind.trim().length > 0 ? `${kind} source` : "Raw source";
  }
}

class ScientRawBlockNodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly kind = document.createElement("span");
  private sourceEditor: HTMLTextAreaElement | null = null;
  private codeEditorHost: HTMLDivElement | null = null;
  private nestedEditor: ScientNestedCodeEditor | null = null;
  private unregisterEditor: (() => void) | undefined;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
    private readonly registerCodeEditor?: ScientNestedCodeEditorRegistrar,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-source-island";
    this.dom.contentEditable = "false";
    this.dom.dir = "ltr";
    this.dom.setAttribute("data-scient-markdown-source-island", "true");
    this.kind.className = "scient-markdown-source-island-kind";
    this.dom.append(this.kind);
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.mountEditor();
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || node.attrs.sourceKind !== this.node.attrs.sourceKind) {
      return false;
    }
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
    return (
      event.target === this.sourceEditor ||
      (event.target instanceof globalThis.Node && this.codeEditorHost?.contains(event.target)) ===
        true
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.unregisterEditor?.();
    this.unregisterEditor = undefined;
    this.nestedEditor?.destroy();
    this.nestedEditor = null;
    this.codeEditorHost?.removeEventListener("focus", this.handleCodeEditorHostFocus);
    this.removeTextareaListeners();
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      !this.view.editable ||
      !(event.target instanceof globalThis.Node) ||
      (event.target !== this.sourceEditor && !this.codeEditorHost?.contains(event.target))
    ) {
      return;
    }
    const position = this.getPos();
    if (position === undefined) return;
    const selection = this.view.state.selection;
    if (selection instanceof NodeSelection && selection.from === position) return;
    // Select the atom before the nested editor places its caret. Keeping the
    // default mouse action gives direct, one-click editing in this surface.
    this.view.dispatch(
      this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)),
    );
  };

  private readonly handleInput = (event: Event) => {
    const sourceEditor = this.sourceEditor;
    if (
      !sourceEditor ||
      sourceEditor.readOnly ||
      !this.view.editable ||
      (event instanceof InputEvent && event.isComposing)
    ) {
      return;
    }
    const position = this.getPos();
    if (position === undefined) return;
    const currentNode = this.view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode.type !== this.node.type ||
      sourceEditor.value === String(currentNode.attrs.source)
    ) {
      return;
    }
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...currentNode.attrs,
        source: sourceEditor.value,
      }),
    );
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    event.preventDefault();
    leaveAtomEditor(this.view, this.getPos, this.node);
  };

  private mountEditor(): void {
    const kind = String(this.node.attrs.sourceKind);
    if (kind === "definition") {
      this.mountTextarea();
      return;
    }

    const host = document.createElement("div");
    host.className = "scient-markdown-code-editor scient-markdown-source-island-code-editor";
    host.dataset.scientMarkdownAtomEditor = "true";
    host.tabIndex = -1;
    host.addEventListener("focus", this.handleCodeEditorHostFocus);
    this.dom.append(host);
    this.codeEditorHost = host;
    try {
      const editor = createScientNestedCodeEditor({
        ariaLabel: sourceKindLabel(kind),
        parent: host,
        code: String(this.node.attrs.source),
        editable: this.view.editable,
        language: kind,
        onEscape: () => leaveAtomEditor(this.view, this.getPos, this.node),
        onUserCodeChange: (source) => this.replaceSource(source),
      });
      let unregister: (() => void) | undefined;
      try {
        unregister = this.registerCodeEditor?.(editor);
      } catch (error) {
        editor.destroy();
        throw error;
      }
      this.nestedEditor = editor;
      this.unregisterEditor = unregister;
    } catch {
      host.removeEventListener("focus", this.handleCodeEditorHostFocus);
      host.remove();
      this.codeEditorHost = null;
      this.mountTextarea();
    }
  }

  private mountTextarea(): void {
    const sourceEditor = document.createElement("textarea");
    sourceEditor.className = "scient-markdown-source-island-editor";
    sourceEditor.dir = "ltr";
    sourceEditor.rows = this.node.attrs.sourceKind === "definition" ? 1 : 3;
    sourceEditor.spellcheck = false;
    sourceEditor.tabIndex = this.node.attrs.sourceKind === "definition" ? 0 : -1;
    sourceEditor.dataset.scientMarkdownAtomEditor = "true";
    sourceEditor.readOnly = !this.view.editable;
    sourceEditor.addEventListener("input", this.handleInput);
    sourceEditor.addEventListener("compositionend", this.handleInput);
    sourceEditor.addEventListener("keydown", this.handleKeyDown);
    this.dom.append(sourceEditor);
    this.sourceEditor = sourceEditor;
    this.unregisterEditor = this.registerSourceEditor?.(sourceEditor);
  }

  private removeTextareaListeners(): void {
    this.sourceEditor?.removeEventListener("input", this.handleInput);
    this.sourceEditor?.removeEventListener("compositionend", this.handleInput);
    this.sourceEditor?.removeEventListener("keydown", this.handleKeyDown);
  }

  private readonly handleCodeEditorHostFocus = () => {
    if (this.view.editable) this.nestedEditor?.focus();
  };

  private replaceSource(source: string): void {
    if (!this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const currentNode = this.view.state.doc.nodeAt(position);
    if (
      !currentNode ||
      currentNode.type !== this.node.type ||
      source === currentNode.attrs.source
    ) {
      return;
    }
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...currentNode.attrs,
        source,
      }),
    );
  }

  private render(): void {
    const source = String(this.node.attrs.source);
    const kind = String(this.node.attrs.sourceKind);
    const label = sourceKindLabel(kind);
    const definition = kind === "definition";
    this.kind.textContent = definition ? "Reference" : label;
    this.dom.setAttribute("data-scient-markdown-source-kind", kind);
    if (this.sourceEditor) {
      this.sourceEditor.setAttribute("aria-label", label);
      this.sourceEditor.rows = definition ? 1 : 3;
      this.sourceEditor.tabIndex = definition ? 0 : -1;
      if (this.sourceEditor !== document.activeElement) this.sourceEditor.value = source;
    }
    this.nestedEditor?.replaceExternalCode(source, kind);
  }
}

export function createScientRawBlockNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  registerSourceEditor?: ScientMarkdownRawSourceEditorRegistrar,
  registerCodeEditor?: ScientNestedCodeEditorRegistrar,
): NodeView {
  return new ScientRawBlockNodeView(node, view, getPos, registerSourceEditor, registerCodeEditor);
}
