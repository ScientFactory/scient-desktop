import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { toggleMark } from "prosemirror-commands";
import { redoDepth, undoDepth } from "prosemirror-history";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView, type DirectEditorProps } from "prosemirror-view";

import {
  ScientProseMirrorSession,
  scientMarkdownTransactionOriginKey,
  type ScientExternalSourceResult,
  type ScientExternalConflictResolution,
  type ScientMarkdownTransactionOrigin,
} from "./session";
import { buildScientMarkdownNodeViews, type ScientMarkdownImageSourceResolver } from "../nodes";
import {
  filterScientMarkdownSlashCommands,
  runScientMarkdownCommand,
  setSelectedTaskState,
  type ScientMarkdownCommand,
} from "./commands";
import { scientMarkdownSchema } from "./schema";
import {
  addImageUploadPlaceholder,
  imageUploadPlaceholderPosition,
  removeImageUploadPlaceholder,
} from "./imageUploads";
import {
  clearScientMarkdownSearch,
  configureScientMarkdownSearch,
  navigateScientMarkdownSearch,
  scientMarkdownSearchState,
} from "./search";
import {
  runScientMarkdownBlockAction,
  selectedTopLevelBlock,
  type ScientMarkdownBlockAction,
} from "./blocks";
import { scientMarkdownOutlineState, type ScientMarkdownOutlineItem } from "./outline";

export interface ScientMarkdownUploadedImage {
  readonly src: string;
  readonly alt: string;
  readonly title?: string | null;
}

export interface ScientMarkdownEditorViewOptions {
  readonly source: string;
  readonly revision: string;
  readonly mode?: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly onOpenWikiLink?: (target: string) => void;
  readonly onSelectionSourceOffsetChange?: (sourceOffset: number) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly selectImage?: () => void;
  readonly wikiLinkSuggestions?: () => ReadonlyArray<string>;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
}

export interface ScientMarkdownEditorSnapshot {
  readonly activeMarks: ReadonlyArray<string>;
  readonly blockType: string;
  readonly canDeleteBlock: boolean;
  readonly canDuplicateBlock: boolean;
  readonly canMoveBlockDown: boolean;
  readonly canMoveBlockUp: boolean;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly editable: boolean;
  readonly headingLevel: number | null;
  readonly findActiveIndex: number;
  readonly findCaseSensitive: boolean;
  readonly findFocusRequest: number;
  readonly findMatchCount: number;
  readonly findOpen: boolean;
  readonly findQuery: string;
  readonly findWholeWord: boolean;
  readonly inTable: boolean;
  readonly listKind: "bullet" | "ordered" | "task" | null;
  readonly outlineActiveIndex: number;
  readonly outlineItems: ReadonlyArray<ScientMarkdownOutlineItem>;
  readonly selectionEmpty: boolean;
  readonly slashActiveIndex: number;
  readonly slashQuery: string | null;
  readonly tableAlignment: string | null;
  readonly textDirection: "ltr" | "rtl" | null;
  readonly version: number;
}

function modeIsEditable(mode: MarkdownDocumentMode): boolean {
  return mode === "write" || mode === "split";
}

function documentIsEmpty(document: ProseMirrorNode): boolean {
  return (
    document.childCount === 1 &&
    document.firstChild?.type.name === "paragraph" &&
    document.firstChild.content.size === 0
  );
}

function accessibilityAttributes(
  mode: MarkdownDocumentMode,
  ariaLabel: string,
  empty: boolean,
): Readonly<Record<string, string>> {
  const editable = modeIsEditable(mode);
  const common = {
    "aria-label": ariaLabel,
    class: `scient-markdown-document is-${mode}${empty ? " is-empty" : ""}`,
    dir: "auto",
  };
  return editable
    ? {
        ...common,
        "aria-multiline": "true",
        ...(empty ? { "aria-placeholder": "Start writing" } : {}),
        role: "textbox",
      }
    : { ...common, role: "document" };
}

/**
 * Owns exactly one EditorView for a mounted document. Mode transitions update
 * view props in place and never recreate, parse, or transact the document.
 */
export class ScientMarkdownEditorView {
  readonly session: ScientProseMirrorSession;
  private editorView: EditorView | null = null;
  private mode: MarkdownDocumentMode;
  private readonly listeners = new Set<() => void>();
  private readonly taskCheckboxes = new Set<HTMLInputElement>();
  private slashActiveIndex = 0;
  private findOpen = false;
  private findFocusRequest = 0;
  private imageUploadSequence = 0;
  private lastPublishedSelectionSourceOffset: number | null = null;
  private selectionSyncSuppressed = false;
  private snapshotVersion = 0;
  private snapshot: ScientMarkdownEditorSnapshot;

  constructor(private readonly options: ScientMarkdownEditorViewOptions) {
    this.mode = options.mode ?? "read";
    this.session = new ScientProseMirrorSession(options);
    this.snapshot = this.createSnapshot();
  }

  get view(): EditorView | null {
    return this.editorView;
  }

  getSnapshot = (): ScientMarkdownEditorSnapshot => this.snapshot;

  /**
   * Viewport anchor for the floating selection toolbar: the horizontal center
   * of the first selected line plus the selection's outer top and bottom, or
   * null when the selection is not inline text (empty, node, or cell).
   */
  selectionToolbarAnchor(): { left: number; top: number; bottom: number } | null {
    const view = this.editorView;
    if (!view) return null;
    const { selection } = view.state;
    if (selection.empty || !(selection instanceof TextSelection)) return null;
    const fromCoords = view.coordsAtPos(selection.from);
    const toCoords = view.coordsAtPos(selection.to);
    const sameLine = Math.abs(fromCoords.top - toCoords.top) < 4;
    const left = sameLine ? (fromCoords.left + toCoords.left) / 2 : fromCoords.left;
    return {
      left,
      top: Math.min(fromCoords.top, toCoords.top),
      bottom: Math.max(fromCoords.bottom, toCoords.bottom),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(element: HTMLElement): EditorView {
    if (this.editorView !== null) return this.editorView;
    this.editorView = new EditorView(element, this.directProps());
    this.syncNodeViewEditability();
    this.publishSnapshot();
    if (modeIsEditable(this.mode)) this.editorView.focus();
    return this.editorView;
  }

  setMode(mode: MarkdownDocumentMode): void {
    if (this.mode === mode) return;
    const wasEditable = modeIsEditable(this.mode);
    this.mode = mode;
    this.session.setMode(mode);
    this.syncViewProps();
    this.syncNodeViewEditability();
    this.publishSnapshot();
    if (!wasEditable && modeIsEditable(mode)) this.editorView?.focus();
  }

  focus(): void {
    if (this.editorView && modeIsEditable(this.mode)) {
      this.editorView.focus();
    }
  }

  containsEditorDomNode(node: globalThis.Node | null): boolean {
    return node !== null && (this.editorView?.dom.contains(node) ?? false);
  }

  /** Wiki-link labels must be one source-safe inline text selection. */
  canSetWikiLink(): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    const { selection } = view.state;
    if (
      selection.empty ||
      !(selection instanceof TextSelection) ||
      selection.$from.parent !== selection.$to.parent ||
      !selection.$from.parent.inlineContent
    ) {
      return false;
    }
    const label = view.state.doc.textBetween(selection.from, selection.to, " ", " ");
    return label.length > 0 && label === label.trim() && !label.includes("]]");
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): void {
    if (this.editorView === null) throw new Error("Scient Markdown EditorView is not mounted.");
    const wasEmpty = documentIsEmpty(this.editorView.state.doc);
    const state = this.session.applyTransaction(transaction, origin);
    this.editorView.updateState(state);
    if (wasEmpty !== documentIsEmpty(state.doc)) {
      this.syncViewProps();
    }
    this.slashActiveIndex = 0;
    this.publishSnapshot();
  }

  replaceUserSource(source: string): void {
    const wasEmpty = this.editorView ? documentIsEmpty(this.editorView.state.doc) : true;
    const state = this.session.replaceUserSource(source);
    this.editorView?.updateState(state);
    if (wasEmpty !== documentIsEmpty(state.doc)) {
      this.syncViewProps();
    }
    this.slashActiveIndex = 0;
    this.publishSnapshot(false);
  }

  confirmSave(intent: MarkdownSaveIntent, revision: string): void {
    this.session.confirmSave(intent, revision);
  }

  /** A save intent for the current draft against the current baseline revision. */
  createSaveIntent(): MarkdownSaveIntent | null {
    return this.session.createSaveIntent();
  }

  receiveExternalSource(input: {
    readonly source: string;
    readonly revision: string;
  }): ScientExternalSourceResult {
    const result = this.session.receiveExternalSource(input);
    if (result === "adopted") {
      this.editorView?.updateState(this.session.state);
      this.syncViewProps();
      this.slashActiveIndex = 0;
      this.publishSnapshot(false);
    }
    return result;
  }

  resolveExternalConflict(resolution: ScientExternalConflictResolution): void {
    const state = this.session.resolveExternalConflict(resolution);
    this.editorView?.updateState(state);
    this.syncViewProps();
    this.publishSnapshot(false);
  }

  execute(command: ScientMarkdownCommand): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    view.focus();
    if (command === "image" && this.options.selectImage) {
      this.options.selectImage();
      return true;
    }
    if (command === "task-list") {
      if (!setSelectedTaskState(view.state, view.dispatch, false)) {
        if (!runScientMarkdownCommand(command, view.state, view.dispatch)) return false;
        setSelectedTaskState(view.state, view.dispatch, false);
      }
      view.focus();
      return true;
    }
    const handled = runScientMarkdownCommand(command, view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  setLink(href: string, title: string | null = null): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode) || href.trim().length === 0) return false;
    const handled = toggleMark(link, { href: href.trim(), title })(view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  removeLink(): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode)) return false;
    const transaction = view.state.tr.removeMark(
      view.state.selection.from,
      view.state.selection.to,
      link,
    );
    if (!transaction.docChanged) return false;
    view.dispatch(transaction);
    view.focus();
    return true;
  }

  /** Replace one inline text selection with a source-faithful labeled wiki link. */
  setWikiLink(target: string): boolean {
    const view = this.editorView;
    const wikiLink = scientMarkdownSchema.nodes.wiki_link;
    const normalizedTarget = target.trim();
    if (
      !view ||
      !wikiLink ||
      !this.canSetWikiLink() ||
      normalizedTarget.length === 0 ||
      normalizedTarget.includes("|") ||
      normalizedTarget.includes("]]")
    ) {
      return false;
    }
    const { selection } = view.state;
    const label = view.state.doc.textBetween(selection.from, selection.to, " ", " ");
    view.dispatch(
      view.state.tr
        .replaceSelectionWith(wikiLink.create({ target: normalizedTarget, label }), true)
        .scrollIntoView(),
    );
    view.focus();
    return true;
  }

  executeBlock(action: ScientMarkdownBlockAction): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    const handled = runScientMarkdownBlockAction(action, view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  navigateToOutline(position: number): boolean {
    const view = this.editorView;
    const node = view?.state.doc.nodeAt(position);
    if (!view || node?.type.name !== "heading") return false;
    view.dispatch(
      view.state.tr
        .setSelection(
          TextSelection.create(
            view.state.doc,
            Math.min(position + 1, position + node.nodeSize - 1),
          ),
        )
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false),
    );
    const dom = view.nodeDOM(position);
    if (dom instanceof HTMLElement && typeof dom.scrollIntoView === "function") {
      dom.scrollIntoView({ block: "start" });
    }
    view.focus();
    return true;
  }

  navigateToSourceOffset(sourceOffset: number): boolean {
    const view = this.editorView;
    const nodePosition = this.session.documentPositionForSourceOffset(sourceOffset);
    if (!view || nodePosition === null) return false;
    const selectionPosition = Math.min(nodePosition + 1, view.state.doc.content.size);
    this.selectionSyncSuppressed = true;
    try {
      view.dispatch(
        view.state.tr
          .setSelection(Selection.near(view.state.doc.resolve(selectionPosition), 1))
          .setMeta(scientMarkdownTransactionOriginKey, "system")
          .setMeta("addToHistory", false),
      );
    } finally {
      this.selectionSyncSuppressed = false;
    }
    const dom = view.nodeDOM(nodePosition);
    if (dom instanceof HTMLElement && typeof dom.scrollIntoView === "function") {
      dom.scrollIntoView({ block: "center" });
    }
    return true;
  }

  setFindOpen(open: boolean): void {
    if (this.findOpen === open) return;
    this.findOpen = open;
    if (!open && this.editorView) {
      this.clearFind();
      return;
    }
    this.publishSnapshot();
  }

  requestFind(): void {
    this.findOpen = true;
    this.findFocusRequest += 1;
    this.publishSnapshot();
  }

  configureFind(input: {
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly wholeWord: boolean;
  }): void {
    const view = this.editorView;
    if (!view) return;
    view.dispatch(
      configureScientMarkdownSearch(view.state.tr, input)
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false),
    );
  }

  clearFind(): void {
    const view = this.editorView;
    if (!view) return;
    view.dispatch(
      clearScientMarkdownSearch(view.state.tr)
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false),
    );
  }

  navigateFind(direction: -1 | 1): void {
    const view = this.editorView;
    if (!view) return;
    view.dispatch(
      navigateScientMarkdownSearch(view.state.tr, direction)
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false),
    );
    const search = scientMarkdownSearchState(view.state);
    const match = search.matches[search.activeIndex];
    if (!match) return;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, match.from, match.to))
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false)
        .scrollIntoView(),
    );
  }

  replaceFind(replacement: string, all: boolean): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    const search = scientMarkdownSearchState(view.state);
    if (search.matches.length === 0) return false;
    let transaction = view.state.tr;
    if (all) {
      for (let index = search.matches.length - 1; index >= 0; index -= 1) {
        const match = search.matches[index];
        if (match) transaction = transaction.insertText(replacement, match.from, match.to);
      }
    } else {
      const match = search.matches[search.activeIndex];
      if (!match) return false;
      transaction = transaction.insertText(replacement, match.from, match.to);
    }
    view.dispatch(transaction.scrollIntoView());
    return true;
  }

  uploadImageFile(file: File, position?: number): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode) || !this.options.uploadImage) return false;
    this.imageUploadSequence += 1;
    const id = `image-${this.imageUploadSequence.toString(36)}`;
    const placeholderPosition = Math.max(
      0,
      Math.min(position ?? view.state.selection.from, view.state.doc.content.size),
    );
    view.dispatch(
      addImageUploadPlaceholder(view.state.tr, {
        id,
        position: placeholderPosition,
        fileName: file.name || "image",
      })
        .setMeta(scientMarkdownTransactionOriginKey, "system")
        .setMeta("addToHistory", false),
    );

    void this.options.uploadImage(file).then(
      (uploaded) => {
        const currentView = this.editorView;
        if (!currentView) return;
        const currentPosition = imageUploadPlaceholderPosition(currentView.state, id);
        if (currentPosition === null) return;
        const image = scientMarkdownSchema.nodes.image?.create({
          src: uploaded.src,
          alt: uploaded.alt,
          title: uploaded.title ?? null,
        });
        if (!image) return;
        let transaction = removeImageUploadPlaceholder(currentView.state.tr, id);
        const resolvedPosition = transaction.doc.resolve(
          Math.min(currentPosition, transaction.doc.content.size),
        );
        transaction = transaction
          .setSelection(Selection.near(resolvedPosition))
          .replaceSelectionWith(image)
          .scrollIntoView();
        currentView.dispatch(transaction);
      },
      (error: unknown) => {
        const currentView = this.editorView;
        if (currentView) {
          currentView.dispatch(
            removeImageUploadPlaceholder(currentView.state.tr, id)
              .setMeta(scientMarkdownTransactionOriginKey, "system")
              .setMeta("addToHistory", false),
          );
        }
        this.options.onImageUploadFailure?.(error);
      },
    );
    return true;
  }

  destroy(): void {
    this.editorView?.destroy();
    this.editorView = null;
    this.listeners.clear();
  }

  private directProps(): DirectEditorProps {
    return {
      state: this.session.state,
      attributes: accessibilityAttributes(
        this.mode,
        this.options.ariaLabel,
        documentIsEmpty(this.session.state.doc),
      ),
      editable: () => modeIsEditable(this.mode),
      dispatchTransaction: (transaction) => {
        const taggedOrigin: unknown = transaction.getMeta(scientMarkdownTransactionOriginKey);
        const origin =
          taggedOrigin === "external" || taggedOrigin === "system" || taggedOrigin === "user"
            ? taggedOrigin
            : "user";
        this.applyTransaction(transaction, origin);
      },
      nodeViews: buildScientMarkdownNodeViews({
        ...(this.options.onOpenWikiLink ? { onOpenWikiLink: this.options.onOpenWikiLink } : {}),
        ...(this.options.resolveImageSource
          ? { resolveImageSource: this.options.resolveImageSource }
          : {}),
        registerTaskCheckbox: (checkbox) => {
          this.taskCheckboxes.add(checkbox);
          checkbox.disabled = !modeIsEditable(this.mode);
          return () => this.taskCheckboxes.delete(checkbox);
        },
        ...(this.options.wikiLinkSuggestions
          ? { wikiLinkSuggestions: this.options.wikiLinkSuggestions }
          : {}),
        ...(this.options.wikiLinkTargetExists
          ? { wikiLinkTargetExists: this.options.wikiLinkTargetExists }
          : {}),
      }),
      handleKeyDown: (_view, event) => this.handleEditorKeyDown(event),
      handleDoubleClickOn: (view, _position, node, nodePosition, event, direct) => {
        if (
          !direct ||
          !modeIsEditable(this.mode) ||
          node.type !== scientMarkdownSchema.nodes.wiki_link
        ) {
          return false;
        }
        event.preventDefault();
        view.dispatch(
          view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePosition)),
        );
        return true;
      },
      handlePaste: (_view, event) => this.handleImageTransfer(event.clipboardData),
      handleDrop: (view, event) => {
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return this.handleImageTransfer(event.dataTransfer, position);
      },
      handleDOMEvents: {
        click: (_view, event) => this.handleLinkClick(event),
      },
    };
  }

  private handleImageTransfer(data: DataTransfer | null, position?: number): boolean {
    if (!data || !this.options.uploadImage || !modeIsEditable(this.mode)) return false;
    const files = [...data.files].filter(
      (file) =>
        file.type.startsWith("image/") || /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(file.name),
    );
    if (files.length === 0) return false;
    files.forEach((file) => this.uploadImageFile(file, position));
    return true;
  }

  private handleLinkClick(event: MouseEvent): boolean {
    if (event.button !== 0 || !(event.target instanceof Element)) return false;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || !this.editorView?.dom.contains(anchor)) return false;
    if (modeIsEditable(this.mode) && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      return false;
    }
    event.preventDefault();
    const target = anchor.getAttribute("href")?.trim() ?? "";
    if (target.startsWith("#") && this.navigateToHeadingFragment(target.slice(1))) return true;
    if (target.length > 0) this.options.onOpenLink?.(target);
    return true;
  }

  private navigateToHeadingFragment(fragment: string): boolean {
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      return false;
    }
    const requested = decoded.trim().toLocaleLowerCase();
    if (requested.length === 0) return false;
    const occurrences = new Map<string, number>();
    for (const item of scientMarkdownOutlineState(this.editorView?.state ?? this.session.state)
      .items) {
      const base = item.text
        .trim()
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/gu, "-");
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const slug = occurrence === 0 ? base : `${base}-${occurrence}`;
      if (slug === requested) return this.navigateToOutline(item.position);
    }
    return false;
  }

  private syncNodeViewEditability(): void {
    const editable = modeIsEditable(this.mode);
    this.taskCheckboxes.forEach((checkbox) => {
      checkbox.disabled = !editable;
    });
  }

  private syncViewProps(): void {
    const view = this.editorView;
    if (!view) return;
    view.setProps({
      attributes: accessibilityAttributes(
        this.mode,
        this.options.ariaLabel,
        documentIsEmpty(view.state.doc),
      ),
      editable: () => modeIsEditable(this.mode),
    });
  }

  private createSnapshot(): ScientMarkdownEditorSnapshot {
    const state = this.editorView?.state ?? this.session.state;
    const { selection } = state;
    const activeMarks = Object.values(scientMarkdownSchema.marks)
      .filter((mark) =>
        selection.empty
          ? (state.storedMarks ?? selection.$from.marks()).some((active) => active.type === mark)
          : state.doc.rangeHasMark(selection.from, selection.to, mark),
      )
      .map((mark) => mark.name);
    let blockType = selection.$from.parent.type.name;
    let headingLevel: number | null =
      blockType === "heading" ? Number(selection.$from.parent.attrs.level) : null;
    let listKind: "bullet" | "ordered" | "task" | null = null;
    let textDirection: "ltr" | "rtl" | null = null;
    let inTable = false;
    let tableAlignment: string | null = null;
    for (let depth = selection.$from.depth; depth >= 0; depth -= 1) {
      const node = selection.$from.node(depth);
      if (node.type.name === "table") inTable = true;
      if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
        tableAlignment =
          typeof node.attrs.alignment === "string" ? node.attrs.alignment : tableAlignment;
      }
      if (
        textDirection === null &&
        (node.type.name === "paragraph" || node.type.name === "heading")
      ) {
        textDirection = node.attrs.dir === "rtl" ? "rtl" : node.attrs.dir === "ltr" ? "ltr" : null;
      }
      if (listKind === null) {
        if (node.type.name === "bullet_list") {
          const firstItem = node.firstChild;
          listKind =
            firstItem?.type.name === "list_item" && firstItem.attrs.taskChecked !== null
              ? "task"
              : "bullet";
        } else if (node.type.name === "ordered_list") {
          listKind = "ordered";
        }
      }
      if (blockType === "paragraph" && node.isBlock && node.type.name !== "doc") {
        blockType = node.type.name;
        headingLevel = node.type.name === "heading" ? Number(node.attrs.level) : headingLevel;
      }
    }
    const slashQuery = this.slashQuery();
    const find = scientMarkdownSearchState(state);
    const block = selectedTopLevelBlock(state);
    const outlineItems = scientMarkdownOutlineState(state).items;
    let outlineActiveIndex = -1;
    outlineItems.forEach((item, index) => {
      if (item.position <= selection.from) outlineActiveIndex = index;
    });
    const slashItems = slashQuery === null ? [] : filterScientMarkdownSlashCommands(slashQuery);
    return {
      activeMarks,
      blockType,
      canDeleteBlock: block?.canDelete ?? false,
      canDuplicateBlock: block?.canDuplicate ?? false,
      canMoveBlockDown: block?.canMoveDown ?? false,
      canMoveBlockUp: block?.canMoveUp ?? false,
      canRedo: redoDepth(state) > 0,
      canUndo: undoDepth(state) > 0,
      editable: modeIsEditable(this.mode),
      findActiveIndex: find.activeIndex,
      findCaseSensitive: find.caseSensitive,
      findFocusRequest: this.findFocusRequest,
      findMatchCount: find.matches.length,
      findOpen: this.findOpen,
      findQuery: find.query,
      findWholeWord: find.wholeWord,
      headingLevel,
      inTable,
      listKind,
      outlineActiveIndex,
      textDirection,
      outlineItems,
      selectionEmpty: selection.empty,
      slashActiveIndex: Math.min(this.slashActiveIndex, Math.max(0, slashItems.length - 1)),
      slashQuery,
      tableAlignment,
      version: this.snapshotVersion,
    };
  }

  private publishSnapshot(syncSelection = true): void {
    this.snapshotVersion += 1;
    this.snapshot = this.createSnapshot();
    this.listeners.forEach((listener) => listener());
    if (!syncSelection || this.selectionSyncSuppressed) return;
    const state = this.editorView?.state ?? this.session.state;
    const sourceOffset = this.session.sourceOffsetForDocumentPosition(state.selection.head);
    if (sourceOffset === null || sourceOffset === this.lastPublishedSelectionSourceOffset) return;
    this.lastPublishedSelectionSourceOffset = sourceOffset;
    this.options.onSelectionSourceOffsetChange?.(sourceOffset);
  }

  private slashQuery(): string | null {
    const state = this.editorView?.state ?? this.session.state;
    const { selection } = state;
    if (!selection.empty || selection.$from.parent.type.name !== "paragraph") return null;
    const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, "\0", "\0");
    const match = /^\/([^\s/]*)$/u.exec(before);
    return match?.[1] ?? null;
  }

  private handleSlashKeyDown(event: KeyboardEvent): boolean {
    const query = this.slashQuery();
    if (query === null) return false;
    const items = filterScientMarkdownSlashCommands(query);
    if (items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.slashActiveIndex = (this.slashActiveIndex + direction + items.length) % items.length;
      this.publishSnapshot();
      return true;
    }
    if (event.key !== "Enter") return false;
    event.preventDefault();
    const item = items[Math.min(this.slashActiveIndex, items.length - 1)];
    if (!item) return false;
    return this.executeSlashCommand(item.command);
  }

  private handleEditorKeyDown(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      this.requestFind();
      return true;
    }
    if (event.altKey && event.shiftKey && event.key === "ArrowDown") {
      const handled = this.executeBlock("duplicate");
      if (handled) event.preventDefault();
      return handled;
    }
    if (
      event.altKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.key === "ArrowUp"
    ) {
      const handled = this.executeBlock("move-up");
      if (handled) event.preventDefault();
      return handled;
    }
    if (
      event.altKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.key === "ArrowDown"
    ) {
      const handled = this.executeBlock("move-down");
      if (handled) event.preventDefault();
      return handled;
    }
    if (event.key === "Escape" && this.findOpen) {
      event.preventDefault();
      this.setFindOpen(false);
      return true;
    }
    return this.handleSlashKeyDown(event);
  }

  executeSlashCommand(command: ScientMarkdownCommand): boolean {
    const view = this.editorView;
    const query = this.slashQuery();
    if (!view || query === null || !modeIsEditable(this.mode)) return false;
    const from = view.state.selection.$from.start();
    view.dispatch(view.state.tr.delete(from, view.state.selection.from));
    this.slashActiveIndex = 0;
    return this.execute(command);
  }
}
