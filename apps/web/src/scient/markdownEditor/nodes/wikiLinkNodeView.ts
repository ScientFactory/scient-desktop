import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

import { leaveAtomEditor } from "../prosemirror/safeSelection";

let nextWikiListId = 1;
const wikiLinkDoubleClickDelayMs = 220;

class ScientWikiLinkNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly label = document.createElement("span");
  private readonly sourceEditor = document.createElement("input");
  private readonly suggestions = document.createElement("datalist");
  private node: ProseMirrorNode;
  private pendingOpen: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pointerOrigin: { readonly x: number; readonly y: number } | null = null;
  private pointerDragged = false;
  private readonly unregisterEditability: (() => void) | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly onOpen: ((target: string) => void) | undefined,
    private readonly getSuggestions: (() => ReadonlyArray<string>) | undefined,
    private readonly targetExists: ((target: string) => boolean | null) | undefined,
    registerWikiLink: ((link: HTMLElement) => () => void) | undefined,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-wiki-link";
    this.dom.contentEditable = "false";
    this.dom.tabIndex = view.editable ? -1 : 0;
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
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.dom.addEventListener("click", this.handleClick);
    this.dom.addEventListener("keydown", this.handleLinkKeyDown);
    this.dom.append(this.sourceEditor, this.suggestions);
    this.unregisterEditability = registerWikiLink?.(this.dom);
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
    globalThis.queueMicrotask(() => {
      if (this.sourceEditor.hidden || !this.dom.isConnected) return;
      this.sourceEditor.focus();
      this.sourceEditor.select();
    });
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
    this.cancelPendingOpen();
    this.sourceEditor.removeEventListener("input", this.handleInput);
    this.sourceEditor.removeEventListener("keydown", this.handleKeyDown);
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.dom.removeEventListener("click", this.handleClick);
    this.dom.removeEventListener("keydown", this.handleLinkKeyDown);
    this.unregisterEditability?.();
    this.stopTrackingPointer();
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

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (event.target === this.sourceEditor || event.button !== 0) return;
    this.pointerOrigin = { x: event.clientX, y: event.clientY };
    this.pointerDragged = false;
    this.dom.ownerDocument.addEventListener("mousemove", this.handlePointerMove);
    this.dom.ownerDocument.addEventListener("mouseup", this.handlePointerUp, { once: true });
  };

  private readonly handleClick = (event: MouseEvent) => {
    if (event.target === this.sourceEditor || event.button !== 0 || !this.onOpen) return;
    if (this.pointerDragged) {
      this.pointerDragged = false;
      this.cancelPendingOpen();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!this.view.editable || event.metaKey || event.ctrlKey) {
      this.cancelPendingOpen();
      this.openTarget();
      return;
    }
    if (event.detail > 1) {
      this.cancelPendingOpen();
      return;
    }
    this.cancelPendingOpen();
    this.pendingOpen = globalThis.setTimeout(() => {
      this.pendingOpen = null;
      this.openTarget();
    }, wikiLinkDoubleClickDelayMs);
  };

  private readonly handlePointerMove = (event: MouseEvent) => {
    if (
      this.pointerOrigin &&
      (Math.abs(event.clientX - this.pointerOrigin.x) > 4 ||
        Math.abs(event.clientY - this.pointerOrigin.y) > 4)
    ) {
      this.pointerDragged = true;
    }
  };

  private readonly handlePointerUp = () => {
    this.stopTrackingPointer();
  };

  private readonly handleLinkKeyDown = (event: KeyboardEvent) => {
    if (event.target === this.sourceEditor) return;
    if (event.key === "Escape" && !this.sourceEditor.hidden) {
      this.closeEditor(event);
      return;
    }
    if (event.key !== "Enter" || !this.onOpen) return;
    event.preventDefault();
    this.openTarget();
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    this.closeEditor(event);
  };

  private closeEditor(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    leaveAtomEditor(this.view, this.getPos, this.node);
  }

  private sourceValue(): string {
    const target = String(this.node.attrs.target);
    return typeof this.node.attrs.label === "string"
      ? `${target}|${this.node.attrs.label}`
      : target;
  }

  private openTarget(): void {
    this.onOpen?.(String(this.node.attrs.target));
  }

  private cancelPendingOpen(): void {
    if (this.pendingOpen === null) return;
    globalThis.clearTimeout(this.pendingOpen);
    this.pendingOpen = null;
  }

  private stopTrackingPointer(): void {
    this.pointerOrigin = null;
    this.dom.ownerDocument.removeEventListener("mousemove", this.handlePointerMove);
    this.dom.ownerDocument.removeEventListener("mouseup", this.handlePointerUp);
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
    this.dom.tabIndex = this.view.editable ? -1 : 0;
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
  registerWikiLink?: (link: HTMLElement) => () => void,
): NodeView {
  return new ScientWikiLinkNodeView(
    node,
    view,
    getPos,
    onOpen,
    getSuggestions,
    targetExists,
    registerWikiLink,
  );
}
