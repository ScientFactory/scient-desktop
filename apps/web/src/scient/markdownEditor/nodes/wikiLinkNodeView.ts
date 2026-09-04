import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

import type { ScientMarkdownLinkOpenHandler } from "../linkOpen";
import type { ScientMarkdownExternalPresentationRegistrar } from "./externalPresentation";

const wikiLinkDoubleClickDelayMs = 220;

class ScientWikiLinkNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly label = document.createElement("span");
  private node: ProseMirrorNode;
  private pendingOpen: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pointerOrigin: { readonly x: number; readonly y: number } | null = null;
  private pointerDragged = false;
  private readonly unregisterEditability: (() => void) | undefined;
  private readonly unregisterExternalPresentation: (() => void) | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly onOpen: ScientMarkdownLinkOpenHandler | undefined,
    private readonly targetExists: ((target: string) => boolean | null) | undefined,
    getPos: () => number | undefined,
    registerWikiLink:
      | ((link: HTMLElement, getPos: () => number | undefined) => () => void)
      | undefined,
    registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
  ) {
    this.node = node;
    this.dom.className = "scient-markdown-wiki-link";
    this.dom.contentEditable = "false";
    this.dom.tabIndex = view.editable ? -1 : 0;
    this.dom.setAttribute("role", "link");
    this.dom.setAttribute("data-scient-markdown-wiki-link", "true");
    this.label.className = "scient-markdown-wiki-link-label";
    this.dom.append(this.label);
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.dom.addEventListener("click", this.handleClick);
    this.dom.addEventListener("contextmenu", this.handleContextMenu);
    this.dom.addEventListener("keydown", this.handleLinkKeyDown);
    this.unregisterEditability = registerWikiLink?.(this.dom, getPos);
    this.unregisterExternalPresentation = registerExternalPresentation?.((change) => {
      if (change === "workspace") this.render();
    });
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.cancelPendingOpen();
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.dom.removeEventListener("click", this.handleClick);
    this.dom.removeEventListener("contextmenu", this.handleContextMenu);
    this.dom.removeEventListener("keydown", this.handleLinkKeyDown);
    this.unregisterEditability?.();
    this.unregisterExternalPresentation?.();
    this.stopTrackingPointer();
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    this.pointerOrigin = { x: event.clientX, y: event.clientY };
    this.pointerDragged = false;
    this.dom.ownerDocument.addEventListener("mousemove", this.handlePointerMove);
    this.dom.ownerDocument.addEventListener("mouseup", this.handlePointerUp, { once: true });
  };

  private readonly handleClick = (event: MouseEvent) => {
    if (event.button !== 0 || !this.onOpen) return;
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

  private readonly handleContextMenu = () => {
    // A menu action must not race a delayed single-click navigation.
    this.cancelPendingOpen();
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
    if (event.key !== "Enter" || !this.onOpen) return;
    event.preventDefault();
    this.openTarget();
  };

  private openTarget(): void {
    this.onOpen?.(String(this.node.attrs.target), this.dom);
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

  private render(): void {
    this.dom.tabIndex = this.view.editable ? -1 : 0;
    const target = String(this.node.attrs.target);
    this.label.textContent = String(this.node.attrs.label ?? target);
    this.dom.setAttribute("data-target", target);
    const exists = this.targetExists?.(target) ?? null;
    this.dom.classList.toggle("is-missing", exists === false);
    this.dom.setAttribute(
      "data-scient-markdown-wiki-target-state",
      exists === null ? "unknown" : exists ? "present" : "missing",
    );
    this.dom.setAttribute(
      "aria-label",
      exists === false ? `Open missing wiki link ${target}` : `Open wiki link ${target}`,
    );
    if (exists === false) this.dom.setAttribute("aria-invalid", "true");
    else this.dom.removeAttribute("aria-invalid");
    this.dom.title = exists === false ? `Missing Markdown target: ${target}` : target;
  }
}

export function createScientWikiLinkNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  onOpen?: ScientMarkdownLinkOpenHandler,
  targetExists?: (target: string) => boolean | null,
  registerWikiLink?: (link: HTMLElement, getPos: () => number | undefined) => () => void,
  registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
): NodeView {
  return new ScientWikiLinkNodeView(
    node,
    view,
    onOpen,
    targetExists,
    getPos,
    registerWikiLink,
    registerExternalPresentation,
  );
}
