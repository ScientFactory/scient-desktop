import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { markdownLinkAtPosition, selectedMarkdownLink } from "./links";
import { closeHistory, redoDepth, undoDepth } from "prosemirror-history";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  AllSelection,
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { CellSelection, cellAround, findTable } from "prosemirror-tables";
import { EditorView, type DirectEditorProps } from "prosemirror-view";

import type { ScientRichFenceContextMenuHandler } from "~/scient/presentation/RichFenceSourceActions";

import {
  ScientProseMirrorSession,
  scientMarkdownTransactionOriginKey,
  type ScientExternalSourceResult,
  type ScientExternalConflictResolution,
  type ScientMarkdownTransactionOrigin,
} from "./session";
import {
  buildScientMarkdownNodeViews,
  type ScientMarkdownExternalPresentationChange,
  type ScientMarkdownExternalPresentationRefresh,
  type ScientMarkdownFootnoteNodeViewRegistration,
  type ScientMarkdownImageSourceResolver,
  type ScientMarkdownTheme,
} from "../nodes";
import type { ScientNestedCodeEditor } from "../nodes/codeMirrorCodeEditor";
import type {
  ScientMarkdownImageNodeViewOptions,
  ScientMarkdownImageNodeViewRegistration,
} from "../nodes/imageNodeView";
import {
  filterScientMarkdownSlashCommands,
  runScientMarkdownCommand,
  runScientMarkdownTableInsert,
  type ScientMarkdownCommand,
  type ScientMarkdownTableDimensions,
} from "./commands";
import { scientMarkdownParser, scientMarkdownSchema } from "./schema";
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
import type {
  ScientMarkdownLinkCopyRequest,
  ScientMarkdownLinkContextMenuAction,
  ScientMarkdownLinkContextMenuRequest,
  ScientMarkdownLinkKind,
} from "../linkContextMenu";
import type { ScientMarkdownLinkOpenHandler } from "../linkOpen";
import type {
  ScientMarkdownTableContextMenuAction,
  ScientMarkdownTableContextMenuHandler,
} from "../tableContextMenu";
import {
  scientMarkdownFootnoteDefinitionId,
  scientMarkdownFootnotePresentation,
} from "../footnotes";
import type {
  ScientMarkdownFootnoteContextMenuAction,
  ScientMarkdownFootnoteContextMenuHandler,
  ScientMarkdownFootnoteContextMenuRequest,
} from "../footnoteContextMenu";
import { matchesScientMarkdownShortcut } from "../shortcuts";

export interface ScientMarkdownUploadedImage {
  readonly src: string;
  readonly alt: string;
  readonly title?: string | null;
}

export interface ScientMarkdownEditorViewOptions {
  readonly source: string;
  readonly revision: string;
  readonly authoritativeSource?: string;
  readonly mode?: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly onUserSourceChange?: (source: string, intent: MarkdownSaveIntent | null) => void;
  readonly onLocalHeadingOpened?: () => void;
  readonly onOpenLink?: ScientMarkdownLinkOpenHandler;
  readonly onOpenWikiLink?: ScientMarkdownLinkOpenHandler;
  readonly resolveLinkFullPath?: (kind: ScientMarkdownLinkKind, target: string) => string | null;
  readonly onCopyLink?: (request: ScientMarkdownLinkCopyRequest, anchor: HTMLElement) => void;
  readonly showLinkContextMenu?: (
    request: ScientMarkdownLinkContextMenuRequest,
  ) => Promise<ScientMarkdownLinkContextMenuAction | null>;
  readonly showFootnoteContextMenu?: ScientMarkdownFootnoteContextMenuHandler;
  readonly showRichFenceContextMenu?: ScientRichFenceContextMenuHandler;
  readonly showTableContextMenu?: ScientMarkdownTableContextMenuHandler;
  readonly onSelectionSourceOffsetChange?: (sourceOffset: number) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly imageOptions?: Omit<
    ScientMarkdownImageNodeViewOptions,
    "registerImage" | "uploadImage" | "editImageReference" | "onOpenImageLink"
  >;
  readonly onOpenSourceLine?: (line: number) => void;
  readonly resolveTheme?: () => ScientMarkdownTheme;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly selectImage?: () => void;
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
  readonly canSetWikiLink: boolean;
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
  readonly linkEditRequest: number;
  readonly outlineActiveIndex: number;
  readonly outlineItems: ReadonlyArray<ScientMarkdownOutlineItem>;
  readonly selectionEmpty: boolean;
  readonly selectedWikiLinkTarget: string | null;
  readonly slashActiveIndex: number;
  readonly slashQuery: string | null;
  readonly tableAlignment: string | null;
  readonly textDirection: "ltr" | "rtl" | null;
  readonly version: number;
  readonly wikiLinkEditRequest: number;
}

function modeIsEditable(mode: MarkdownDocumentMode): boolean {
  return mode === "write";
}

function documentIsEmpty(document: ProseMirrorNode): boolean {
  return (
    document.childCount === 1 &&
    document.firstChild?.type.name === "paragraph" &&
    document.firstChild.content.size === 0
  );
}

const ordinaryLinkDoubleClickDelayMs = 220;

interface WikiLinkSelection {
  readonly from: number;
  readonly label: string | null;
  readonly target: string | null;
  readonly to: number;
}

interface TableContextSelection {
  readonly from: number;
  readonly tablePosition: number;
  readonly to: number;
}

interface FootnoteContextSelection {
  readonly label: string;
  readonly referencePosition: number;
  readonly request: ScientMarkdownFootnoteContextMenuRequest;
}

function selectionIncludesTableCell(selection: Selection, cellPosition: number): boolean {
  if (selection instanceof CellSelection) {
    let included = false;
    selection.forEachCell((_cell, position) => {
      if (position === cellPosition) included = true;
    });
    return included;
  }
  return cellAround(selection.$from)?.pos === cellPosition;
}

function contextMenuPosition(event: MouseEvent, anchor: Element): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const bounds = anchor.getBoundingClientRect();
  return {
    x: Math.max(0, bounds.left + Math.min(bounds.width, 12)),
    y: Math.max(0, bounds.top + Math.min(bounds.height, 12)),
  };
}

/**
 * Resolve one source-safe wiki-link label. Pointer selections can include an
 * adjacent space, so preserve that whitespace outside the replacement instead
 * of hiding the command or moving the space into the wiki-link label.
 */
function resolveWikiLinkSelection(state: EditorState): WikiLinkSelection | null {
  const { selection } = state;
  if (
    selection.empty ||
    !(selection instanceof TextSelection) ||
    selection.$from.parent !== selection.$to.parent ||
    !selection.$from.parent.inlineContent
  ) {
    return null;
  }

  const selectedNode = state.doc.nodeAt(selection.from);
  if (
    selectedNode !== null &&
    selectedNode.type === scientMarkdownSchema.nodes.wiki_link &&
    selection.to === selection.from + selectedNode.nodeSize
  ) {
    return {
      from: selection.from,
      label: typeof selectedNode.attrs.label === "string" ? selectedNode.attrs.label : null,
      target: String(selectedNode.attrs.target),
      to: selection.to,
    };
  }

  let containsNonTextLeaf = false;
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isLeaf && !node.isText) containsNonTextLeaf = true;
    return !containsNonTextLeaf;
  });
  if (containsNonTextLeaf) return null;

  const selectedText = state.doc.textBetween(selection.from, selection.to, "", "");
  const label = selectedText.trim();
  if (label.length === 0 || label.includes("]]")) return null;

  const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
  const trailingWhitespace = selectedText.length - selectedText.trimEnd().length;
  return {
    from: selection.from + leadingWhitespace,
    label,
    target: null,
    to: selection.to - trailingWhitespace,
  };
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
  private readonly codeEditors = new Set<ScientNestedCodeEditor>();
  private readonly rawSourceEditors = new Set<HTMLTextAreaElement>();
  private readonly taskCheckboxes = new Set<HTMLInputElement>();
  private readonly wikiLinks = new Map<HTMLElement, () => number | undefined>();
  private readonly imageNodeViews = new Map<HTMLElement, ScientMarkdownImageNodeViewRegistration>();
  private readonly footnoteNodeViews = new Map<
    HTMLElement,
    ScientMarkdownFootnoteNodeViewRegistration
  >();
  private readonly externalPresentationRefreshers =
    new Set<ScientMarkdownExternalPresentationRefresh>();
  private pendingLinkOpen: ReturnType<typeof globalThis.setTimeout> | null = null;
  private linkPointerOrigin: { readonly x: number; readonly y: number } | null = null;
  private linkPointerDragged = false;
  private slashActiveIndex = 0;
  private findOpen = false;
  private findFocusRequest = 0;
  private findReturnFocus: HTMLElement | null = null;
  private imageUploadSequence = 0;
  private linkEditRequest = 0;
  private wikiLinkEditRequest = 0;
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
    this.refreshFootnoteNodeViews();
    this.publishSnapshot();
    if (modeIsEditable(this.mode)) this.editorView.focus();
    return this.editorView;
  }

  setMode(mode: MarkdownDocumentMode): void {
    if (this.mode === mode) return;
    this.cancelPendingLinkOpen();
    const wasEditable = modeIsEditable(this.mode);
    this.mode = mode;
    this.session.setMode(mode);
    this.syncViewProps();
    this.syncNodeViewEditability();
    this.refreshExternalPresentation("mode");
    this.refreshFootnoteNodeViews();
    this.publishSnapshot();
    if (!wasEditable && modeIsEditable(mode)) this.editorView?.focus();
  }

  focus(): void {
    if (this.editorView && modeIsEditable(this.mode)) {
      this.editorView.focus();
    }
  }

  selectAll(): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    if (!(view.state.selection instanceof AllSelection)) {
      view.dispatch(
        view.state.tr
          .setSelection(new AllSelection(view.state.doc))
          .setMeta(scientMarkdownTransactionOriginKey, "system")
          .setMeta("addToHistory", false),
      );
    }
    view.focus();
    return true;
  }

  requestLinkEdit(): boolean {
    const selection = this.editorView?.state.selection;
    if (!modeIsEditable(this.mode) || !(selection instanceof TextSelection)) return false;
    this.linkEditRequest += 1;
    this.publishSnapshot(false);
    return true;
  }

  refreshExternalPresentation(change: ScientMarkdownExternalPresentationChange): void {
    if (change === "appearance") {
      this.codeEditors.forEach((editor) => editor.refreshAppearance());
    }
    this.externalPresentationRefreshers.forEach((refresh) => refresh(change));
  }

  containsEditorDomNode(node: globalThis.Node | null): boolean {
    return node !== null && (this.editorView?.dom.contains(node) ?? false);
  }

  applyTransaction(transaction: Transaction, origin: ScientMarkdownTransactionOrigin): void {
    if (this.editorView === null) throw new Error("Scient Markdown EditorView is not mounted.");
    if (origin === "user" && transaction.docChanged) this.cancelPendingLinkOpen();
    const wasEmpty = documentIsEmpty(this.editorView.state.doc);
    const state = this.session.applyTransaction(transaction, origin);
    this.editorView.updateState(state);
    if (transaction.docChanged) this.refreshImageContexts();
    this.refreshFootnoteNodeViews();
    if (wasEmpty !== documentIsEmpty(state.doc)) {
      this.syncViewProps();
    }
    this.slashActiveIndex = 0;
    this.publishSnapshot();
  }

  replaceUserSource(source: string): void {
    const wasEmpty = this.editorView ? documentIsEmpty(this.editorView.state.doc) : true;
    this.invalidateImageEditing();
    const state = this.session.replaceUserSource(source);
    this.editorView?.updateState(state);
    this.refreshImageContexts();
    this.refreshFootnoteNodeViews();
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
      this.invalidateImageEditing();
      this.editorView?.updateState(this.session.state);
      this.refreshImageContexts();
      this.refreshFootnoteNodeViews();
      this.syncViewProps();
      this.slashActiveIndex = 0;
      this.publishSnapshot(false);
    }
    return result;
  }

  resolveExternalConflict(resolution: ScientExternalConflictResolution): void {
    if (resolution === "disk") this.invalidateImageEditing();
    const state = this.session.resolveExternalConflict(resolution);
    this.editorView?.updateState(state);
    this.refreshImageContexts();
    this.refreshFootnoteNodeViews();
    this.syncViewProps();
    this.publishSnapshot(false);
  }

  /** Adopt a complete disk snapshot as the CAS baseline without replacing the local document. */
  rebaseLocalChanges(input: { readonly source: string; readonly revision: string }): void {
    this.session.rebaseLocalChanges(input);
  }

  discardLocalChanges(input: { readonly source: string; readonly revision: string }): void {
    this.invalidateImageEditing();
    const state = this.session.discardLocalChanges(input);
    this.editorView?.updateState(state);
    this.refreshImageContexts();
    this.refreshFootnoteNodeViews();
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
    const handled = runScientMarkdownCommand(command, view.state, view.dispatch);
    if (handled) {
      if (command === "footnote") this.focusSelectedFootnoteDefinition();
      else view.focus();
    }
    return handled;
  }

  insertTable(dimensions: ScientMarkdownTableDimensions): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    view.focus();
    const handled = runScientMarkdownTableInsert(dimensions, view.state, view.dispatch);
    if (handled) view.focus();
    return handled;
  }

  setLink(href: string, title: string | null = null): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode) || href.trim().length === 0) return false;
    const destination = scientMarkdownParser.tokenizer.normalizeLink(href.trim());
    if (!scientMarkdownParser.tokenizer.validateLink(destination)) return false;
    const current = selectedMarkdownLink(view.state);
    const range = view.state.selection.empty && current ? current : view.state.selection;
    const mark = link.create({ href: destination, title });
    view.dispatch(
      range.from === range.to
        ? view.state.tr.addStoredMark(mark)
        : view.state.tr.addMark(range.from, range.to, mark),
    );
    view.focus();
    return true;
  }

  currentLink(): ReturnType<typeof selectedMarkdownLink> {
    return this.editorView ? selectedMarkdownLink(this.editorView.state) : null;
  }

  removeLink(): boolean {
    const view = this.editorView;
    const link = scientMarkdownSchema.marks.link;
    if (!view || !link || !modeIsEditable(this.mode)) return false;
    const current = selectedMarkdownLink(view.state);
    const range = view.state.selection.empty && current ? current : view.state.selection;
    const transaction = view.state.tr.removeMark(range.from, range.to, link).removeStoredMark(link);
    if (!transaction.docChanged && !transaction.storedMarksSet) return false;
    view.dispatch(transaction);
    view.focus();
    return true;
  }

  /** Replace one inline text selection with a source-faithful labeled wiki link. */
  setWikiLink(target: string): boolean {
    const view = this.editorView;
    const wikiLink = scientMarkdownSchema.nodes.wiki_link;
    const normalizedTarget = target.trim();
    const wikiLinkSelection = view ? resolveWikiLinkSelection(view.state) : null;
    if (
      !view ||
      !wikiLink ||
      !modeIsEditable(this.mode) ||
      !wikiLinkSelection ||
      normalizedTarget.length === 0 ||
      normalizedTarget.includes("|") ||
      normalizedTarget.includes("]]")
    ) {
      return false;
    }
    let transaction = view.state.tr;
    if (
      wikiLinkSelection.from !== view.state.selection.from ||
      wikiLinkSelection.to !== view.state.selection.to
    ) {
      transaction = transaction.setSelection(
        TextSelection.create(transaction.doc, wikiLinkSelection.from, wikiLinkSelection.to),
      );
    }
    view.dispatch(
      transaction
        .replaceSelectionWith(
          wikiLink.create({ target: normalizedTarget, label: wikiLinkSelection.label }),
          true,
        )
        .scrollIntoView(),
    );
    view.focus();
    return true;
  }

  /** Restore the visible label of one deliberately selected wiki link as ordinary text. */
  removeWikiLink(): boolean {
    const view = this.editorView;
    const selection = view ? resolveWikiLinkSelection(view.state) : null;
    if (!view || !selection?.target || !modeIsEditable(this.mode)) return false;
    const visibleText = selection.label ?? selection.target;
    if (visibleText.length === 0) return false;
    const text = scientMarkdownSchema.text(visibleText);
    const transaction = view.state.tr.replaceWith(selection.from, selection.to, text);
    view.dispatch(
      transaction
        .setSelection(
          TextSelection.create(transaction.doc, selection.from, selection.from + text.nodeSize),
        )
        .scrollIntoView(),
    );
    view.focus();
    return true;
  }

  acknowledgeWikiLinkEditRequest(request: number): void {
    if (request === 0 || request !== this.wikiLinkEditRequest) return;
    this.wikiLinkEditRequest = 0;
    this.publishSnapshot(false);
  }

  acknowledgeLinkEditRequest(request: number): void {
    if (request === 0 || request !== this.linkEditRequest) return;
    this.linkEditRequest = 0;
    this.publishSnapshot(false);
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

  editImageReference(label: string): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    const definition = this.session.referenceDefinitionForLabel(label);
    if (!definition) return false;
    const position = this.session.documentPositionForSourceOffset(definition.sourceOffset);
    const node = position === null ? null : view.state.doc.nodeAt(position);
    if (
      position !== null &&
      node?.type.name === "raw_block" &&
      node.attrs.sourceKind === "definition"
    ) {
      view.dispatch(
        view.state.tr
          .setSelection(NodeSelection.create(view.state.doc, position))
          .setMeta(scientMarkdownTransactionOriginKey, "system")
          .setMeta("addToHistory", false),
      );
      const dom = view.nodeDOM(position);
      const field =
        dom instanceof HTMLElement
          ? dom.querySelector<HTMLTextAreaElement>(".scient-markdown-source-island-editor")
          : null;
      if (field && dom instanceof HTMLElement) {
        const offset = Math.max(
          0,
          definition.sourceOffset -
            (this.session.sourceOffsetForDocumentPosition(position + 1) ?? definition.sourceOffset),
        );
        dom.scrollIntoView?.({ block: "center" });
        field.focus({ preventScroll: true });
        field.setSelectionRange(offset, offset);
        return true;
      }
    }
    if (!this.options.onOpenSourceLine) return false;
    this.options.onOpenSourceLine(definition.line);
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

  requestFind(returnFocus: HTMLElement | null = null): void {
    if (!this.findOpen) this.findReturnFocus = returnFocus?.isConnected ? returnFocus : null;
    this.findOpen = true;
    this.findFocusRequest += 1;
    this.publishSnapshot();
  }

  closeFind(): void {
    this.setFindOpen(false);
    const returnFocus = this.findReturnFocus;
    this.findReturnFocus = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    } else {
      this.editorView?.focus();
    }
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
        if (!currentView || currentView !== view) return;
        const currentPosition = imageUploadPlaceholderPosition(currentView.state, id);
        if (currentPosition === null) return;
        if (!modeIsEditable(this.mode)) {
          currentView.dispatch(
            removeImageUploadPlaceholder(currentView.state.tr, id)
              .setMeta(scientMarkdownTransactionOriginKey, "system")
              .setMeta("addToHistory", false),
          );
          return;
        }
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
    this.cancelPendingLinkOpen();
    this.stopTrackingLinkPointer();
    this.editorView?.destroy();
    this.editorView = null;
    this.externalPresentationRefreshers.clear();
    this.codeEditors.clear();
    this.footnoteNodeViews.clear();
    this.rawSourceEditors.clear();
    this.imageNodeViews.clear();
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
        imageOptions: {
          ...this.options.imageOptions,
          ...(this.options.uploadImage ? { uploadImage: this.options.uploadImage } : {}),
          onOpenImageLink: (target, anchor) => {
            this.openLinkTarget(target, anchor);
          },
          editImageReference: (label) => {
            if (!this.editImageReference(label)) {
              this.options.imageOptions?.onImageError?.(
                new Error("The image reference is no longer available."),
              );
            }
          },
          registerImage: (registration) => {
            this.imageNodeViews.set(registration.element, registration);
            registration.setEditable(modeIsEditable(this.mode));
            return () => {
              this.imageNodeViews.delete(registration.element);
            };
          },
        },
        ...(this.options.onOpenWikiLink ? { onOpenWikiLink: this.options.onOpenWikiLink } : {}),
        ...(this.options.resolveImageSource
          ? { resolveImageSource: this.options.resolveImageSource }
          : {}),
        ...(this.options.resolveTheme ? { resolveTheme: this.options.resolveTheme } : {}),
        ...(this.options.showRichFenceContextMenu
          ? { showRichFenceContextMenu: this.options.showRichFenceContextMenu }
          : {}),
        registerExternalPresentation: (refresh) => {
          this.externalPresentationRefreshers.add(refresh);
          return () => {
            this.externalPresentationRefreshers.delete(refresh);
          };
        },
        registerCodeEditor: (editor) => {
          this.codeEditors.add(editor);
          editor.setEditable(modeIsEditable(this.mode));
          return () => {
            this.codeEditors.delete(editor);
          };
        },
        registerFootnote: (registration) => {
          this.footnoteNodeViews.set(registration.element, registration);
          registration.setEditable(modeIsEditable(this.mode));
          registration.refresh(
            scientMarkdownFootnotePresentation(
              this.editorView?.state.doc ?? this.session.state.doc,
            ),
          );
          return () => {
            this.footnoteNodeViews.delete(registration.element);
          };
        },
        registerRawSourceEditor: (editor) => {
          this.rawSourceEditors.add(editor);
          editor.readOnly = !modeIsEditable(this.mode);
          return () => {
            this.rawSourceEditors.delete(editor);
          };
        },
        registerTaskCheckbox: (checkbox) => {
          this.taskCheckboxes.add(checkbox);
          checkbox.disabled = !modeIsEditable(this.mode);
          return () => this.taskCheckboxes.delete(checkbox);
        },
        registerWikiLink: (link, getPos) => {
          this.wikiLinks.set(link, getPos);
          link.tabIndex = modeIsEditable(this.mode) ? -1 : 0;
          return () => this.wikiLinks.delete(link);
        },
        ...(this.options.wikiLinkTargetExists
          ? { wikiLinkTargetExists: this.options.wikiLinkTargetExists }
          : {}),
      }),
      handleKeyDown: (_view, event) => this.handleEditorKeyDown(event),
      handleClickOn: (_view, _position, node, _nodePosition, event, direct) =>
        direct && event.button === 0 && node.type === scientMarkdownSchema.nodes.wiki_link,
      handleDoubleClickOn: (view, _position, node, nodePosition, event, direct) => {
        if (
          !direct ||
          !modeIsEditable(this.mode) ||
          node.type !== scientMarkdownSchema.nodes.wiki_link
        ) {
          return false;
        }
        event.preventDefault();
        this.wikiLinkEditRequest += 1;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, nodePosition, nodePosition + node.nodeSize),
          ),
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
        contextmenu: (_view, event) =>
          this.handleImageContextMenu(event) ||
          this.handleFootnoteContextMenu(event) ||
          this.handleLinkContextMenu(event) ||
          this.handleTableContextMenu(event),
        mousedown: (_view, event) => this.handleLinkMouseDown(event),
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

  private selectedImageView(): ScientMarkdownImageNodeViewRegistration | undefined {
    const selection = this.editorView?.state.selection;
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return;
    return [...this.imageNodeViews.values()].find((image) => image.getPos() === selection.from);
  }

  private handleImageContextMenu(event: MouseEvent): boolean {
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("input, textarea")) return false;
      const element = target.closest<HTMLElement>("[data-scient-markdown-image]");
      if (element) return this.imageNodeViews.get(element)?.showContextMenu(event) ?? false;
    }
    return false;
  }

  private refreshImageContexts(): void {
    this.imageNodeViews.forEach((image) => image.refreshContext());
  }

  private invalidateImageEditing(): void {
    this.imageNodeViews.forEach((image) => image.invalidateEditing());
  }

  private handleLinkClick(event: MouseEvent): boolean {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      this.cancelPendingLinkOpen();
      return false;
    }
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || !this.editorView?.dom.contains(anchor)) {
      this.cancelPendingLinkOpen();
      return false;
    }
    if (this.linkPointerDragged) {
      this.linkPointerDragged = false;
      this.cancelPendingLinkOpen();
      return false;
    }
    const target = anchor.getAttribute("href")?.trim() ?? "";
    if (target.length === 0) return false;
    if (!target.startsWith("#") && !this.options.onOpenLink) return false;
    if (modeIsEditable(this.mode) && !(event.metaKey || event.ctrlKey)) {
      if (event.detail > 1) {
        this.cancelPendingLinkOpen();
        return false;
      }
      event.preventDefault();
      this.cancelPendingLinkOpen();
      this.pendingLinkOpen = globalThis.setTimeout(() => {
        this.pendingLinkOpen = null;
        this.openLinkTarget(target, anchor);
      }, ordinaryLinkDoubleClickDelayMs);
      return true;
    }
    event.preventDefault();
    this.cancelPendingLinkOpen();
    return this.openLinkTarget(target, anchor);
  }

  private handleLinkMouseDown(event: MouseEvent): boolean {
    this.cancelPendingLinkOpen();
    if (event.button !== 0 || !(event.target instanceof Element)) return false;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || !this.editorView?.dom.contains(anchor)) return false;
    this.linkPointerOrigin = { x: event.clientX, y: event.clientY };
    this.linkPointerDragged = false;
    anchor.ownerDocument.addEventListener("mousemove", this.handleLinkPointerMove);
    anchor.ownerDocument.addEventListener("mouseup", this.handleLinkPointerUp, { once: true });
    return false;
  }

  private handleFootnoteContextMenu(event: MouseEvent): boolean {
    const view = this.editorView;
    const show = this.options.showFootnoteContextMenu;
    if (!view || !show || !(event.target instanceof Element)) return false;
    const footnote = event.target.closest<HTMLElement>(
      '[data-scient-markdown-reference="footnote_reference"]',
    );
    if (!footnote || !view.dom.contains(footnote)) return false;
    const referencePosition = this.footnoteNodeViews.get(footnote)?.getPos();
    const node = referencePosition === undefined ? null : view.state.doc.nodeAt(referencePosition);
    if (
      referencePosition === undefined ||
      !node ||
      node.type !== scientMarkdownSchema.nodes.footnote_reference
    ) {
      return false;
    }

    const label = String(node.attrs.label);
    const entry = scientMarkdownFootnotePresentation(view.state.doc).get(label);
    if (!entry) return false;
    const request: ScientMarkdownFootnoteContextMenuRequest = {
      canCopy: this.options.onCopyLink !== undefined,
      editable: modeIsEditable(this.mode),
      hasDefinition: entry.definitionPosition !== null,
      isFinalReference: entry.referencePositions.length === 1,
      position: contextMenuPosition(event, footnote),
    };
    event.preventDefault();
    event.stopPropagation();
    this.cancelPendingLinkOpen();
    this.stopTrackingLinkPointer();
    void this.applyFootnoteContextMenuAction({ label, referencePosition, request }, show, footnote);
    return true;
  }

  private async applyFootnoteContextMenuAction(
    context: FootnoteContextSelection,
    show: ScientMarkdownFootnoteContextMenuHandler,
    anchor: HTMLElement,
  ): Promise<void> {
    let action: ScientMarkdownFootnoteContextMenuAction | null;
    try {
      action = await show(context.request);
    } catch {
      return;
    }
    const view = this.editorView;
    if (!view || action === null) return;
    const reference = view.state.doc.nodeAt(context.referencePosition);
    if (
      !reference ||
      reference.type !== scientMarkdownSchema.nodes.footnote_reference ||
      String(reference.attrs.label) !== context.label
    ) {
      return;
    }
    const entry = scientMarkdownFootnotePresentation(view.state.doc).get(context.label);
    if (!entry) return;

    if (action === "go-to-footnote") {
      if (entry.definitionPosition !== null) {
        this.focusFootnoteDom(entry.definitionPosition, false);
      }
      return;
    }
    if (action === "copy-link") {
      if (!context.request.canCopy || entry.definitionPosition === null) return;
      this.options.onCopyLink?.(
        {
          format: "link",
          value: `#${scientMarkdownFootnoteDefinitionId(context.label)}`,
        },
        anchor,
      );
      return;
    }
    if (!modeIsEditable(this.mode)) return;
    if (action === "remove-reference") {
      view.dispatch(
        closeHistory(
          view.state.tr.delete(
            context.referencePosition,
            context.referencePosition + reference.nodeSize,
          ),
        ),
      );
      view.focus();
      return;
    }
    if (
      action === "delete-footnote" &&
      entry.definitionPosition !== null &&
      entry.referencePositions.length === 1
    ) {
      const definition = view.state.doc.nodeAt(entry.definitionPosition);
      if (!definition || definition.type !== scientMarkdownSchema.nodes.footnote_definition) return;
      const ranges = [
        { from: context.referencePosition, to: context.referencePosition + reference.nodeSize },
        { from: entry.definitionPosition, to: entry.definitionPosition + definition.nodeSize },
      ].sort((left, right) => right.from - left.from);
      let transaction = view.state.tr;
      ranges.forEach((range) => {
        transaction = transaction.delete(range.from, range.to);
      });
      view.dispatch(closeHistory(transaction));
      view.focus();
    }
  }

  private handleLinkContextMenu(event: MouseEvent): boolean {
    const view = this.editorView;
    const show = this.options.showLinkContextMenu;
    if (!view || !show || !(event.target instanceof Element)) return false;

    const wikiElement = event.target.closest<HTMLElement>("[data-scient-markdown-wiki-link]");
    const ordinaryElement = event.target.closest<HTMLAnchorElement>("a[href]");
    let request: ScientMarkdownLinkContextMenuRequest | null = null;
    let requestAnchor: HTMLElement | null = null;

    if (wikiElement && view.dom.contains(wikiElement)) {
      const nodePosition = this.wikiLinks.get(wikiElement)?.();
      const node = nodePosition === undefined ? null : view.state.doc.nodeAt(nodePosition);
      if (
        nodePosition === undefined ||
        node === null ||
        node.type !== scientMarkdownSchema.nodes.wiki_link
      ) {
        return false;
      }
      view.dispatch(
        view.state.tr
          .setSelection(
            TextSelection.create(view.state.doc, nodePosition, nodePosition + node.nodeSize),
          )
          .setMeta(scientMarkdownTransactionOriginKey, "system")
          .setMeta("addToHistory", false),
      );
      request = {
        canCopy: this.options.onCopyLink !== undefined,
        canOpen: this.options.onOpenWikiLink !== undefined,
        editable: modeIsEditable(this.mode),
        fullPath:
          this.options.resolveLinkFullPath?.("wiki-link", String(node.attrs.target)) ?? null,
        kind: "wiki-link",
        position: { x: event.clientX, y: event.clientY },
        target: String(node.attrs.target),
      };
      requestAnchor = wikiElement;
    } else if (ordinaryElement && view.dom.contains(ordinaryElement)) {
      let documentPosition: number;
      try {
        documentPosition = view.posAtDOM(ordinaryElement, 0);
      } catch {
        return false;
      }
      const link = markdownLinkAtPosition(view.state, documentPosition);
      if (!link) return false;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, link.from, link.to))
          .setMeta(scientMarkdownTransactionOriginKey, "system")
          .setMeta("addToHistory", false),
      );
      request = {
        canCopy: this.options.onCopyLink !== undefined,
        canOpen: link.href.startsWith("#") || this.options.onOpenLink !== undefined,
        editable: modeIsEditable(this.mode),
        fullPath: this.options.resolveLinkFullPath?.("link", link.href) ?? null,
        kind: "link",
        position: { x: event.clientX, y: event.clientY },
        target: link.href,
      };
      requestAnchor = ordinaryElement;
    }

    if (!request || !requestAnchor) return false;
    event.preventDefault();
    event.stopPropagation();
    this.cancelPendingLinkOpen();
    this.stopTrackingLinkPointer();
    void this.applyLinkContextMenuAction(request, show, requestAnchor);
    return true;
  }

  private async applyLinkContextMenuAction(
    request: ScientMarkdownLinkContextMenuRequest,
    show: NonNullable<ScientMarkdownEditorViewOptions["showLinkContextMenu"]>,
    anchor: HTMLElement,
  ): Promise<void> {
    let action: ScientMarkdownLinkContextMenuAction | null;
    try {
      action = await show(request);
    } catch {
      return;
    }
    if (action === null || !this.editorView) return;

    if (action === "open") {
      if (!request.canOpen) return;
      if (request.kind === "wiki-link") this.options.onOpenWikiLink?.(request.target, anchor);
      else this.openLinkTarget(request.target, anchor);
      return;
    }
    if (action === "copy-link" || action === "copy-full-path") {
      if (!request.canCopy) return;
      const value = action === "copy-link" ? request.target : request.fullPath;
      if (value === null) return;
      this.options.onCopyLink?.(
        {
          format: action === "copy-link" ? "link" : "full-path",
          value,
        },
        anchor,
      );
      return;
    }
    if (!modeIsEditable(this.mode) || !this.contextLinkSelectionMatches(request)) return;
    if (action === "remove") {
      if (request.kind === "wiki-link") this.removeWikiLink();
      else this.removeLink();
      return;
    }
    if (action === "edit") {
      if (request.kind === "wiki-link") this.wikiLinkEditRequest += 1;
      else this.linkEditRequest += 1;
      this.publishSnapshot(false);
    }
  }

  private contextLinkSelectionMatches(request: ScientMarkdownLinkContextMenuRequest): boolean {
    const view = this.editorView;
    if (!view) return false;
    if (request.kind === "wiki-link") {
      return resolveWikiLinkSelection(view.state)?.target === request.target;
    }
    return selectedMarkdownLink(view.state)?.href === request.target;
  }

  private handleTableContextMenu(event: MouseEvent): boolean {
    const view = this.editorView;
    const show = this.options.showTableContextMenu;
    if (!view || !show || !modeIsEditable(this.mode) || !(event.target instanceof Element)) {
      return false;
    }
    if (event.target.closest("a[href], [data-scient-markdown-wiki-link]")) return false;

    const handle = event.target.closest<HTMLElement>(".scient-markdown-table-select");
    const cell = event.target.closest<HTMLTableCellElement>("td, th");
    const anchor = handle ?? cell;
    const wrapper = anchor?.closest<HTMLElement>(".scient-markdown-table");
    if (!anchor || !wrapper || !view.dom.contains(wrapper)) return false;

    // Selected prose keeps the platform text menu. The explicit table handle
    // remains available when the author wants structural actions instead.
    if (!handle && view.state.selection instanceof TextSelection && !view.state.selection.empty) {
      return false;
    }

    if (cell) {
      let documentPosition: number;
      try {
        documentPosition = view.posAtDOM(cell, 0);
      } catch {
        return false;
      }
      const $cell = cellAround(view.state.doc.resolve(documentPosition));
      if (!$cell) return false;
      if (!selectionIncludesTableCell(view.state.selection, $cell.pos)) {
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, $cell.pos + 1))
            .setMeta(scientMarkdownTransactionOriginKey, "system")
            .setMeta("addToHistory", false),
        );
      }
    }

    const table = findTable(view.state.selection.$from);
    if (!table) return false;
    const context: TableContextSelection = {
      from: view.state.selection.from,
      tablePosition: table.pos,
      to: view.state.selection.to,
    };
    event.preventDefault();
    event.stopPropagation();
    this.cancelPendingLinkOpen();
    this.stopTrackingLinkPointer();
    void this.applyTableContextMenuAction(context, show, contextMenuPosition(event, anchor));
    return true;
  }

  private async applyTableContextMenuAction(
    context: TableContextSelection,
    show: NonNullable<ScientMarkdownEditorViewOptions["showTableContextMenu"]>,
    position: { readonly x: number; readonly y: number },
  ): Promise<void> {
    let action: ScientMarkdownTableContextMenuAction | null;
    try {
      action = await show(position);
    } catch {
      return;
    }
    if (
      action === null ||
      !modeIsEditable(this.mode) ||
      !this.tableContextSelectionMatches(context)
    ) {
      return;
    }
    this.execute(action);
  }

  private tableContextSelectionMatches(context: TableContextSelection): boolean {
    const view = this.editorView;
    if (
      !view ||
      view.state.selection.from !== context.from ||
      view.state.selection.to !== context.to
    ) {
      return false;
    }
    return findTable(view.state.selection.$from)?.pos === context.tablePosition;
  }

  private readonly handleLinkPointerMove = (event: MouseEvent) => {
    if (
      this.linkPointerOrigin &&
      (Math.abs(event.clientX - this.linkPointerOrigin.x) > 4 ||
        Math.abs(event.clientY - this.linkPointerOrigin.y) > 4)
    ) {
      this.linkPointerDragged = true;
    }
  };

  private readonly handleLinkPointerUp = () => {
    this.stopTrackingLinkPointer();
  };

  private stopTrackingLinkPointer(): void {
    this.linkPointerOrigin = null;
    const ownerDocument = this.editorView?.dom.ownerDocument;
    ownerDocument?.removeEventListener("mousemove", this.handleLinkPointerMove);
    ownerDocument?.removeEventListener("mouseup", this.handleLinkPointerUp);
  }

  private cancelPendingLinkOpen(): void {
    if (this.pendingLinkOpen === null) return;
    globalThis.clearTimeout(this.pendingLinkOpen);
    this.pendingLinkOpen = null;
  }

  private openLinkTarget(target: string, anchor: HTMLElement): boolean {
    if (target.startsWith("#") && this.navigateToHeadingFragment(target.slice(1))) {
      this.options.onLocalHeadingOpened?.();
      return true;
    }
    if (!this.options.onOpenLink) return false;
    this.options.onOpenLink(target, anchor);
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

  private refreshFootnoteNodeViews(): void {
    if (this.footnoteNodeViews.size === 0) return;
    const presentation = scientMarkdownFootnotePresentation(
      this.editorView?.state.doc ?? this.session.state.doc,
    );
    this.footnoteNodeViews.forEach((registration) => registration.refresh(presentation));
  }

  private focusSelectedFootnoteDefinition(): void {
    const view = this.editorView;
    const selection = view?.state.selection;
    if (
      !view ||
      !(selection instanceof NodeSelection) ||
      selection.node.type !== scientMarkdownSchema.nodes.footnote_definition
    ) {
      return;
    }
    this.focusFootnoteDom(selection.from, true);
  }

  private focusFootnoteDom(position: number, focusDefinitionEditor: boolean): void {
    queueMicrotask(() => {
      const view = this.editorView;
      const dom = view?.nodeDOM(position);
      if (!view || !(dom instanceof HTMLElement)) return;
      dom.scrollIntoView?.({ block: "center" });
      const editor = dom.querySelector<HTMLTextAreaElement>(".scient-markdown-reference-source");
      if (focusDefinitionEditor && modeIsEditable(this.mode) && editor) {
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(editor.value.length, editor.value.length);
        return;
      }
      const marker = dom.querySelector<HTMLButtonElement>(".scient-markdown-footnote-marker");
      (marker ?? dom).focus({ preventScroll: true });
    });
  }

  private syncNodeViewEditability(): void {
    const editable = modeIsEditable(this.mode);
    this.codeEditors.forEach((editor) => {
      editor.setEditable(editable);
    });
    this.rawSourceEditors.forEach((editor) => {
      editor.readOnly = !editable;
    });
    this.taskCheckboxes.forEach((checkbox) => {
      checkbox.disabled = !editable;
    });
    this.wikiLinks.forEach((_getPos, link) => {
      // In an editable document, Tab belongs to text/list/table navigation;
      // readers can still keyboard-activate links in read mode.
      link.tabIndex = editable ? -1 : 0;
    });
    this.footnoteNodeViews.forEach((registration) => registration.setEditable(editable));
    this.imageNodeViews.forEach((registration) => registration.setEditable(editable));
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
        (node.type.name === "paragraph" ||
          node.type.name === "heading" ||
          node.type.name === "table")
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
    const wikiLinkSelection = resolveWikiLinkSelection(state);
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
      canSetWikiLink: modeIsEditable(this.mode) && wikiLinkSelection !== null,
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
      linkEditRequest: this.linkEditRequest,
      outlineActiveIndex,
      textDirection,
      outlineItems,
      selectionEmpty: selection.empty,
      selectedWikiLinkTarget: wikiLinkSelection?.target ?? null,
      slashActiveIndex: Math.min(this.slashActiveIndex, Math.max(0, slashItems.length - 1)),
      slashQuery,
      tableAlignment,
      version: this.snapshotVersion,
      wikiLinkEditRequest: this.wikiLinkEditRequest,
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
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const image = this.selectedImageView();
      if (image?.showContextMenu(new MouseEvent("contextmenu"))) {
        event.preventDefault();
        return true;
      }
    }
    if (matchesScientMarkdownShortcut(event, "find")) {
      event.preventDefault();
      this.requestFind();
      return true;
    }
    if (matchesScientMarkdownShortcut(event, "link")) {
      if (!this.requestLinkEdit()) return false;
      event.preventDefault();
      return true;
    }
    if (matchesScientMarkdownShortcut(event, "duplicateBlock")) {
      const handled = this.executeBlock("duplicate");
      if (handled) event.preventDefault();
      return handled;
    }
    if (matchesScientMarkdownShortcut(event, "moveBlockUp")) {
      const handled = this.executeBlock("move-up");
      if (handled) event.preventDefault();
      return handled;
    }
    if (matchesScientMarkdownShortcut(event, "moveBlockDown")) {
      const handled = this.executeBlock("move-down");
      if (handled) event.preventDefault();
      return handled;
    }
    if (event.key === "Escape" && this.findOpen) {
      event.preventDefault();
      this.closeFind();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && this.focusSelectedSourceField()) {
      event.preventDefault();
      return true;
    }
    return this.handleSlashKeyDown(event);
  }

  /**
   * Enter on a selected source-like atom (citation, math, raw source island,
   * footnote definition) moves the caret into its one editable field, the
   * keyboard counterpart of clicking it. Escape in that field leaves again.
   * Code blocks focus their nested editor on selection and never reach here.
   */
  private focusSelectedSourceField(): boolean {
    const view = this.editorView;
    if (!view || !modeIsEditable(this.mode)) return false;
    const { selection } = view.state;
    if (!(selection instanceof NodeSelection) || !selection.node.isAtom) return false;
    const dom = view.nodeDOM(selection.from);
    if (!(dom instanceof HTMLElement)) return false;
    const image = this.imageNodeViews.get(dom);
    if (image) {
      image.editDetails();
      return true;
    }
    // Source fields opt into this keyboard contract explicitly. Nested inputs
    // such as image controls and task checkboxes own different interactions.
    const field = Array.from(dom.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.getAttribute("data-scient-markdown-atom-editor") === "true",
    );
    if (!field || field.hidden) return false;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.readOnly || (field instanceof HTMLInputElement && field.type !== "text")) {
        return false;
      }
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
      return true;
    }
    // Persistent raw-source CodeMirror hosts redirect this focus to their
    // nested content without exposing CodeMirror internals to the controller.
    field.focus({ preventScroll: true });
    return true;
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
