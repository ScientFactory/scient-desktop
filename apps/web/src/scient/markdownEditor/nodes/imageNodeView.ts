import { closeHistory } from "prosemirror-history";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SCIENT_IMAGE_CAPTION_CLASS_NAME,
  ScientImageControls,
  type ScientImageAction,
  type ScientImageContextMenuHandler,
} from "~/scient/images/ScientImageControls";

import { retainedReferenceLabel } from "../prosemirror/referenceLinks";
import {
  canCaptionImage,
  isolateImage,
  standaloneImagePosition,
} from "../prosemirror/imageFigures";
import { leaveAtomEditor } from "../prosemirror/safeSelection";
import type { ScientMarkdownExternalPresentationRegistrar } from "./externalPresentation";
import {
  ScientImageDetails,
  type ScientImageDetailsSession,
  type ScientImageDetailsValue,
} from "./ScientImageDetails";

export type ScientMarkdownImageSourceResolver = (
  source: string,
) => string | null | Promise<string | null>;

export interface ScientMarkdownImageNodeViewRegistration {
  readonly element: HTMLElement;
  readonly getPos: () => number | undefined;
  readonly setEditable: (editable: boolean) => void;
  readonly editDetails: () => void;
  readonly refreshContext: () => void;
  readonly invalidateEditing: () => void;
  readonly showContextMenu: (event: MouseEvent) => boolean;
}

export interface ScientMarkdownImageNodeViewOptions {
  readonly registerImage?: (registration: ScientMarkdownImageNodeViewRegistration) => () => void;
  readonly uploadImage?: (
    file: File,
  ) => Promise<{ readonly src: string; readonly alt: string; readonly title?: string | null }>;
  readonly resolveImageActions?: (source: string) => readonly ScientImageAction[];
  readonly showImageContextMenu?: ScientImageContextMenuHandler;
  readonly editImageReference?: (label: string, anchor: HTMLElement) => void;
  readonly onOpenImageLink?: (target: string, anchor: HTMLElement) => void;
  readonly onImageError?: (error: unknown) => void;
}

type LoadState = "resolving" | "loading" | "loaded" | "failed";
interface ImageTarget {
  readonly node: ProseMirrorNode;
  readonly generation: number;
}

/** Images stay inline schema nodes; only an isolated, unlinked paragraph image is a figure. */
export function isStandaloneMarkdownImage(
  view: EditorView,
  position: number | undefined,
  node: ProseMirrorNode,
): boolean {
  return (
    position !== undefined &&
    view.state.doc.nodeAt(position) === node &&
    standaloneImagePosition(view.state.doc.resolve(position)) === position
  );
}

function imageDisplayName(source: string): string {
  if (source.startsWith("data:")) return "Embedded image";
  if (source.startsWith("blob:")) return "Image";
  const name = source.split(/[?#]/u)[0]?.split(/[\\/]/u).at(-1) || "Image";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

class ScientImageNodeView implements NodeView {
  readonly dom = document.createElement("span");
  private readonly image = document.createElement("img");
  private readonly caption = document.createElement("textarea");
  private readonly placeholder = document.createElement("span");
  private readonly chrome = document.createElement("span");
  private readonly fileInput = document.createElement("input");
  private readonly root: Root;
  private readonly captionSizeObserver: ResizeObserver | null;
  private captionWidth = -1;
  private node: ProseMirrorNode;
  private selected = false;
  private standalone = false;
  private editable: boolean;
  private captionActive = false;
  private captionTarget: ProseMirrorNode | null = null;
  private composing = false;
  private applying = false;
  private details: (ScientImageDetailsSession & { readonly target: ImageTarget }) | null = null;
  private nextDetails = 0;
  private pendingReplacement: ImageTarget | null = null;
  private replacing = false;
  private replacementOperation = 0;
  private generation = 0;
  private resolveVersion = 0;
  private requestedSource: string | null = null;
  private resolvedSource: string | null = null;
  private loadState: LoadState = "resolving";
  private destroyed = false;
  private readonly unregisterExternalPresentation: (() => void) | undefined;
  private readonly unregisterImage: (() => void) | undefined;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly resolveSource: ScientMarkdownImageSourceResolver | undefined,
    registerExternalPresentation: ScientMarkdownExternalPresentationRegistrar | undefined,
    private readonly options: ScientMarkdownImageNodeViewOptions,
  ) {
    this.node = node;
    this.editable = view.editable;
    this.dom.className = "scient-markdown-image";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-image", "true");
    this.dom.setAttribute("data-scient-visual-card", "true");
    this.image.className = "scient-markdown-image-render";
    this.image.addEventListener("load", this.handleLoad);
    this.image.addEventListener("error", this.handleLoadError);
    this.caption.className = `scient-markdown-image-caption ${SCIENT_IMAGE_CAPTION_CLASS_NAME}`;
    this.caption.rows = 1;
    this.caption.dir = "auto";
    this.caption.dataset.keybindingCapture = "";
    this.caption.setAttribute("aria-label", "Image caption");
    this.caption.placeholder = "Add a caption…";
    this.caption.addEventListener("mousedown", this.handleCaptionPointer);
    this.caption.addEventListener("focus", this.handleCaptionFocus);
    this.caption.addEventListener("blur", this.handleCaptionBlur);
    this.caption.addEventListener("input", this.handleCaptionInput);
    this.caption.addEventListener("compositionstart", this.handleCompositionStart);
    this.caption.addEventListener("compositionend", this.handleCompositionEnd);
    this.caption.addEventListener("keydown", this.handleCaptionKeyDown);
    this.placeholder.className = "scient-markdown-image-placeholder";
    this.placeholder.setAttribute("role", "status");
    this.chrome.className = "scient-markdown-image-chrome";
    this.chrome.dataset.keybindingCapture = "";
    this.fileInput.type = "file";
    this.fileInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/avif";
    this.fileInput.hidden = true;
    this.fileInput.setAttribute("aria-label", "Replace Markdown image");
    this.fileInput.addEventListener("change", this.handleReplacementFile);
    this.fileInput.addEventListener("cancel", this.handleReplacementCancel);
    this.dom.append(this.image, this.placeholder, this.caption, this.chrome, this.fileInput);
    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.dom.addEventListener("scient-edit-image-caption", this.editCaption);
    this.root = createRoot(this.chrome);
    this.captionSizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || width === this.captionWidth) return;
            this.captionWidth = width;
            this.fitCaption();
          });
    this.captionSizeObserver?.observe(this.dom);
    this.unregisterExternalPresentation = registerExternalPresentation?.((change) => {
      if (change === "workspace" && this.loadState === "failed") this.retry();
      else this.renderChrome();
    });
    this.unregisterImage = options.registerImage?.({
      element: this.dom,
      getPos,
      setEditable: this.setEditable,
      editDetails: this.editDetails,
      refreshContext: this.refreshContext,
      invalidateEditing: this.invalidateEditing,
      showContextMenu: this.showContextMenu,
    });
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node === this.node) return true;
    // An upload owns the image version it started from, including its alt/title.
    this.replacementOperation += 1;
    this.replacing = false;
    if (node !== this.node && !this.applying) {
      this.generation += 1;
      this.details = null;
      this.captionActive = false;
      this.captionTarget = null;
      this.composing = false;
    }
    this.node = node;
    if (this.applying && this.captionActive) this.captionTarget = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add("is-selected");
    this.renderChrome();
  }
  deselectNode(): void {
    this.selected = false;
    this.dom.classList.remove("is-selected");
    this.renderChrome();
  }
  stopEvent(event: Event): boolean {
    if (!(event.target instanceof globalThis.Node)) return false;
    if (
      this.chrome.contains(event.target) ||
      event.target === this.caption ||
      event.target === this.fileInput
    )
      return true;
    return event.type === "contextmenu" && this.dom.contains(event.target);
  }
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.resolveVersion += 1;
    this.unregisterExternalPresentation?.();
    this.unregisterImage?.();
    this.captionSizeObserver?.disconnect();
    this.root.unmount();
    this.dom.removeEventListener("mousedown", this.handleMouseDown);
    this.dom.removeEventListener("scient-edit-image-caption", this.editCaption);
    this.image.removeEventListener("load", this.handleLoad);
    this.image.removeEventListener("error", this.handleLoadError);
    this.caption.removeEventListener("mousedown", this.handleCaptionPointer);
    this.caption.removeEventListener("focus", this.handleCaptionFocus);
    this.caption.removeEventListener("blur", this.handleCaptionBlur);
    this.caption.removeEventListener("input", this.handleCaptionInput);
    this.caption.removeEventListener("compositionstart", this.handleCompositionStart);
    this.caption.removeEventListener("compositionend", this.handleCompositionEnd);
    this.caption.removeEventListener("keydown", this.handleCaptionKeyDown);
    this.fileInput.removeEventListener("change", this.handleReplacementFile);
    this.fileInput.removeEventListener("cancel", this.handleReplacementCancel);
  }

  private readonly setEditable = (editable: boolean) => {
    if (this.editable === editable) return;
    this.editable = editable;
    if (!editable) this.invalidateEditing();
    this.render();
  };
  private readonly invalidateEditing = () => {
    this.generation += 1;
    this.replacementOperation += 1;
    this.replacing = false;
    this.details = null;
    this.captionActive = false;
    this.captionTarget = null;
    this.composing = false;
    this.renderCaption();
    this.renderChrome();
  };
  private readonly refreshContext = () => {
    if (this.destroyed) return;
    const position = this.getPos();
    const current = position === undefined ? null : this.view.state.doc.nodeAt(position);
    if (current && current !== this.node) {
      this.update(current);
      return;
    }
    if (this.standalone !== isStandaloneMarkdownImage(this.view, position, this.node))
      this.render();
  };
  private readonly showContextMenu = (event: MouseEvent): boolean => {
    if (this.destroyed) return false;
    event.preventDefault();
    event.stopPropagation();
    this.dom.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: false,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
      }),
    );
    return true;
  };
  private currentTarget(): ImageTarget {
    return { node: this.node, generation: this.generation };
  }
  private targetPosition(target: ImageTarget): number | null {
    if (
      this.destroyed ||
      !this.editable ||
      !this.view.editable ||
      target.generation !== this.generation
    )
      return null;
    const position = this.getPos();
    return position !== undefined && this.view.state.doc.nodeAt(position) === target.node
      ? position
      : null;
  }
  private patch(
    target: ImageTarget,
    attrs: Readonly<Record<string, unknown>>,
    separateHistory = false,
  ): boolean {
    const position = this.targetPosition(target);
    if (position === null) return false;
    let transaction = this.view.state.tr;
    for (const [name, value] of Object.entries(attrs)) {
      if (target.node.attrs[name] !== value)
        transaction = transaction.setNodeAttribute(position, name, value);
    }
    if (!transaction.docChanged) return true;
    if (separateHistory) transaction = closeHistory(transaction);
    this.applying = true;
    try {
      this.view.dispatch(transaction);
    } finally {
      this.applying = false;
    }
    return true;
  }
  private referenceLabel(): string | null {
    return retainedReferenceLabel(this.node.attrs, "src");
  }

  private selectImage(): boolean {
    const position = this.targetPosition(this.currentTarget());
    if (position === null) return false;
    const selection = NodeSelection.create(this.view.state.doc, position);
    if (!this.view.state.selection.eq(selection))
      this.view.dispatch(this.view.state.tr.setSelection(selection).setMeta("addToHistory", false));
    return true;
  }

  private readonly handleMouseDown = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      !this.editable ||
      !this.view.editable ||
      !(event.target instanceof Element)
    )
      return;
    if (event.target.closest("button, input, textarea, a, [role='button']")) return;
    if (this.node.marks.some((mark) => mark.type.name === "link")) return;
    if (!this.selectImage()) return;
    event.preventDefault();
    if (
      this.standalone &&
      this.referenceLabel() === null &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    )
      this.editCaption();
    else this.view.focus();
  };
  private readonly editDetails = () => this.openDetails("details");
  private openDetails(intent: ScientImageDetailsSession["intent"]): void {
    const target = this.currentTarget();
    if (this.targetPosition(target) === null) return;
    this.nextDetails += 1;
    this.details = {
      id: this.nextDetails,
      intent,
      target,
      src: String(this.node.attrs.src),
      alt: String(this.node.attrs.alt ?? ""),
      title: String(this.node.attrs.title ?? ""),
      referenceLabel: this.referenceLabel(),
      standalone: this.standalone,
    };
    this.renderChrome();
  }
  private readonly closeDetails = (returnFocus: boolean) => {
    this.details = null;
    this.renderChrome();
    if (returnFocus && !this.destroyed) leaveAtomEditor(this.view, this.getPos, this.node);
  };
  private readonly applyDetails = (value: ScientImageDetailsValue) => {
    const details = this.details;
    if (!details) return;
    const locallyOwned = details.referenceLabel === null || value.independent;
    const attrs = {
      alt:
        value.alt === String(details.target.node.attrs.alt ?? "")
          ? details.target.node.attrs.alt
          : value.alt,
      ...(locallyOwned
        ? { src: value.src, ...(!details.standalone ? { title: value.title || null } : {}) }
        : {}),
      ...(value.independent
        ? { referenceLabel: null, referenceHref: null, referenceTitle: null }
        : {}),
    };
    this.details = null;
    const applied = this.patch(details.target, attrs, true);
    this.renderChrome();
    if (applied) leaveAtomEditor(this.view, this.getPos, this.node);
  };
  private readonly editReference = () => {
    const details = this.details;
    if (!details || this.targetPosition(details.target) === null || details.referenceLabel === null)
      return;
    this.closeDetails(false);
    this.options.editImageReference?.(details.referenceLabel, this.dom);
  };
  private readonly independentCaption = () => {
    const details = this.details;
    if (!details) return;
    this.details = null;
    if (
      this.patch(
        details.target,
        { referenceLabel: null, referenceHref: null, referenceTitle: null },
        true,
      )
    )
      this.editCaption();
    else this.renderChrome();
  };
  private readonly editCaption = () => {
    const position = this.targetPosition(this.currentTarget());
    if (!this.editable || position === null || !canCaptionImage(this.view.state.doc, position))
      return;
    if (!this.standalone) {
      const tr = closeHistory(this.view.state.tr);
      const isolatedPosition = isolateImage(tr, position);
      tr.setSelection(NodeSelection.create(tr.doc, isolatedPosition));
      this.view.dispatch(tr);
      // Splitting the paragraph can recreate the node view. Focus its current owner.
      this.view.nodeDOM(isolatedPosition)?.dispatchEvent(new Event("scient-edit-image-caption"));
      return;
    }
    if (this.referenceLabel() !== null) {
      this.openDetails("caption");
      return;
    }
    this.captionActive = true;
    this.captionTarget = this.node;
    this.renderCaption();
    if (document.activeElement !== this.caption) {
      this.caption.focus({ preventScroll: true });
      this.caption.setSelectionRange(this.caption.value.length, this.caption.value.length);
    }
  };
  private readonly handleCaptionPointer = (event: MouseEvent) => {
    if (event.button !== 0 || !this.editable) return;
    if (this.referenceLabel() !== null) {
      event.preventDefault();
      this.openDetails("caption");
    }
  };
  private readonly handleCaptionFocus = () => {
    if (!this.editable || !this.view.editable || this.referenceLabel() !== null) return;
    if (!this.selectImage()) return;
    this.captionActive = true;
    this.captionTarget = this.node;
    this.renderCaption();
  };
  private readonly handleCaptionBlur = () => {
    if (this.composing) return;
    this.publishCaption();
    this.captionActive = false;
    this.captionTarget = null;
    this.renderCaption();
  };
  private readonly handleCaptionInput = (event: Event) => {
    if (this.composing || (event instanceof InputEvent && event.isComposing)) return;
    this.publishCaption();
  };
  private readonly handleCompositionStart = () => {
    this.composing = true;
  };
  private readonly handleCompositionEnd = () => {
    this.composing = false;
    this.publishCaption();
    if (document.activeElement !== this.caption) this.handleCaptionBlur();
  };
  private publishCaption(): void {
    if (!this.captionActive || this.captionTarget !== this.node || this.referenceLabel() !== null)
      return;
    this.patch(this.currentTarget(), { title: this.caption.value || null });
    this.fitCaption();
  }
  private readonly handleCaptionKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || this.composing || (event.key !== "Enter" && event.key !== "Escape"))
      return;
    event.preventDefault();
    this.publishCaption();
    this.captionActive = false;
    this.captionTarget = null;
    leaveAtomEditor(this.view, this.getPos, this.node);
    this.renderCaption();
  };

  private readonly replaceImage = () => {
    if (
      !this.options.uploadImage ||
      this.replacing ||
      this.targetPosition(this.currentTarget()) === null
    )
      return;
    if (this.referenceLabel() !== null) {
      this.editDetails();
      return;
    }
    this.pendingReplacement = this.currentTarget();
    this.fileInput.value = "";
    this.fileInput.click();
  };
  private readonly handleReplacementCancel = () => {
    this.pendingReplacement = null;
  };
  private readonly handleReplacementFile = () => {
    const target = this.pendingReplacement;
    const file = this.fileInput.files?.[0];
    const upload = this.options.uploadImage;
    this.pendingReplacement = null;
    this.fileInput.value = "";
    if (!file || !target || !upload) return;
    if (this.targetPosition(target) === null) {
      this.reportReplacementCancelled();
      return;
    }
    this.replacing = true;
    const operation = ++this.replacementOperation;
    this.renderChrome();
    void Promise.resolve()
      .then(() => upload(file))
      .then((uploaded) => {
        if (!this.patch(target, { src: uploaded.src }, true)) this.reportReplacementCancelled();
      })
      .catch((error: unknown) => this.options.onImageError?.(error))
      .finally(() => {
        if (operation !== this.replacementOperation) return;
        this.replacing = false;
        if (!this.destroyed) this.renderChrome();
      });
  };
  private reportReplacementCancelled(): void {
    this.options.onImageError?.(
      new Error("Image replacement was cancelled because its document target changed."),
    );
  }
  private removeImage(target: ImageTarget): void {
    const position = this.targetPosition(target);
    if (position === null) return;
    this.view.dispatch(
      closeHistory(this.view.state.tr.delete(position, position + target.node.nodeSize)),
    );
    this.view.focus();
  }
  private readonly retry = () => {
    if (!this.destroyed) {
      this.requestedSource = null;
      this.render();
    }
  };
  private readonly handleLoad = () => {
    if (
      this.destroyed ||
      !this.resolvedSource ||
      this.image.getAttribute("src") !== this.resolvedSource ||
      !this.image.complete ||
      this.image.naturalWidth === 0
    )
      return;
    this.loadState = "loaded";
    this.renderLoadState();
    this.renderChrome();
  };
  private readonly handleLoadError = () => {
    if (
      this.destroyed ||
      !this.resolvedSource ||
      this.image.getAttribute("src") !== this.resolvedSource ||
      !this.image.complete ||
      this.image.naturalWidth > 0
    )
      return;
    this.loadState = "failed";
    this.renderLoadState();
    this.renderChrome();
  };
  private readonly changeBackground = (background: "automatic" | "light" | "dark") => {
    this.image.style.backgroundColor =
      background === "light" ? "white" : background === "dark" ? "#0a0a0a" : "transparent";
  };

  private render(): void {
    if (this.destroyed) return;
    this.standalone = isStandaloneMarkdownImage(this.view, this.getPos(), this.node);
    this.dom.dataset.standalone = String(this.standalone);
    this.dom.tabIndex = this.editable ? -1 : 0;
    this.image.alt = String(this.node.attrs.alt ?? "");
    this.image.title = String(this.node.attrs.title ?? "");
    this.renderCaption();
    const source = String(this.node.attrs.src);
    if (source !== this.requestedSource) {
      this.requestedSource = source;
      this.resolvedSource = null;
      this.image.removeAttribute("src");
      const version = ++this.resolveVersion;
      this.loadState = source.length === 0 ? "failed" : "resolving";
      if (source.length > 0) {
        void Promise.resolve()
          .then(() => (this.resolveSource ? this.resolveSource(source) : source))
          .then((resolved) => {
            if (this.destroyed || version !== this.resolveVersion) return;
            this.resolvedSource = resolved;
            this.loadState = resolved ? "loading" : "failed";
            if (resolved) {
              this.image.src = resolved;
              if (this.image.complete && this.image.naturalWidth > 0) this.loadState = "loaded";
            }
            this.renderLoadState();
            this.renderChrome();
          })
          .catch(() => {
            if (this.destroyed || version !== this.resolveVersion) return;
            this.loadState = "failed";
            this.renderLoadState();
            this.renderChrome();
          });
      }
    }
    this.renderLoadState();
    this.renderChrome();
  }
  private fitCaption(): void {
    this.caption.style.height = "auto";
    if (this.caption.scrollHeight > 0) this.caption.style.height = `${this.caption.scrollHeight}px`;
  }
  private renderCaption(): void {
    const title = String(this.node.attrs.title ?? "");
    this.caption.hidden = !this.standalone || (title.length === 0 && !this.captionActive);
    this.caption.readOnly = !this.editable || this.referenceLabel() !== null;
    this.caption.tabIndex = this.editable && this.standalone && !this.caption.hidden ? 0 : -1;
    if ((!this.captionActive || this.captionTarget !== this.node) && this.caption.value !== title)
      this.caption.value = title;
    this.fitCaption();
  }
  private renderLoadState(): void {
    this.dom.dataset.imageState = this.loadState;
    this.image.hidden = this.loadState !== "loaded";
    this.placeholder.hidden = this.loadState === "loaded";
    this.placeholder.textContent =
      this.loadState === "failed"
        ? String(this.node.attrs.src).length === 0
          ? "Choose an image source"
          : "Image unavailable"
        : "Loading image…";
    this.placeholder.title = String(this.node.attrs.src);
  }
  private renderChrome(): void {
    if (this.destroyed) return;
    const target = this.currentTarget();
    const source = String(this.node.attrs.src);
    const details = this.details;
    const guarded = (run: () => void) => () => {
      if (this.targetPosition(target) !== null) run();
    };
    const actions: ScientImageAction[] = [...(this.options.resolveImageActions?.(source) ?? [])];
    const link = this.node.marks.find((mark) => mark.type.name === "link");
    if (link && this.options.onOpenImageLink)
      actions.push({
        id: "open-image-link",
        label: "Open link",
        closeViewer: true,
        run: () => this.options.onOpenImageLink?.(String(link.attrs.href), this.dom),
      });
    if (this.editable) {
      const position = this.getPos();
      actions.push({
        id: "edit-details",
        label: "Edit details",
        closeViewer: true,
        run: guarded(this.editDetails),
      });
      if (position !== undefined && canCaptionImage(this.view.state.doc, position))
        actions.push({
          id: "edit-caption",
          label: this.node.attrs.title ? "Edit caption" : "Add caption",
          closeViewer: true,
          run: guarded(this.editCaption),
        });
      if (this.options.uploadImage)
        actions.push({
          id: "replace-image",
          label: this.replacing ? "Replacing image…" : "Replace image",
          closeViewer: true,
          requiresUserActivation: this.referenceLabel() === null,
          disabled: this.replacing,
          run: guarded(this.replaceImage),
        });
      actions.push({
        id: "remove-image",
        label: "Remove from document",
        closeViewer: true,
        run: () => this.removeImage(target),
      });
    }
    this.root.render(
      createElement(
        Fragment,
        null,
        createElement(ScientImageControls, {
          imageURL: this.resolvedSource,
          imageCrossOrigin: null,
          sourceIdentity: source,
          resolveViewerSource: async () => {
            const resolved = this.resolveSource ? await this.resolveSource(source) : source;
            if (!resolved) throw new Error("Unable to resolve the image for expanded viewing.");
            return resolved;
          },
          alt: String(this.node.attrs.alt ?? ""),
          displayName: imageDisplayName(source),
          loaded: this.loadState === "loaded",
          selected: this.selected,
          authoring: this.editable,
          anchor: this.dom,
          actions,
          onRetry: this.retry,
          ...(this.options.showImageContextMenu
            ? { showContextMenu: this.options.showImageContextMenu }
            : {}),
          onBackgroundChange: this.changeBackground,
          revisionKey: String(this.resolveVersion),
        }),
        details
          ? createElement(ScientImageDetails, {
              key: details.id,
              anchor: this.dom,
              session: details,
              onApply: (value) => {
                if (this.details === details) this.applyDetails(value);
              },
              onClose: (returnFocus) => {
                if (this.details === details) this.closeDetails(returnFocus);
              },
              ...(this.options.editImageReference
                ? {
                    onEditReference: () => {
                      if (this.details === details) this.editReference();
                    },
                  }
                : {}),
              onIndependentCaption: () => {
                if (this.details === details) this.independentCaption();
              },
            })
          : null,
      ),
    );
  }
}

export function createScientImageNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  resolveSource?: ScientMarkdownImageSourceResolver,
  registerExternalPresentation?: ScientMarkdownExternalPresentationRegistrar,
  options: ScientMarkdownImageNodeViewOptions = {},
): NodeView {
  return new ScientImageNodeView(
    node,
    view,
    getPos,
    resolveSource,
    registerExternalPresentation,
    options,
  );
}
