import { TextMenu, TextMenuItems } from "../writing/TextMenu";
import { LatexStructuredSelection } from "./latexStructuredSelection";
import { latexSelectionCommand, runLatexSelectionCommand } from "./latexSelectionSession";
import { installLatexTextSelectionSession } from "./latexTextSelectionSession";
import { latexVisualNodeSignature } from "./latexVisualDocument";
import { randomUUID } from "~/lib/utils";
import { LatexMathMenuItems, LATEX_CASES_TEMPLATE } from "./LatexMathMenuItems";
import { LatexLongTableBand, type LongTableBand } from "./LatexLongTableBand";
import { latexRunningPageStyle, latexRunningPageFields } from "./latexPageLayouts";
import {
  activateLatexContext,
  isLatexEditingMenuEvent,
  latexContextRoot,
  latexSelectEventOwner,
} from "./latexContextEvents";
import type { JSONContent } from "@tiptap/core";
import { matrixEdit, type MatrixAction, type MatrixEnvironment } from "../math/input/matrix";
import { customMathEdit } from "../keyboard/customMath";
import { attachShortcutHost } from "../keyboard/host";
import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import { commandEdit, mathCommand } from "../math/input/catalog";
import { WritingShortcutsDialog } from "../keyboard/WritingShortcutsDialog";
import { Extension, Mark, Node, type Editor } from "@tiptap/core";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  EditorContent,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { LATEX_CANVAS_TEXT_MARKS } from "./latexTextFormatting";
import {
  LATEX_DIRECTION_MARKS,
  latexDocumentLanguage,
  latexLanguageFont,
  latexLanguageLabels,
} from "./latexLanguage";
import { LatexLanguageContext } from "./LatexLanguageContext";
import "./latexDirection.css";
import type { NodeViewProps } from "@tiptap/react";
import {
  Fragment,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { refreshProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

import { EditorState, Plugin, NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { LatexTitleStep } from "./LatexTitleStep";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { LatexReferenceLabelControl } from "./LatexReferenceLabelControl";
import { LatexSourceResizeHandle } from "./LatexSourceResizeHandle";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { EditorView } from "@tiptap/pm/view";
import { LatexInsertMenu, LatexInsertMenuContent, type LatexInsertAction } from "./LatexInsertMenu";
import { LatexDocumentSettings, type LatexDocumentSettingsSection } from "./LatexDocumentSettings";
import { LatexContextTools } from "./LatexContextTools";
import { DocumentReaderControls, type ReaderSearch } from "../writing/DocumentReaderControls";
import { LatexPageThumbnails } from "./LatexPageThumbnails";
import { ScientFindBar } from "../writing/ScientFindBar";
import { ReaderBarHostContext, useHostedReaderShortcuts } from "../writing/readerBarHost";
import { DocumentFooter } from "../writing/DocumentFooter";
import { countSelectedWords } from "../writing/caretStatus";
import { countLatexWords } from "./latexWordCount";
import { commandShortcut, menuShortcut } from "../keyboard/presentation";
import { WritingCommandIcon } from "../writing/commandIcons";
import { WRITING_COMMAND_LABELS } from "../writing/commandNames";
import { scientMarkdownShortcut } from "../markdownEditor/shortcuts";
import {
  DockButton,
  DockOverflowRow,
  DockDivider,
  MenuRow,
  DockMenu,
  DockCommandItem,
  dockButtonClass,
  DockCommandRadioItem,
  DockCommandCheckboxItem,
} from "../writing/dockChrome";
import {
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuRadioGroup,
  MenuCheckboxItem,
  MenuSeparator,
} from "~/components/ui/menu";
import "../markdownEditor/scient-markdown-editor.css";
import { LatexReferenceDialog } from "./LatexReferenceDialog";
import { bibliographyChangePublished, mergeBibliographyChange } from "./latexBibliographyModel";
import {
  LatexReferencesPanel,
  type BibliographyDetails,
  type BibliographyDocument,
  type ReferenceFileCallbacks,
} from "./LatexReferencesPanel";
import { LatexFigureInsertDialog } from "./LatexFigureInsertDialog";
import { LatexFigureArtwork } from "./LatexFigureArtwork";
import { LatexTikzArtwork } from "./LatexTikzView";
import { LatexColorBoxView } from "./LatexColorBoxView";
import {
  LatexAlgorithmView,
  LatexAlgorithmLine,
  LatexAlgorithmComment,
} from "./LatexAlgorithmView";
import { latexColorCss, latexDocumentColors, latexColorBoxOpening } from "./latexColorBoxes";
import { LatexObjectMathField } from "./LatexObjectMathField";
import { LatexInlineField } from "./LatexInlineField";
import {
  latexEditingTarget,
  LatexInlineOwnerContext,
  useLatexEditingState,
} from "./latexEditingTarget";
import { LatexWritingKeys } from "./latexWritingKeys";
import { LatexProseCompletion } from "./latexProseCompletion";
import { LatexCommandContext } from "./LatexCompletionContext";
import { latexTableMathCell, latexTableCellIsMath } from "./latexVisualDocument";
import { LatexProsePreview } from "./LatexProsePreview";
import { latexFigureSource } from "./figureSource";
import { uploadLatexImage } from "./imageUpload";
import {
  addLatexImageUpload,
  latexImageUploadBookmark,
  latexImageUploads,
  removeLatexImageUpload,
} from "./latexImageUploads";
import { hasLatexGuidance, latexGuidancePlaceholders } from "./latexGuidance";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { LatexMathPalette } from "./LatexMathPalette";
import { LatexMatrixDialog } from "./LatexMatrixDialog";
import type { MathSymbol } from "./mathSymbols";
import { LatexTextField, LatexDraftContext, replaceLatexFieldDraft } from "./LatexTextField";
import { LatexLiteralCodeView } from "./LatexLiteralCodeView";
import {
  inlineLatexLiteralSource,
  latexListingDefaults,
  type LatexListingPresentation,
} from "./latexLiteral";
import { useLatexTableSelection, tableSelectionContains } from "./useLatexTableSelection";
import { installLatexTableEditingGuides } from "./latexTableEditingGuides";
import { latexDocumentObjectSelection } from "./latexDocumentObjectSelection";
import {
  captureLatexObjectDrag,
  latexObjectSelectionAtPointer,
  pointerInsideLatexObject,
  selectionIncludingLatexObject,
} from "./latexObjectSelection";
import { afterEditorPaint } from "./afterEditorPaint";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import { processVisualDocument } from "./visualProcessing";
import { latexNavigationEntries } from "./latexNavigationEntries";
import {
  enterLatexObjectBody,
  handleLatexObjectClick,
  preserveLatexCaret,
} from "./latexObjectCaret";
import {
  projectMathNumbering,
  singleMathReferenceLabel,
  withMathReferenceLabel,
  withMathNumbering,
} from "./latexMathNumbering";
import { alignedMathBody, isAlignedMath } from "./latexMathLayout";
import { LatexVisualRecoveryBar } from "./LatexVisualRecovery";
import {
  canApplyRecovery,
  isRecoveryStored,
  journalAppliedRecovery,
  parkUninstalledTypingDraft,
  parkUnpublishedSource,
  parkUnappliedInput,
  parkVisualFieldDrafts,
  readStartupRecovery,
  readStoredRecovery,
  removeRecovery,
  type LatexVisualRecovery,
} from "./visualRecovery";
import { discardTypingDraft, isSourceOwnedTyping, retainTypingDraft } from "./visualTyping";
import { latexProjectionSelection } from "./latexProjectionSelection";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { ReplacementImages } from "./LatexFigureToolbar";
import { relativeLatexImagePath } from "./figureSource";
import { latexProseCaretOffset } from "./latexProseCaret";
import { LatexFooterLabel } from "./LatexFooterLabel";
import { LatexLinkAddress } from "./LatexLinkAddress";
import { LatexCitationControls } from "./LatexCitationControls";
import { LatexCrossReferenceControl } from "./LatexCrossReferenceControl";
import { LatexStatementToolbar } from "./LatexStatementToolbar";
import { LatexStatementTitle } from "./LatexStatementTitle";
import { mathStructureCommandReason, type MathArrayContext } from "./mathLiveSelection";
import { LatexHeadingToolbar } from "./LatexHeadingToolbar";
import { LatexHeadingNumberButton } from "./LatexHeadingNumberButton";
import { changeLatexList, selectedLatexListType, type LatexListType } from "./latexListEditing";
import { latexListLabelPresentation, parseLatexListOptions } from "./latexListOptions";
import {
  latexEquationReferences,
  latexEquationReferencesKey,
  navigateToEquation,
  navigateToFootnote,
} from "./latexEquationReferences";
import { positionEquationNumbers } from "./mathEquationNumbers";
import { latexDocumentMathSetup } from "./latexDocumentMacros";
import { latexEnvironmentDeclarations } from "./latexEnvironmentDeclarations";
import { LatexDocumentMathContext } from "./LatexDocumentMathContext";
import { latexPreambleEnd } from "./latexPackages";
import { LatexTitleView } from "./LatexTitleView";
import { LatexTableToolbar } from "./LatexTableToolbar";
import { LatexFigureToolbar } from "./LatexFigureToolbar";
import { LatexLayoutControls } from "./LatexLayoutControls";
import { LatexCodeControls } from "./LatexCodeControls";
import { LatexListControls } from "./LatexListControls";
import { renameLatexLabel } from "./latexLabelAuthoring";
import { editLatexTable } from "./latexTableAuthoring";
import {
  LatexAuthoringContext,
  LatexDocumentAuthoring,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { insertLatexBlock } from "./latexInsertion";
import { LatexBibliographyDialog } from "./LatexBibliographyDialog";
import { LatexLinkDialog } from "./LatexLinkDialog";
import { withoutComments } from "./latexAuthoringModel";
import { LatexVisualSearch, useLatexVisualSearch } from "./useLatexVisualSearch";
import {
  clampPdfPage,
  stepPdfZoom,
  pdfFitWidthScale,
  PDF_FIT_WIDTH_PADDING,
} from "../pdf/pdfReaderModel";
import { useLatexPinchZoom } from "./useLatexPinchZoom";
import { Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, FileText } from "lucide-react";
import type { MathSourceCompletion } from "./latexMathCompletion";
import { installLatexTextareaCompletion } from "./latexTextCompletion";
import {
  LatexVisualPagination,
  createLatexVisualPagination,
  latexPaginationKey,
  latexObjectPageGaps,
  latexObjectContinuationHeights,
  latexVisualPageAt,
  latexVisualPageLabelAt,
  latexVisualPageLabels,
  setLatexPaginationDimensions,
} from "./latexVisualPaginationExtension";
import {
  CSS_PIXELS_PER_INCH,
  TEX_POINTS_PER_INCH,
  latexLengthInches,
  latexVisualFontMetrics,
} from "./latexVisualLayout";
import "katex/dist/katex-swap.min.css";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useAssetUrlState } from "~/assets/assetUrls";
import { checkpointVisualDraft, flushVisualDraft } from "./visualDrafts";

import {
  applyLatexVisualDocumentChange,
  escapeText,
  latexInlineCommandSource,
  latexCitationParts,
  metadataText,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualTablePresentation,
  latexVisualFloatHasCaption,
  latexVisualTableFormatting,
  latexTableSelectionBounds,
  latexVisualMathSource,
  serializeLatexVisualBlock,
  latexVisualTableCellsClipboard,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
  updateLatexVisualLayoutSource,
  prepareLatexDocumentTitle,
  projectLatexTitleSourceEdit,
  latexRomanNumber,
  LATEX_HEADING_STYLES,
  type LatexRootUpdate,
  type LatexTableCellLayout,
  type LatexFigurePanel,
  type LatexVisualDocument,
  type LatexVisualMathAttributes,
} from "./latexVisualDocument";

const LatexSourceAttributes = Extension.create({
  name: "latexSourceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          latexNoIndent: {
            default: false,
            parseHTML: (element) => element.hasAttribute("data-latex-noindent"),
            renderHTML: (attrs) => (attrs.latexNoIndent ? { "data-latex-noindent": "true" } : {}),
          },
        },
      },
      {
        types: ["paragraph", "heading", "bulletList", "orderedList", "blockquote"],
        attributes: {
          referenceLabel: { default: null, rendered: false },
          sourceId: { default: null, rendered: false },
          latexCommand: {
            default: null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.latexCommand
                ? { "data-latex-command": String(attributes.latexCommand) }
                : {},
          },
          unnumbered: {
            default: false,
            rendered: true,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.unnumbered === true ? { "data-latex-unnumbered": "" } : {},
          },
        },
      },
      {
        types: ["orderedList"],
        attributes: {
          resume: { default: false, rendered: false },
          latexListOptions: {
            default: null,
            renderHTML: (attributes: Record<string, unknown>) => {
              const options = parseLatexListOptions(String(attributes.latexListOptions ?? ""));
              const label = options?.label ? latexListLabelPresentation(options.label) : null;
              return label
                ? {
                    "data-latex-list-style": label.style,
                    style: `--scient-latex-list-prefix: ${JSON.stringify(label.prefix)}; --scient-latex-list-suffix: ${JSON.stringify(label.suffix)}`,
                  }
                : {};
            },
          },
        },
      },
    ];
  },
});

function useEditorEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      editor.on("update", changed);
      return () => {
        editor.off("update", changed);
      };
    },
    [editor],
  );
  return useSyncExternalStore(
    subscribe,
    () => editor.isEditable,
    () => false,
  );
}

interface ActiveMathEditor {
  id: string;
  insert: (tex: string) => void;
  changeType: (type: string) => void;
  command: LatexMathFieldHandle["command"];
  toggleTextFormat: LatexMathFieldHandle["toggleTextFormat"];
  textFormatActive: LatexMathFieldHandle["textFormatActive"];
  formattingAvailable: boolean;
  flush: () => boolean;
  dismiss: (keepDocumentSelection?: boolean) => void;
  focus: () => void;
  symbols: () => void;
  undo: (redo: boolean) => void;
}
/**
 * An object that knows where the caret is inside it (a table knows its cell)
 * tells the footer, which otherwise sees only that the object is selected.
 */
const LatexFooterPositionContext = createContext<(position: string | null) => void>(() => {});
const LatexMathEditingContext = createContext<{
  draftKey: string;
  get: () => ActiveMathEditor | null;
  activate: (controls: ActiveMathEditor) => void;
  update: (controls: ActiveMathEditor) => void;
  formatChanged: (id: string, state: string) => void;
  deactivate: (id: string) => void;
} | null>(null);

function mathFieldSource(tex: string, environment: string | null): string {
  const inner = environment?.startsWith("align")
    ? "aligned"
    : environment?.startsWith("gather")
      ? "gathered"
      : null;
  return inner ? `\\begin{${inner}}${tex}\\end{${inner}}` : tex;
}

function mathEnvironmentBody(tex: string, environment: string | null): string {
  const inner = environment?.startsWith("align")
    ? "aligned"
    : environment?.startsWith("gather")
      ? "gathered"
      : null;
  const opening = `\\begin{${inner}}`;
  const closing = `\\end{${inner}}`;
  return inner && tex.startsWith(opening) && tex.endsWith(closing)
    ? tex.slice(opening.length, -closing.length).trim()
    : tex;
}

function mathClipboardSource(
  source: string,
): { readonly display: boolean; readonly attributes: LatexVisualMathAttributes } | null {
  const inline = parseLatexVisualMathSource(source, false);
  if (inline) return { display: false, attributes: inline };
  const display = parseLatexVisualMathSource(source, true);
  if (display) return { display: true, attributes: display };
  const structured = parseStructuredMathEnvironment(source);
  return structured ? { display: true, attributes: { tex: structured, wrapper: "bracket" } } : null;
}

function latexClipboardBlocks(source: string): JSONContent[] | null {
  if (!/[\\$]/u.test(source)) return null;
  const parsed = projectLatexVisualDocument(source);
  if (parsed.rawBlocks > 0) return null;
  return (
    parsed.content.content?.map((node) => ({
      ...node,
      attrs: { ...node.attrs, sourceId: null },
    })) ?? null
  );
}

function latexSelectionClipboard(content: Slice): string {
  const fallback = () => content.content.textBetween(0, content.content.size, "\n\n");
  let containsStructuredContent = false;
  content.content.forEach((node) => {
    if (node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
      containsStructuredContent = true;
    if (node.type.name === "latexRichPreview" && node.attrs.kind === "table")
      containsStructuredContent = true;
    node.descendants((child) => {
      if (child.type.name === "latexInlineMath" || child.type.name === "latexDisplayMath")
        containsStructuredContent = true;
      if (child.type.name === "latexRichPreview" && child.attrs.kind === "table")
        containsStructuredContent = true;
    });
  });
  if (!containsStructuredContent) return fallback();
  const blocks: string[] = [];
  let inline: JSONContent[] = [];
  const flushInline = () => {
    if (!inline.length) return true;
    const serialized = serializeLatexVisualBlock({ type: "paragraph", content: inline });
    inline = [];
    if (serialized === null) return false;
    blocks.push(serialized);
    return true;
  };
  let supported = true;
  content.content.forEach((node) => {
    if (!supported) return;
    if (node.isInline) {
      inline.push(node.toJSON());
      return;
    }
    if (!flushInline()) {
      supported = false;
      return;
    }
    const serialized = serializeLatexVisualBlock(node.toJSON());
    if (serialized === null) supported = false;
    else blocks.push(serialized);
  });
  if (!supported || !flushInline()) return fallback();
  return blocks.join("\n\n");
}

function insertVisualMath(
  editor: Editor,
  display: boolean,
  tex = "",
  pastedAttributes?: LatexVisualMathAttributes,
): boolean {
  if (!editor.isEditable) return false;
  const type = display ? "latexDisplayMath" : "latexInlineMath";
  return editor
    .chain()
    .focus()
    .insertContent({
      type,
      attrs: pastedAttributes ?? { tex, wrapper: display ? "bracket" : "paren" },
    })
    .command(({ tr }) => {
      const caret = tr.selection.from;
      let nearestPosition = -1;
      let nearestDistance = Infinity;
      tr.doc.descendants((candidate, position) => {
        if (
          candidate.type.name !== type ||
          candidate.attrs.sourceId != null ||
          candidate.attrs.tex !== tex
        )
          return;
        const distance = Math.abs(position + candidate.nodeSize - caret);
        if (distance < nearestDistance) {
          nearestPosition = position;
          nearestDistance = distance;
        }
      });
      if (nearestPosition >= 0) tr.setSelection(NodeSelection.create(tr.doc, nearestPosition));
      return true;
    })
    .run();
}

function LatexMathView({
  node,
  updateAttributes,
  editor,
  getPos,
  selected,
  decorations,
}: NodeViewProps) {
  const activeMath = useContext(LatexMathEditingContext)!;
  const selectedByDocument = decorations.some(
    (decoration) => decoration.spec.latexDocumentSelected === true,
  );
  const controls = useRef<ActiveMathEditor | null>(null);
  const display = node.type.name === "latexDisplayMath";
  const editable = useEditorEditable(editor);
  const mathField = useRef<LatexMathFieldHandle>(null);
  const sourceEditor = useRef<HTMLTextAreaElement>(null);
  const activationId = useId();
  const mathRoot = useRef<HTMLDivElement>(null);
  const equationRows = useEditorState({
    editor: display ? editor : null,
    selector: ({ editor: current }) => {
      const position = getPos();
      return current && typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.equations.get(position) ?? null)
        : null;
    },
  });
  const hasEquationNumbers = display && equationRows?.some((row) => row.display !== null);
  useEffect(() => {
    const root = mathRoot.current;
    if (!root || !hasEquationNumbers || !equationRows) return;
    return positionEquationNumbers(root, equationRows.length);
  }, [hasEquationNumbers, equationRows]);
  const mathBar = useRef<HTMLDivElement>(null);
  const stopPointerSelection = useRef<(() => void) | null>(null);
  const mathPointerId = useRef<number | null>(null);
  const externalSelection = useRef<{ id: number; anchor: number } | null>(null);
  const stopExternalSelection = useRef<(() => void) | null>(null);
  const suppressSelectedActivation = useRef(false);
  const attributes = {
    tex: String(node.attrs.tex ?? ""),
    environment: node.attrs.environment ? String(node.attrs.environment) : null,
    wrapper: node.attrs.wrapper,
    numbering: node.attrs.numbering,
    numberingSource:
      typeof node.attrs.numberingSource === "string" ? node.attrs.numberingSource : null,
  } as const;
  const [editing, setEditing] = useState(false);
  const [dragOutside, setDragOutside] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [paletteRequest, setPaletteRequest] = useState(0);
  const [mathContext, setMathContext] = useState<MathArrayContext | null>(null);
  const setShortcutHint = useLatexActionNotice();
  const [draft, setDraft] = useState(attributes.tex);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const commandContext = useContext(LatexCommandContext);
  const completionContext = useRef(commandContext);
  useLayoutEffect(() => {
    completionContext.current = commandContext;
  }, [commandContext]);

  const dismiss = useCallback(
    (keepDocumentSelection = false) => {
      mathField.current?.clearSelection();
      if (!keepDocumentSelection && !editor.isDestroyed && activeMath.get()?.id === activationId) {
        const position = getPos();
        const selection = editor.state.selection;
        // Activation uses a node selection as the math field's edit anchor.
        // Release only that anchor, never a range made by dragging out of math.
        if (selection instanceof NodeSelection && selection.from === position)
          preserveLatexCaret(editor.view);
      }
      setEditing(false);
      setSourceOpen(false);
      setPaletteRequest(0);
      activeMath.deactivate(activationId);
    },
    [editor, getPos, activeMath, activationId],
  );

  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== activationId) dismiss();
    };
    const scope = latexContextRoot(editor.view.dom);
    scope.addEventListener("scient-latex-context-activate", deactivate);
    return () => scope.removeEventListener("scient-latex-context-activate", deactivate);
  }, [editor, activationId, dismiss]);

  const activate = (focus = true) => {
    if (!editable) return;
    const position = getPos();
    if (typeof position === "number" && editor.state.doc.nodeAt(position)) {
      const selection = editor.state.selection;
      if (!(selection instanceof NodeSelection && selection.from === position)) {
        suppressSelectedActivation.current = true;
        editor.view.dispatch(
          editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
        );
      }
    }
    activateLatexContext(editor.view.dom, activationId);
    setSourceOpen(false);
    setDraft(attributes.tex);
    setSourceError(null);
    setEditing(true);
    if (controls.current) activeMath.activate(controls.current);
    if (focus) requestAnimationFrame(() => mathField.current?.focus());
  };

  const activateRef = useRef(activate);
  useLayoutEffect(() => {
    activateRef.current = activate;
  });
  useEffect(() => {
    if (suppressSelectedActivation.current) {
      suppressSelectedActivation.current = false;
      return;
    }
    // Pointer interaction already belongs to MathLive; never replay focus after
    // it has placed the native caret or started a drag selection.
    if (selected && editable && !mathRoot.current?.contains(document.activeElement))
      activateRef.current();
  }, [selected, editable]);

  useEffect(() => {
    if (!editing) return;
    const outside = (event: Event) => {
      // Document focus is also used to extend a deliberate drag selection.
      if (
        event.type === "focusin" &&
        (event.target === editor.view.dom ||
          mathPointerId.current !== null ||
          externalSelection.current !== null)
      )
        return;
      const path = event.composedPath();
      const completionOwner = latexSelectEventOwner(event);
      if (
        path.includes(mathRoot.current!) ||
        path.includes(mathBar.current!) ||
        (completionOwner && mathRoot.current?.contains(completionOwner)) ||
        isLatexEditingMenuEvent(event, editor.view.dom)
      )
        return;
      // MathLive mounts command suggestions on document.body, outside the node.
      if (
        path.some(
          (target) => target instanceof Element && target.id === "mathlive-suggestion-popover",
        )
      )
        return;
      dismiss(
        event instanceof PointerEvent &&
          event.shiftKey &&
          event.target instanceof Element &&
          editor.view.dom.contains(event.target),
      );
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [editing, editor, dismiss]);

  useEffect(
    () => () => {
      stopPointerSelection.current?.();
      stopExternalSelection.current?.();
      activeMath.deactivate(activationId);
    },
    [activeMath, activationId],
  );

  const finish = (direction: -1 | 1 = 1) => {
    if (!mathField.current?.flush()) return;
    mathField.current.clearSelection();
    activeMath.deactivate(activationId);
    setEditing(false);
    setSourceOpen(false);
    setPaletteRequest(0);
    const position = getPos();
    if (position === undefined || editor.isDestroyed) return;
    const current = editor.state.doc.nodeAt(position);
    if (!current) return;
    const boundary = direction > 0 ? position + current.nodeSize : position;
    const transaction = editor.state.tr;
    const adjacent =
      direction > 0
        ? transaction.doc.resolve(boundary).nodeAfter
        : transaction.doc.resolve(boundary).nodeBefore;
    if (display && !adjacent?.isTextblock && editor.isEditable) {
      const paragraph = editor.schema.nodes.paragraph!.create();
      transaction.insert(boundary, paragraph);
      transaction.setSelection(TextSelection.create(transaction.doc, boundary + 1));
    } else {
      transaction.setSelection(Selection.near(transaction.doc.resolve(boundary), direction));
    }
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.focus();
  };

  const extendOutside = (direction: -1 | 1) => {
    const position = getPos();
    if (position === undefined || editor.isDestroyed) return false;
    const doc = editor.state.doc;
    const current = doc.nodeAt(position);
    if (!current) return false;
    const end = position + current.nodeSize;
    const anchor = direction > 0 ? position : end;
    const head = direction > 0 ? end : position;
    const nextSelection = selectionIncludingLatexObject(doc, position, anchor, head, direction);
    suppressSelectedActivation.current = nextSelection instanceof NodeSelection;
    mathField.current?.clearSelection();
    editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
    activeMath.deactivate(activationId);
    setEditing(false);
    setPaletteRequest(0);
    editor.view.focus();
    return true;
  };

  const startPointerSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      !editable ||
      !event.nativeEvent
        .composedPath()
        .some((target) => target instanceof Element && target.tagName === "MATH-FIELD")
    )
      return;
    stopPointerSelection.current?.();
    mathPointerId.current = event.pointerId;
    const pointerId = event.pointerId;
    let outside = false;
    const move = (movement: PointerEvent) => {
      const field = mathRoot.current?.querySelector("math-field");
      const rect = field?.getBoundingClientRect();
      if (!rect) return;
      if (pointerInsideLatexObject(movement, rect)) {
        if (outside) {
          outside = false;
          setDragOutside(false);
          // The math field still owns the original drag anchor. Restoring its
          // focus lets its pointer handler derive the smaller selection again.
          mathField.current?.focus();
        }
        return;
      }
      const position = getPos();
      if (position === undefined || editor.isDestroyed) return;
      const nextSelection = latexObjectSelectionAtPointer(editor.view, position, movement, rect);
      if (!nextSelection) return;
      suppressSelectedActivation.current = nextSelection instanceof NodeSelection;
      if (!outside) {
        outside = true;
        setDragOutside(true);
        mathField.current?.clearSelection();
        editor.view.focus();
      }
      movement.preventDefault();
      // Once the drag leaves the field, document selection owns the gesture;
      // the field's selection handler must not repaint a partial formula over it.
      movement.stopImmediatePropagation();
      editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
    };
    const stop = () => {
      const endedOutside = outside;
      stopPointerSelection.current = null;
      mathPointerId.current = null;
      if (endedOutside) {
        mathField.current?.cancelPointerSelection();
        mathField.current?.clearSelection();
        setDragOutside(false);
        activeMath.deactivate(activationId);
        setEditing(false);
        setPaletteRequest(0);
        editor.view.focus();
      }
    };
    const release = captureLatexObjectDrag(pointerId, move, stop);
    stopPointerSelection.current = () => {
      release();
      mathPointerId.current = null;
      setDragOutside(false);
    };
  };

  const selectThroughMath = (anchor: number) => {
    const position = getPos();
    if (typeof position !== "number" || editor.isDestroyed) return;
    const doc = editor.state.doc;
    const current = doc.nodeAt(position);
    if (!current) return;
    const end = position + current.nodeSize;
    if (anchor >= position && anchor <= end) return;
    const head = anchor < position ? end : position;
    const selection = selectionIncludingLatexObject(
      doc,
      position,
      anchor,
      head,
      anchor < position ? 1 : -1,
    );
    if (selection.from <= position && selection.to >= end && !editor.state.selection.eq(selection))
      editor.view.dispatch(editor.state.tr.setSelection(selection));
  };

  const extendExternalSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (!(event.buttons & 1) || event.pointerId === mathPointerId.current) return;
    if (externalSelection.current && externalSelection.current.id !== event.pointerId)
      stopExternalSelection.current?.();
    const position = getPos();
    if (typeof position !== "number") return;
    const anchor =
      externalSelection.current?.id === event.pointerId
        ? externalSelection.current.anchor
        : editor.state.selection.anchor;
    if (anchor >= position && anchor <= position + node.nodeSize) return;
    if (!externalSelection.current) {
      const pointerId = event.pointerId;
      const release = (finished: PointerEvent) => {
        if (finished.pointerId !== pointerId) return;
        const pending = externalSelection.current;
        stopExternalSelection.current?.();
        if (!pending || finished.type !== "pointerup") return;
        const bounds = mathRoot.current?.getBoundingClientRect();
        if (
          bounds &&
          finished.clientX >= bounds.left &&
          finished.clientX <= bounds.right &&
          finished.clientY >= bounds.top &&
          finished.clientY <= bounds.bottom
        )
          queueMicrotask(() => selectThroughMath(pending.anchor));
      };
      stopExternalSelection.current = () => {
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", release, true);
        externalSelection.current = null;
        stopExternalSelection.current = null;
      };
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", release, true);
    }
    if (!externalSelection.current) {
      mathField.current?.clearSelection();
      activeMath.deactivate(activationId);
      setEditing(false);
      setPaletteRequest(0);
      editor.view.focus();
    }
    externalSelection.current = { id: event.pointerId, anchor };
    selectThroughMath(anchor);
    event.preventDefault();
    event.stopPropagation();
  };

  const publishSource = (value: string) => {
    if (!editor.isEditable) return;
    const tex = display ? value.trim() : value;
    const parsed = parseLatexVisualMathSource(
      latexVisualMathSource({ ...attributes, tex }, display),
      display,
    );
    if (!parsed) {
      setSourceError(
        "Not saved: numbering, labels and command definitions belong in the document source.",
      );
      return;
    }
    // Keep half-typed delimiters local instead of sending a rejected edit to
    // the document and showing a document-wide warning on every keystroke.
    const projected = projectLatexVisualDocument(
      latexVisualMathSource({ ...attributes, tex }, display),
    ).content.content;
    const formula = display ? projected?.[0] : projected?.[0]?.content?.[0];
    if (
      projected?.length !== 1 ||
      (!display && projected[0]?.content?.length !== 1) ||
      formula?.type !== node.type.name ||
      String(formula.attrs?.tex ?? "").trim() !==
        (attributes.numberingSource ? (projectMathNumbering(tex)?.tex ?? tex) : tex).trim()
    ) {
      setSourceError(
        attributes.numberingSource
          ? "Keep the existing equation rows and label positions to save. Your input is kept here."
          : "Not saved yet. Complete the formula without its outer math delimiters.",
      );
      return;
    }
    updateAttributes({ tex });
    const position = getPos();
    const accepted = position === undefined ? null : editor.state.doc.nodeAt(position);
    setSourceError(
      accepted?.attrs.tex === tex
        ? null
        : "Not saved yet. Keep only the formula here; change its type using the selector.",
    );
  };

  const applyCompletion = (completion: MathSourceCompletion) => {
    const previous = sourceEditor.current?.value ?? draft;
    const next =
      previous.slice(0, completion.from) + completion.replacement + previous.slice(completion.to);
    const nextCaret = completion.from + completion.caret;
    setDraft(next);
    if (sourceEditor.current) {
      sourceEditor.current.value = next;
      sourceEditor.current.setSelectionRange(nextCaret, nextCaret);
    }
    publishSource(next);
    requestAnimationFrame(() => {
      sourceEditor.current?.focus();
      sourceEditor.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const completionApply = useRef(applyCompletion);
  useLayoutEffect(() => {
    completionApply.current = applyCompletion;
  });
  useEffect(() => {
    const field = sourceEditor.current;
    if (!editing || !sourceOpen || !field) return;
    return installLatexTextareaCompletion(
      field,
      (choice) => completionApply.current(choice),
      () => completionContext.current,
    );
  }, [editing, sourceOpen]);

  const changeType = (value: string) => {
    if (!value.startsWith("inline-") && !editor.schema.nodes.latexDisplayMath) {
      setShortcutHint("Use inline math inside a table cell.");
      return;
    }
    if (attributes.numberingSource) {
      setSourceError(
        "Change the equation type in Source to keep its labels and numbering commands.",
      );
      return;
    }
    if (!mathField.current?.flush()) return;
    const position = getPos();
    if (position === undefined) return;
    const current = editor.state.doc.nodeAt(position);
    if (!current) return;
    const inline = value.startsWith("inline-");
    const align = value === "aligned-equations";
    if (align && isAlignedMath(String(current.attrs.tex ?? ""), attributes.environment)) return;
    const environment = align
      ? "align*"
      : value.startsWith("environment:")
        ? value.slice("environment:".length)
        : null;
    const nextAttributes = {
      tex: align
        ? alignedMathBody(mathFieldSource(String(current.attrs.tex ?? ""), attributes.environment))
        : mathEnvironmentBody(
            mathFieldSource(String(current.attrs.tex ?? ""), attributes.environment),
            environment,
          ),
      environment,
      wrapper:
        value === "inline-dollar"
          ? "dollar"
          : value === "display-dollar"
            ? "double-dollar"
            : inline
              ? "paren"
              : "bracket",
    } as const;
    if (inline === !display) {
      updateAttributes(nextAttributes);
      setDraft(nextAttributes.tex);
      setSourceError(null);
      return;
    }
    if (display) {
      const inlineNode = editor.schema.nodes.latexInlineMath?.create(nextAttributes);
      const paragraph = inlineNode ? editor.schema.nodes.paragraph?.create(null, inlineNode) : null;
      if (paragraph) {
        const transaction = editor.state.tr.replaceWith(
          position,
          position + node.nodeSize,
          paragraph,
        );
        transaction.setSelection(NodeSelection.create(transaction.doc, position + 1));
        editor.view.dispatch(transaction);
      }
      return;
    }
    const resolved = editor.state.doc.resolve(position);
    if (resolved.parent.type.name !== "paragraph") {
      setSourceError("Move this formula into normal text before making it a separate equation.");
      return;
    }
    const displayNode = editor.schema.nodes.latexDisplayMath?.create(nextAttributes);
    if (displayNode) {
      const before = resolved.parent.cut(0, resolved.parentOffset);
      const after = resolved.parent.cut(resolved.parentOffset + current.nodeSize);
      const nodes = [
        ...(before.content.size ? [before] : []),
        displayNode,
        ...(after.content.size ? [after] : []),
      ];
      const transaction = editor.state.tr.replaceWith(resolved.before(), resolved.after(), nodes);
      transaction.setSelection(
        NodeSelection.create(
          transaction.doc,
          resolved.before() + (before.content.size ? before.nodeSize : 0),
        ),
      );
      editor.view.dispatch(transaction);
    }
  };

  useLayoutEffect(() => {
    const next: ActiveMathEditor = {
      id: activationId,
      insert: (tex) => {
        setSourceOpen(false);
        mathField.current?.insert(tex);
      },
      changeType,
      command: (command) => mathField.current?.command(command) ?? false,
      toggleTextFormat: (format) =>
        !sourceOpen && (mathField.current?.toggleTextFormat(format) ?? false),
      textFormatActive: (format) => mathField.current?.textFormatActive(format) ?? false,
      formattingAvailable: !sourceOpen,
      flush: () => mathField.current?.flush() ?? false,
      dismiss,
      focus: () => mathField.current?.focus(),
      undo: (redo) => {
        mathField.current?.command(redo ? "redo" : "undo");
      },
      symbols: () => {
        setSourceOpen(false);
        setPaletteRequest((value) => value + 1);
      },
    };
    controls.current = next;
    activeMath.update(next);
  });

  const sourceShortcut = useRef<(id: string) => boolean>(() => false);
  sourceShortcut.current = (id) => {
    const field = sourceEditor.current;
    if (!field || !editor.isEditable) return false;
    if (id === "math.palette") {
      setSourceOpen(false);
      setPaletteRequest((value) => value + 1);
      return true;
    }
    if (id === "math.inline" || id === "math.display") {
      changeType(id === "math.inline" ? "inline-paren" : "display-bracket");
      return true;
    }
    const source = field.value;
    const selection = { from: field.selectionStart, to: field.selectionEnd };
    const custom = getKeyboardPreferences().preferences.customMath?.find(
      (entry) => entry.id === id,
    );
    const command = mathCommand(id);
    const edit = custom
      ? customMathEdit(custom, source, selection)
      : command
        ? commandEdit(command, source, selection)
        : id.startsWith("math.matrix.")
          ? matrixEdit(source, selection, id.slice("math.matrix.".length) as MatrixAction, display)
          : null;
    if (!edit) return false;
    const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    setDraft(next);
    publishSource(next);
    requestAnimationFrame(() => {
      if (sourceEditor.current !== field || field.value !== next) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(edit.selection.from, edit.selection.to);
    });
    return true;
  };
  useEffect(() => {
    const field = sourceEditor.current;
    if (!field || !sourceOpen || !editing) return;
    return attachShortcutHost(field, "math", {
      capture: true,
      feedback: setShortcutHint,
      accepts: (event) => editor.isEditable && !event.isComposing,
      execute: (id) => sourceShortcut.current(id),
    });
  }, [sourceOpen, editing, editor]);

  const numbered = Boolean(attributes.environment && !attributes.environment.endsWith("*"));
  const equationSource = latexVisualMathSource(attributes, display);
  const referenceLabel = display ? singleMathReferenceLabel(equationSource) : null;
  const structureRestriction =
    attributes.numberingSource && referenceLabel === null
      ? "Edit imported row numbering in Source to preserve its labels and tags."
      : null;
  const numberingProtected = Boolean(
    attributes.numberingSource && withMathNumbering(equationSource, !numbered) === null,
  );
  const changeNumbering = () => {
    if (sourceError || numberingProtected || !mathField.current?.flush()) return;
    const position = getPos();
    const current = position === undefined ? null : editor.state.doc.nodeAt(position);
    if (!current) return;
    const source = latexVisualMathSource(
      { ...current.attrs, tex: String(current.attrs.tex ?? "") },
      true,
    );
    const next = withMathNumbering(source, !numbered);
    const parsed = next === null ? null : parseLatexVisualMathSource(next, true);
    if (parsed) {
      updateAttributes({ numbering: null, numberingSource: null, environment: null, ...parsed });
      setDraft(parsed.tex);
      setSourceError(null);
    } else {
      // Existing align/gather blocks retain their row structure and numbering scope.
      const environment = attributes.environment;
      changeType(
        environment === "align" || environment === "gather"
          ? `environment:${environment}*`
          : environment === "align*" || environment === "gather*"
            ? `environment:${environment.slice(0, -1)}`
            : numbered
              ? "display-bracket"
              : "environment:equation",
      );
    }
  };
  const changeReferenceLabel = (label: string) => {
    if (sourceError || label === referenceLabel) return;
    if (!mathField.current?.flush()) return;
    const position = getPos();
    const current = position === undefined ? null : editor.state.doc.nodeAt(position);
    if (!current) return;
    const source = latexVisualMathSource(
      { ...current.attrs, tex: String(current.attrs.tex ?? "") },
      true,
    );
    const next = withMathReferenceLabel(source, label);
    const parsed = next === null ? null : parseLatexVisualMathSource(next, true);
    if (parsed) updateAttributes({ numbering: null, numberingSource: null, ...parsed });
  };

  const structureActions = mathContext
    ? (
        [
          ["addRowAfter", "Add row below"],
          ["removeRow", "Remove row"],
          ["addColumnAfter", "Add column after"],
          ["removeColumn", "Remove column"],
        ] as const
      ).map(([command, label]) => ({
        command,
        label,
        reason: structureRestriction ?? mathStructureCommandReason(mathContext, command),
        run: () => {
          if (!mathField.current?.command(command))
            setShortcutHint("Place the caret in the cell you want to change.");
        },
      }))
    : [];
  const toolbarHost = editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  const toolbar =
    editing && editable && toolbarHost
      ? createPortal(
          <div
            ref={mathBar}
            className="scient-latex-context-toolbar scient-latex-math-bar"
            role="toolbar"
            aria-label="Math tools"
            data-context-name={display ? "Equation" : "Inline math"}
            data-context-presentation="inline"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className={dockButtonClass(sourceOpen)}
              aria-pressed={sourceOpen}
              aria-expanded={sourceOpen}
              aria-label="Edit formula as LaTeX"
              type="button"
              onClick={() => {
                if (sourceOpen) {
                  setSourceOpen(false);
                  if (!sourceError) mathField.current?.focus();
                } else {
                  if (!sourceError) setDraft(attributes.tex);
                  setSourceOpen(true);
                  requestAnimationFrame(() => sourceEditor.current?.focus());
                }
              }}
            >
              Edit LaTeX
              {sourceOpen ? (
                <ChevronDown className="size-3 shrink-0 opacity-60" />
              ) : (
                <ChevronUp className="size-3 shrink-0 opacity-60" />
              )}
            </button>
            {display && (
              <>
                <DockDivider />
                <div className="flex h-6 shrink-0 items-center gap-1.5">
                  <label htmlFor={`${activationId}-numbering`}>Numbered</label>
                  <ScientTooltip
                    content={
                      numberingProtected
                        ? "Edit imported row numbering and tags in Source."
                        : numbered
                          ? "Numbering is on. Click to turn it off."
                          : "Numbering is off. Click to turn it on."
                    }
                  >
                    <Switch
                      id={`${activationId}-numbering`}
                      size="xs"
                      data-latex-number-toggle=""
                      aria-label="Numbered"
                      checked={numbered}
                      disabled={numberingProtected || Boolean(sourceError)}
                      onMouseDown={(event) => {
                        if (mathRoot.current?.contains(document.activeElement))
                          event.preventDefault();
                      }}
                      onCheckedChange={changeNumbering}
                    />
                  </ScientTooltip>
                </div>
              </>
            )}
            {display && numbered && referenceLabel !== null && (
              <>
                <DockDivider />
                <LatexReferenceLabelControl
                  label="Equation reference label"
                  value={referenceLabel}
                  disabled={!editable || Boolean(sourceError)}
                  allowEmpty
                  commitOn="blur"
                  isAvailable={(value) =>
                    !value ||
                    value === referenceLabel ||
                    !latexEquationReferencesKey.getState(editor.state)?.labels.has(value)
                  }
                  draftKey={`${activeMath.draftKey}:math:${getPos() ?? activationId}:label`}
                  onCommit={changeReferenceLabel}
                  onEdit={() => setSourceOpen(false)}
                />
              </>
            )}
            {mathContext && !sourceOpen && (
              <>
                <DockDivider />
                <DockMenu
                  commandScope="latex"
                  label="Rows & columns"
                  side="top"
                  icon={<span>Rows &amp; columns</span>}
                >
                  {structureActions.map(({ command, label, reason, run }) => (
                    <DockCommandItem
                      key={command}
                      disabled={Boolean(reason)}
                      title={reason ?? undefined}
                      onClick={run}
                    >
                      {label}
                    </DockCommandItem>
                  ))}
                </DockMenu>
              </>
            )}
            <LatexMathPalette
              showTrigger={false}
              openRequest={paletteRequest}
              onOpenRequestHandled={(request) =>
                setPaletteRequest((pending) => (pending === request ? 0 : pending))
              }
              sourceOpen={sourceOpen}
              onOpen={() => setSourceOpen(false)}
              onInsert={(symbol) =>
                symbol.action
                  ? mathField.current?.command(symbol.action)
                  : mathField.current?.insert(symbol.latex)
              }
              onReturnToMath={() => mathField.current?.focus()}
            />
            {editing && sourceOpen ? (
              <div
                className="scient-latex-math-source-popover"
                role="dialog"
                aria-label={display ? "Equation source" : "Inline math source"}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
                  if (
                    event.key === "Escape" ||
                    (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                  ) {
                    event.preventDefault();
                    if (!sourceError) {
                      setSourceOpen(false);
                      mathField.current?.focus();
                    }
                  }
                }}
              >
                <LatexSourceResizeHandle
                  field={sourceEditor}
                  onResize={(height) => {
                    if (sourceEditor.current) sourceEditor.current.style.height = `${height}px`;
                  }}
                />
                <textarea
                  ref={sourceEditor}
                  aria-label="LaTeX formula code"
                  aria-invalid={Boolean(sourceError)}
                  spellCheck={false}
                  readOnly={!editable}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={draft}
                  rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                    if (!(event.nativeEvent as InputEvent).isComposing)
                      publishSource(event.currentTarget.value);
                  }}
                  onCompositionEnd={(event) => publishSource(event.currentTarget.value)}
                />
                {sourceError ? (
                  <div className="scient-latex-math-source-error" role="alert">
                    {sourceError}
                  </div>
                ) : null}
              </div>
            ) : null}

            {sourceError && !sourceOpen ? (
              <div className="scient-latex-math-bar-error" role="status">
                {sourceError}
              </div>
            ) : null}
          </div>,
          toolbarHost,
        )
      : null;
  return (
    <NodeViewWrapper
      ref={mathRoot}
      data-latex-context-root={activationId}
      as={display ? "div" : "span"}
      className={display ? "scient-latex-visual-display-math" : "scient-latex-visual-inline-math"}
      contentEditable={false}
      data-selected={selected || editing || undefined}
      data-document-selected={
        selectedByDocument || ((!editing || dragOutside) && selected) || undefined
      }
      data-empty={!attributes.tex.trim() || undefined}
      data-equation-numbered={hasEquationNumbers || undefined}
      onPointerDownCapture={startPointerSelection}
      onPointerMoveCapture={extendExternalSelection}
      onClick={(event: MouseEvent<HTMLElement>) => {
        // MathLive already placed the caret (or drag selection) at the clicked
        // symbol. Only clicks in the surrounding whitespace need help focusing.
        if (
          event.nativeEvent
            .composedPath()
            .some((target) => target instanceof Element && target.tagName === "MATH-FIELD")
        )
          return;
        if (display) {
          const fieldBounds = mathRoot.current
            ?.querySelector("math-field,.scient-latex-math-preview:not([hidden])")
            ?.getBoundingClientRect();
          if (fieldBounds && event.clientX > fieldBounds.right + 4) {
            finish(1);
            return;
          }
          if (fieldBounds && event.clientX < fieldBounds.left - 4) {
            finish(-1);
            return;
          }
        }
        activate();
      }}
    >
      <LatexMathField
        ref={mathField}
        draftKey={`${activeMath.draftKey}:math:${getPos() ?? activationId}`}
        value={mathFieldSource(attributes.tex, attributes.environment)}
        display={display}
        editing={editable && editing && !sourceOpen && !dragOutside}
        disabled={!editable}
        structureDisabledReason={structureRestriction}
        onContextChange={(next) =>
          setMathContext((previous) =>
            previous?.environment === next?.environment &&
            previous?.row === next?.row &&
            previous?.column === next?.column &&
            previous?.rows === next?.rows &&
            previous?.columns === next?.columns
              ? previous
              : next,
          )
        }
        onFormattingChange={(state) => activeMath.formatChanged(activationId, state)}
        formatCopiedMath={(tex) =>
          latexVisualMathSource(
            {
              ...attributes,
              numbering: null,
              numberingSource: null,
              tex: mathEnvironmentBody(tex, attributes.environment),
            },
            display,
          )
        }
        parsePastedMath={(source) => {
          const parsed = mathClipboardSource(source);
          return parsed
            ? mathFieldSource(parsed.attributes.tex, parsed.attributes.environment ?? null)
            : null;
        }}
        onShortcutHint={setShortcutHint}
        onShortcut={(command) => {
          if (command === "math.palette") {
            setSourceOpen(false);
            setPaletteRequest((value) => value + 1);
            return true;
          }
          if (command === "math.inline" || command === "math.display") {
            changeType(command === "math.inline" ? "inline-paren" : "display-bracket");
            return true;
          }
          return false;
        }}
        onFocus={() => activate(false)}
        onExit={finish}
        onExtendOutside={extendOutside}
        onUndo={(redo) => {
          if (!mathField.current?.flush()) return false;
          return redo ? editor.commands.redo() : editor.commands.undo();
        }}
        onRemoveEmpty={(direction) => {
          if (!mathField.current?.isEmpty()) return false;
          const position = getPos();
          if (position === undefined || !editor.isEditable || editor.isDestroyed) return false;
          const current = editor.state.doc.nodeAt(position);
          if (!current || current.type !== node.type) return false;
          const transaction = editor.state.tr.delete(position, position + current.nodeSize);
          const boundary = Math.min(position, transaction.doc.content.size);
          const caret =
            Selection.findFrom(transaction.doc.resolve(boundary), direction, true) ??
            Selection.findFrom(transaction.doc.resolve(boundary), -direction, true);
          if (caret) transaction.setSelection(caret);
          else {
            transaction.insert(boundary, editor.schema.nodes.paragraph!.create());
            transaction.setSelection(TextSelection.create(transaction.doc, boundary + 1));
          }
          editor.view.dispatch(transaction.scrollIntoView());
          if (!editor.state.doc.eq(transaction.doc)) return false;
          activeMath.deactivate(activationId);
          editor.view.focus();
          return true;
        }}
        onChange={(tex) => {
          const body = mathEnvironmentBody(tex, attributes.environment);
          if (editor.isEditable) {
            if (body !== attributes.tex) updateAttributes({ tex: body });
          }
          const position = getPos();
          const accepted = String(
            (position === undefined ? node : editor.state.doc.nodeAt(position))?.attrs.tex ??
              node.attrs.tex ??
              "",
          );
          setSourceError(null);
          setDraft(accepted);
          return {
            accepted: accepted.trim() === body.trim(),
            value: mathFieldSource(accepted, attributes.environment),
          };
        }}
      />
      {hasEquationNumbers && equationRows && (
        <span className="scient-latex-equation-numbers" contentEditable={false}>
          {equationRows.map((row, index) => (
            <span
              key={index}
              data-latex-equation-row={index}
              aria-label={row.number ? `Equation ${row.number}` : undefined}
            >
              {row.display ?? ""}
            </span>
          ))}
        </span>
      )}
      {toolbar}
    </NodeViewWrapper>
  );
}

function inlineReferenceTarget(state: EditorState, name: string, argument: string) {
  if (!["eqref", "ref", "subref", "pageref", "autoref", "hyperref", "hyperlink"].includes(name))
    return null;
  const references = latexEquationReferencesKey.getState(state);
  const target =
    (name === "hyperlink"
      ? references?.anchors?.get(argument)
      : references?.labels.get(argument)) ?? null;
  return name === "subref" && target?.panelIndex === undefined ? null : target;
}

function LatexInlineCommandView({
  node,
  updateAttributes,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const editable = useEditorEditable(editor);
  const referenceEditor = useContext(LatexInlineOwnerContext) ?? editor;
  const name = String(node.attrs.name ?? "command");
  const [textEditing, setTextEditing] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const argument = String(node.attrs.argument ?? "");
  const citation = latexCitationParts(String(node.attrs.raw ?? ""));
  const referenceManager = useContext(LatexReferencesContext);
  const citationTargets = useEditorState({
    editor: name === "cite" ? referenceEditor : null,
    selector: ({ editor: current }) => {
      const references = current && latexEquationReferencesKey.getState(current.state);
      return name === "cite" && references?.manualCitations
        ? argument.split(",").map((value) => {
            const key = value.trim();
            const target = references.citations.get(key);
            return { key, target: target ? { number: target.number } : null };
          })
        : null;
    },
  });
  const equationReference = useEditorState({
    editor: ["eqref", "ref", "subref", "autoref", "hyperref", "hyperlink", "pageref"].includes(name)
      ? referenceEditor
      : null,
    selector: ({ editor: current }) => {
      const target = current && inlineReferenceTarget(current.state, name, argument);
      // Moving a target while typing does not change its printed reference.
      // Resolve its live position only when the user follows the reference.
      return target
        ? {
            number: target.number,
            kind: target.kind,
            title: target.title,
            panelIndex: target.panelIndex,
            panelNumber: target.panelNumber,
          }
        : null;
    },
  });
  const referencePage = useEditorState({
    editor: name === "pageref" ? referenceEditor : null,
    selector: ({ editor: current }) => {
      const target =
        current && name === "pageref" && inlineReferenceTarget(current.state, name, argument);
      return current && target ? latexVisualPageLabelAt(current.state, target.position) : null;
    },
  });
  const footnoteNumber = useEditorState({
    editor: name === "footnote" ? editor : null,
    selector: ({ editor: current }) => {
      const position = getPos();
      return current && typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.footnotes?.get(position)?.number ??
            null)
        : null;
    },
  });
  const statementLabel = useEditorState({
    editor: name === "label" ? editor : null,
    selector: ({ editor: current }) => {
      if (name !== "label" || !current) return false;
      const position = getPos();
      if (typeof position !== "number") return false;
      const resolved = current.state.doc.resolve(position);
      for (let depth = resolved.depth; depth > 0; depth--)
        if (resolved.node(depth).type.name === "latexScientific") return true;
      return false;
    },
  });
  const referenceDescription =
    equationReference && equationReference.kind !== "equation"
      ? `${equationReference.title ?? "statement"} ${equationReference.number ?? argument}`
      : `equation ${equationReference?.number ?? argument}`;
  const root = useRef<HTMLSpanElement>(null);
  const footnoteText = name === "footnote" ? metadataText(argument) : null;
  const linkText = String(node.attrs.linkText ?? "");
  const linkPlain = metadataText(linkText);
  const isLink = ["href", "url", "hyperref", "hyperlink"].includes(name);
  const isExternalLink = name === "href" || name === "url";
  const isCrossReference = [
    "eqref",
    "ref",
    "subref",
    "pageref",
    "autoref",
    "hyperref",
    "hyperlink",
  ].includes(name);
  const hasLinkText = ["href", "hyperref", "hyperlink", "hypertarget"].includes(name);
  if (name === "columnbreak") {
    return (
      <NodeViewWrapper
        as="span"
        className="scient-latex-inline-column-break"
        contentEditable={false}
        aria-label="Column break"
      />
    );
  }
  if (name === "verb") {
    return (
      <NodeViewWrapper as="span" className="scient-latex-inline-literal" contentEditable={false}>
        <LatexTextField
          aria-label="Inline literal text"
          rows={1}
          wrap="off"
          spellCheck={false}
          disabled={!editable}
          value={argument}
          onFocus={() => preserveLatexCaret(editor.view)}
          onValueChange={(value) => {
            const raw = inlineLatexLiteralSource(value, String(node.attrs.raw ?? ""));
            if (raw !== null) updateAttributes({ argument: value, raw });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              const position = getPos();
              if (typeof position === "number")
                editor.commands.setTextSelection(position + node.nodeSize);
              editor.commands.focus(undefined, { scrollIntoView: false });
            }
          }}
        />
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper
      as="span"
      ref={root}
      className="scient-latex-visual-command"
      data-selected={selected || undefined}
      data-equation-reference={!!equationReference || undefined}
      data-statement-label={statementLabel || undefined}
      data-prose-command={isLink || name === "footnote" || name === "hypertarget" || undefined}
      data-footnote-editor={(name === "footnote" && textEditing) || undefined}
      data-anchor={name === "hypertarget" || undefined}
      data-citation={!!citationTargets || undefined}
      contentEditable={false}
    >
      {textEditing && (hasLinkText || name === "footnote") ? (
        <>
          {name === "footnote" && <sup>{footnoteNumber ?? "*"}</sup>}
          <span className="scient-latex-inline-text-editor">
            {name !== "footnote" && (
              <span className="scient-latex-inline-text-measure" aria-hidden="true">
                {(editingText ?? linkPlain ?? linkText) || "\u200b"}
              </span>
            )}
            <LatexTextField
              onInput={(event) => setEditingText(event.currentTarget.value)}
              aria-label={name === "footnote" ? "Footnote text" : "Link text"}
              rows={1}
              value={name === "footnote" ? (footnoteText ?? argument) : (linkPlain ?? linkText)}
              disabled={
                !editable || (name === "footnote" ? footnoteText === null : linkPlain === null)
              }
              onBlur={(event) => {
                if (!event.relatedTarget && !event.currentTarget.ownerDocument.hasFocus()) return;
                if (
                  event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest(
                    ".scient-latex-context-tools, [data-dock-command-scope]",
                  )
                )
                  return;
                setTextEditing(false);
                setEditingText(null);
              }}
              onValueChange={(value) => {
                const next = escapeText(value);
                updateAttributes(
                  name === "footnote"
                    ? {
                        argument: next,
                        raw: latexInlineCommandSource(
                          name,
                          next,
                          linkText,
                          String(node.attrs.raw ?? ""),
                        ),
                      }
                    : {
                        linkText: next,
                        raw: latexInlineCommandSource(
                          name,
                          argument,
                          next,
                          String(node.attrs.raw ?? ""),
                        ),
                      },
                );
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.blur();
                  setTextEditing(false);
                  const position = getPos();
                  if (typeof position === "number")
                    editor.commands.setTextSelection(position + node.nodeSize);
                  editor.commands.focus(undefined, { scrollIntoView: false });
                }
              }}
            />
          </span>
        </>
      ) : citationTargets ? (
        <span className="scient-latex-citation">
          [
          {citationTargets.map(({ key, target }, index) => (
            <Fragment key={`${key}:${index}`}>
              {index > 0 ? ", " : ""}
              <ScientTooltip
                content={
                  target
                    ? `Go to reference ${target.number ?? key} (${key})`
                    : `Unresolved citation: ${key}`
                }
              >
                <button
                  type="button"
                  disabled={!editable && !target}
                  aria-label={
                    target
                      ? `Go to reference ${target.number ?? key}`
                      : `Edit unresolved citation ${key}`
                  }
                  onClick={() => {
                    const position = getPos();
                    if (typeof position === "number") editor.commands.setNodeSelection(position);
                    const liveTarget = latexEquationReferencesKey
                      .getState(referenceEditor.state)
                      ?.citations.get(key);
                    if (liveTarget) navigateToEquation(referenceEditor.view, liveTarget);
                  }}
                >
                  {target?.number ?? "?"}
                </button>
              </ScientTooltip>
            </Fragment>
          ))}
          {citation?.notes.length
            ? `, ${citation.notes.map((note) => metadataText(note) ?? note).join(", ")}`
            : ""}
          ]
        </span>
      ) : (
        <button
          type="button"
          disabled={!editable && !equationReference && name !== "footnote"}
          aria-label={
            name === "footnote"
              ? `Go to footnote ${footnoteNumber ?? ""}`
              : equationReference
                ? `Go to ${referenceDescription}`
                : `Edit ${name}`
          }
          onClick={(event) => {
            if (hasLinkText && linkPlain !== null && editable && !equationReference) {
              const offset = latexProseCaretOffset(
                event.currentTarget,
                event.clientX,
                event.clientY,
              );
              preserveLatexCaret(editor.view);
              setEditingText(null);
              setTextEditing(true);
              requestAnimationFrame(() => {
                const field = root.current?.querySelector<HTMLTextAreaElement>(
                  '[aria-label="Link text"]',
                );
                field?.focus({ preventScroll: true });
                field?.setSelectionRange(offset, offset);
              });
              return;
            }
            const position = getPos();
            if (typeof position === "number") editor.commands.setNodeSelection(position);
            if (name === "footnote" && typeof position === "number") {
              navigateToFootnote(editor.view, position);
              return;
            }
            if (equationReference) {
              const liveTarget = inlineReferenceTarget(referenceEditor.state, name, argument);
              if (liveTarget) navigateToEquation(referenceEditor.view, liveTarget);
              return;
            }
            if (hasLinkText && linkPlain !== null && editable) {
              setTextEditing(true);
              requestAnimationFrame(() =>
                root.current
                  ?.querySelector<HTMLTextAreaElement>('[aria-label="Link text"]')
                  ?.focus({ preventScroll: true }),
              );
            }
          }}
        >
          {name === "footnote" ? (
            <ScientTooltip content={footnoteText ?? argument}>
              <sup>{footnoteNumber ?? "*"}</sup>
            </ScientTooltip>
          ) : hasLinkText ? (
            <LatexProsePreview source={linkText} />
          ) : isExternalLink ? (
            <span>{argument.replace(/\\([%#&])/gu, "$1")}</span>
          ) : equationReference ? (
            <ScientTooltip content={`Go to ${referenceDescription} (${argument})`}>
              <span className="scient-latex-equation-reference">
                {(name === "pageref"
                  ? referencePage
                  : name === "subref"
                    ? equationReference.panelNumber
                    : equationReference.number) == null
                  ? `[${argument}]`
                  : name === "pageref"
                    ? referencePage
                    : name === "autoref"
                      ? `${equationReference.title ?? "Equation"} ${equationReference.number}`
                      : name === "subref"
                        ? equationReference.panelNumber
                        : name === "eqref"
                          ? `(${equationReference.number})`
                          : equationReference.number}
              </span>
            </ScientTooltip>
          ) : (
            <span>{name === "label" ? `(${argument || "label"})` : `[${argument || name}]`}</span>
          )}
        </button>
      )}
      <LatexObjectToolbar
        editor={editor}
        root={root}
        selected={selected}
        inline
        position={
          isLink
            ? "Link"
            : citation
              ? "Citation"
              : name === "footnote"
                ? "Footnote"
                : name === "label"
                  ? "Label"
                  : "Reference"
        }
        label={`${isLink ? "Link" : citation ? "Citation" : name === "footnote" ? "Footnote" : name === "label" ? "Reference label" : "Cross-reference"} options`}
      >
        {hasLinkText && (
          <button
            type="button"
            className={dockButtonClass()}
            disabled={!editable || linkPlain === null}
            onClick={() => {
              setTextEditing(true);
              requestAnimationFrame(() =>
                root.current
                  ?.querySelector<HTMLTextAreaElement>('[aria-label="Link text"]')
                  ?.focus({ preventScroll: true }),
              );
            }}
          >
            Text
          </button>
        )}
        {name === "footnote" && (
          <button
            type="button"
            className={dockButtonClass()}
            disabled={!editable || footnoteText === null}
            onClick={() => {
              setTextEditing(true);
              requestAnimationFrame(() =>
                root.current
                  ?.querySelector<HTMLTextAreaElement>('[aria-label="Footnote text"]')
                  ?.focus({ preventScroll: true }),
              );
            }}
          >
            Edit text
          </button>
        )}
        {citation && (
          <LatexCitationControls
            command={name}
            notes={citation.notes}
            onPresentation={(command, notes) =>
              updateAttributes({
                name: command,
                raw: `\\${command}${notes.map((note) => `[${note}]`).join("")}{${argument}}`,
              })
            }
            keys={argument
              .split(",")
              .map((key) => key.trim())
              .filter(Boolean)}
            entries={referenceManager?.entries ?? []}
            disabled={!editable}
            onOpen={referenceManager?.open}
            onKeys={(keys) => {
              const argument = keys.join(",");
              updateAttributes({
                argument,
                raw: latexInlineCommandSource(
                  name,
                  argument,
                  linkText,
                  String(node.attrs.raw ?? ""),
                ),
              });
            }}
          />
        )}
        {isCrossReference && (
          <LatexCrossReferenceControl
            editor={referenceEditor}
            command={name}
            value={argument}
            disabled={!editable}
            onChange={(argument) =>
              updateAttributes({
                argument,
                raw: latexInlineCommandSource(
                  name,
                  argument,
                  linkText,
                  String(node.attrs.raw ?? ""),
                ),
              })
            }
          />
        )}
        {isExternalLink && (
          <LatexLinkAddress
            value={argument.replace(/\\([%#&])/gu, "$1")}
            disabled={!editable}
            onChange={(value) => {
              const next = value.replace(/[%#&]/gu, (character) => "\\" + character);
              updateAttributes({
                argument: next,
                raw: latexInlineCommandSource(name, next, linkText),
              });
            }}
          />
        )}
        {(name === "label" || name === "hypertarget") && (
          <LatexFooterLabel
            value={argument}
            allowEmpty={false}
            disabled={!editable}
            rename={name !== "hypertarget"}
            onCommit={(value) =>
              updateAttributes({
                argument: value,
                raw: latexInlineCommandSource(name, value, linkText, String(node.attrs.raw ?? "")),
              })
            }
          />
        )}
      </LatexObjectToolbar>
    </NodeViewWrapper>
  );
}

const LatexBlockSourceContext = createContext<{
  active: {
    id: string;
    position: number;
    baseSource: string;
    original: string;
    draft: string;
  } | null;
  disabled: boolean;
  open: (position: number) => void;
  change: (draft: string) => void;
  apply: () => void;
  close: () => void;
  remove: (position: number, original: string) => void;
} | null>(null);

function LatexRawBlockView({ node, editor, getPos }: NodeViewProps) {
  "use no memo";
  // getPos reads live ProseMirror state despite retaining the same function identity.
  const raw = String(node.attrs.raw ?? "");
  const source = useContext(LatexBlockSourceContext);
  const active = source?.active?.position === getPos();
  const sourceField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = sourceField.current;
    if (field && active) return installLatexTextSelectionSession(field);
  }, [active]);
  const open = () => {
    const position = getPos();
    if (typeof position === "number" && source && editor.isEditable) {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
      );
      source.open(position);
    }
  };
  const selectBlock = () => {
    const position = getPos();
    if (typeof position !== "number" || editor.isDestroyed) return;
    const selection = NodeSelection.create(editor.state.doc, position);
    if (!editor.state.selection.eq(selection))
      editor.view.dispatch(editor.state.tr.setSelection(selection));
  };
  const disabled = !editor.isEditable || !source || source.disabled;
  return (
    <NodeViewWrapper className="scient-latex-visual-raw" contentEditable={false}>
      <div className="scient-latex-visual-raw-label">
        <span>Source only · {active ? "editing LaTeX" : "click to edit LaTeX"}</span>
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          {active && (
            <>
              <Button
                size="compact"
                variant="ghost"
                disabled={disabled}
                onClick={() => source?.apply()}
              >
                Apply LaTeX
              </Button>
              <Button size="compact" variant="ghost" onClick={() => source?.close()}>
                Cancel
              </Button>
            </>
          )}
          <Button
            size="compact"
            variant="ghost"
            aria-label="Delete source block"
            disabled={disabled}
            onClick={() => {
              const at = getPos();
              if (typeof at === "number") source?.remove(at, raw);
            }}
          >
            Delete
          </Button>
        </span>
      </div>
      {active ? (
        <textarea
          ref={sourceField}
          autoFocus
          aria-label="Block LaTeX source"
          rows={Math.min(12, Math.max(1, raw.split(/\r?\n/u).length))}
          value={source?.active?.draft ?? raw}
          disabled={source?.disabled}
          onChange={(event) => source?.change(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              source?.apply();
            } else if (event.key === "Escape") {
              event.preventDefault();
              source?.close();
            }
          }}
        />
      ) : (
        <pre
          role="button"
          tabIndex={0}
          aria-label="Edit this block’s LaTeX"
          onClick={open}
          onFocus={selectBlock}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
        >
          {raw}
        </pre>
      )}
    </NodeViewWrapper>
  );
}

function withStableKeys<T>(values: T[], serialize: (value: T) => string) {
  const occurrences = new Map<string, number>();
  return values.map((value, index) => {
    const serialized = serialize(value);
    const occurrence = occurrences.get(serialized) ?? 0;
    occurrences.set(serialized, occurrence + 1);
    return { index, key: `${serialized}\u0000${occurrence}`, value };
  });
}

interface LatexVisualWorkspace {
  readonly draftKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
}

const LatexRootContext = createContext<string | null>(null);
/**
 * Where this editor's fields keep their drafts, and which file it shows. Node
 * views read it here, not from options captured when the editor was created,
 * so an in-place rename moves every later draft to the new path.
 */
const LatexWorkspaceContext = createContext<LatexVisualWorkspace | null>(null);
const LatexReferencesContext = createContext<{
  open: (key?: string) => void;
  entries: readonly BibliographyDetails[];
} | null>(null);

function normalizeFigurePath(sourceRelativePath: string, figurePath: string): string | null {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[A-Za-z]:[\\/]|[\\/])/u.test(figurePath)) return null;
  const directory = sourceRelativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  const segments = [...directory, ...figurePath.replaceAll("\\", "/").split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
    } else normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

function visualFigureWidth(width: string): string | undefined {
  const relative = /^\s*(?:(\d+(?:\.\d*)?|\.\d+)\s*)?\\(?:textwidth|linewidth)\s*$/u.exec(width);
  if (relative) return `${Math.min(1, Number(relative[1] ?? "1")) * 100}%`;
  const inches = latexLengthInches(width);
  return inches !== null && inches > 0 ? `${inches * CSS_PIXELS_PER_INCH}px` : undefined;
}

function LatexFigureImage(props: {
  readonly alt: string;
  readonly path: string;
  readonly width: string;
  readonly workspace: LatexVisualWorkspace;
}) {
  const rootRelativePath = useContext(LatexRootContext);
  const relativePath =
    rootRelativePath === null ? null : normalizeFigurePath(rootRelativePath, props.path);
  const resource = useMemo<AssetResource | null>(
    () =>
      props.workspace.cwd === null || relativePath === null
        ? null
        : {
            _tag: "workspace-file",
            cwd: props.workspace.cwd,
            relativePath,
          },
    [props.workspace.cwd, relativePath],
  );
  const asset = useAssetUrlState(props.workspace.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const style = { width: visualFigureWidth(props.width) };
  if (asset._tag === "Success" && failedUrl !== asset.url)
    return (
      <img
        alt={props.alt || props.path}
        draggable={false}
        onError={() => setFailedUrl(asset.url)}
        src={asset.url}
        style={style}
      />
    );
  const failed = asset._tag === "Failure" || failedUrl !== null;
  return (
    <div
      className="scient-latex-figure-placeholder"
      role="img"
      aria-label={props.alt || props.path}
      style={style}
    >
      <span>{failed ? "Image preview unavailable" : "Loading image preview…"}</span>
      <code>{props.path || "Choose a project image"}</code>
      {failed ? (
        <button
          onClick={() => {
            setFailedUrl(null);
            asset.refresh();
          }}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function PartNumberedOption({
  editor,
  getPos,
  fallback,
  disabled,
  updateAttributes,
}: {
  editor: Editor;
  getPos: NodeViewProps["getPos"];
  fallback: boolean;
  disabled: boolean;
  updateAttributes: NodeViewProps["updateAttributes"];
}) {
  const numbered = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const position = getPos();
      const part = typeof position === "number" ? current.state.doc.nodeAt(position) : null;
      return part?.type.name === "latexRichPreview" && part.attrs.kind === "part"
        ? part.attrs.unnumbered !== true
        : fallback;
    },
  });
  return (
    <LatexHeadingNumberButton
      checked={numbered}
      disabled={disabled}
      onCheckedChange={(checked) => updateAttributes({ unnumbered: !checked })}
    />
  );
}

function LatexRichPreviewInWorkspace({
  created,
  ...props
}: Omit<Parameters<typeof LatexRichPreviewView>[0], "workspace"> & {
  readonly created: LatexVisualWorkspace;
}) {
  return (
    <LatexRichPreviewView {...props} workspace={useContext(LatexWorkspaceContext) ?? created} />
  );
}

function LatexRichPreviewView({
  node,
  decorations,
  selected,
  updateAttributes,
  editor,
  deleteNode,
  getPos,
  workspace,
}: NodeViewProps & { readonly workspace: LatexVisualWorkspace }) {
  const languageLabels = latexLanguageLabels(useContext(LatexLanguageContext));
  const editorEditable = useEditorEditable(editor);
  const generatedId = useRef(0);
  const tableRoot = useRef<HTMLElement | null>(null);
  const objectRoot = useRef<HTMLElement | null>(null);
  const [descriptionItem, setDescriptionItem] = useState(0);
  const [captionEditing, setCaptionEditing] = useState(false);
  const [statementTitleEditing, setStatementTitleEditing] = useState(false);
  const focusObject = (event: FocusEvent<HTMLElement>) => {
    // React portals bubble through their document owner. Menu focus is not a
    // click into the paper and must not collapse a table or document selection.
    if (!event.currentTarget.contains(event.target)) return;
    // Selecting cells focuses their table, without entering an individual cell.
    if (
      event.target === tableRoot.current &&
      tableRoot.current?.hasAttribute("data-table-selection")
    )
      return;
    preserveLatexCaret(editor.view);
  };
  const leaveObject = (direction: -1 | 1) => {
    const position = getPos();
    if (typeof position !== "number") return;
    const boundary = direction < 0 ? position : position + node.nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(boundary), direction)),
    );
    editor.commands.focus(undefined, { scrollIntoView: false });
  };
  const [selectedCell, setSelectedCell] = useState({ row: 0, column: 0 });
  const [objectActive, setObjectActive] = useState(false);
  const kind = String(node.attrs.kind ?? "description");
  useEffect(() => {
    const root = tableRoot.current;
    if (kind !== "table" || !editorEditable || !root) return;
    return installLatexTableEditingGuides(root);
  }, [kind, editorEditable]);
  const setFooterPosition = useContext(LatexFooterPositionContext);
  const cellPosition =
    kind === "table" && objectActive
      ? `Table · row ${selectedCell.row + 1}, column ${selectedCell.column + 1}`
      : null;
  useEffect(() => {
    if (cellPosition === null) return;
    setFooterPosition(cellPosition);
    return () => setFooterPosition(null);
  }, [cellPosition, setFooterPosition]);
  const fieldDraft = (name: string) =>
    workspace.draftKey
      ? `${workspace.draftKey}:${fieldSourceId(editor, node, getPos())}:${kind}:${name}`
      : undefined;
  const items = Array.isArray(node.attrs.items)
    ? (node.attrs.items as { label?: unknown; body?: unknown }[])
    : [];
  const itemIds = Array.isArray(node.attrs.itemIds)
    ? (node.attrs.itemIds as unknown[]).map(String)
    : [];
  const rows = Array.isArray(node.attrs.rows)
    ? (node.attrs.rows as unknown[]).filter(Array.isArray).map((row) => row.map(String))
    : [];
  const rowIds = Array.isArray(node.attrs.rowIds)
    ? (node.attrs.rowIds as unknown[]).map(String)
    : [];
  const columnIds = Array.isArray(node.attrs.columnIds)
    ? (node.attrs.columnIds as unknown[]).map(String)
    : [];
  const columnAlignments = Array.isArray(node.attrs.columnAlignments)
    ? (node.attrs.columnAlignments as unknown[]).map((alignment) =>
        alignment === "center" || alignment === "right" ? alignment : "left",
      )
    : [];
  const caption = String(node.attrs.caption ?? "");
  const removeEmptyCaption = () => {
    if (!editor.isEditable || node.attrs.editable !== true || editor.isDestroyed) return;
    updateAttributes({ caption: "", captionRemoved: true, label: "" });
    setCaptionEditing(false);
    const position = getPos();
    if (typeof position !== "number") return;
    const current = editor.state.doc.nodeAt(position);
    if (!current || current.attrs.kind !== kind || current.attrs.captionRemoved !== true) return;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
    );
    editor.view.focus();
  };
  const tableHasCaption = latexVisualFloatHasCaption({ attrs: node.attrs });
  const tableLabel = String(node.attrs.label ?? "");
  const structureEditable = node.attrs.editable === true;
  const controlsVisible = kind === "table" ? objectActive : selected || objectActive;
  const tableEditable = kind === "table" && structureEditable;
  const objectPageGaps = useMemo(() => latexObjectPageGaps(decorations, node), [decorations, node]);
  const continuationHeights = useMemo(
    () => latexObjectContinuationHeights(decorations, node),
    [decorations, node],
  );
  const tablePresentation = useMemo(
    () => latexVisualTablePresentation(String(node.attrs.raw ?? "")),
    [node.attrs.raw],
  );
  const tableFormatting = useMemo(() => latexVisualTableFormatting(node.toJSON()), [node]);
  const tableColumnKinds = node.attrs.tableCanonical
    ? (rows[0]?.map(() => (node.attrs.tableKind === "stretch" ? "flexible" : "natural")) ?? [])
    : tablePresentation.columnKinds;
  const mixedTableColumns =
    node.attrs.tableKind === "stretch" &&
    tableColumnKinds.includes("flexible") &&
    tableColumnKinds.some((kind) => kind !== "flexible");
  useEffect(() => {
    if (kind !== "table") return;
    setSelectedCell((cell) => {
      const row = Math.max(0, Math.min(cell.row, rows.length - 1));
      const column = Math.max(0, Math.min(cell.column, (rows[0]?.length ?? 1) - 1));
      return row === cell.row && column === cell.column ? cell : { row, column };
    });
  }, [kind, rows.length, rows[0]?.length]);
  const descriptionEditable = kind === "description" && structureEditable;
  const sourceMeta =
    node.attrs.sourceMeta && typeof node.attrs.sourceMeta === "object"
      ? (node.attrs.sourceMeta as Record<string, unknown>)
      : null;
  const listingOrdinal = useEditorState({
    editor: kind === "simple" && node.attrs.environment === "lstlisting" ? editor : null,
    selector: ({ editor: current }) => {
      if (!current || kind !== "simple" || node.attrs.environment !== "lstlisting") return "";
      const position = getPos();
      return typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.listings.get(position)?.number ?? "")
        : "";
    },
  });
  const tableStructureEditable = tableEditable && sourceMeta?.preserveStructure !== true;
  const authoring = useContext(LatexAuthoringContext);
  const drawingRootPath = useContext(LatexRootContext);
  const longtable = sourceMeta?.longtable as
    | { head: LongTableBand; foot: LongTableBand; lastFoot: LongTableBand }
    | undefined;
  const tableLayout = (sourceMeta?.tableLayout ?? []) as (LatexTableCellLayout | null)[][];
  const tableCells = rows.flatMap((row, r) =>
    row.flatMap((_cell, c) => {
      const layout = tableLayout[r]?.[c];
      return !layout || (layout.row === r && layout.column === c) ? [{ row: r, column: c }] : [];
    }),
  );
  const tableNumber = useEditorState({
    editor: kind === "table" ? editor : null,
    selector: ({ editor: current }) => {
      const position = getPos();
      return current && typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.tables?.get(position)?.number ??
            null)
        : null;
    },
  });
  const figurePresentation = useEditorState({
    editor: kind === "figure" ? editor : null,
    selector: ({ editor: current }) => {
      const position = getPos();
      return current && typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.figures?.get(position) ?? null)
        : null;
    },
  });
  const bibliographyPresentation = useEditorState({
    editor: kind === "bibliography" ? editor : null,
    selector: ({ editor: current }) => {
      const position = getPos();
      return current && typeof position === "number"
        ? (latexEquationReferencesKey.getState(current.state)?.bibliographies?.get(position) ??
            null)
        : null;
    },
  });
  const compiledAlgorithmPresentation = useEditorState({
    editor: kind === "compiledAlgorithm" ? editor : null,
    selector: ({ editor: current }) => {
      if (kind !== "compiledAlgorithm" || !current) return null;
      const position = getPos();
      if (typeof position !== "number") return null;
      const references = latexEquationReferencesKey.getState(current.state);
      return {
        number: references?.algorithms.get(position)?.number ?? null,
        source: String(node.attrs.raw).replace(
          /\\(eqref|ref)\s*\{([^{}]+)\}/gu,
          (original, command: string, label: string) => {
            const number = references?.labels.get(label)?.number;
            return number == null ? original : command === "eqref" ? `(${number})` : number;
          },
        ),
      };
    },
  });
  const contentsPresentation = useEditorState({
    editor: kind === "toc" ? editor : null,
    selector: ({ editor: current }) => {
      if (kind !== "toc" || !current) return [];
      const references = latexEquationReferencesKey.getState(current.state);
      const floatKind =
        node.attrs.environment === "listoffigures"
          ? "figure"
          : node.attrs.environment === "listoftables"
            ? "table"
            : null;
      const entries = floatKind
        ? (references?.floatContents ?? []).filter((entry) => entry.kind === floatKind)
        : (references?.contents ?? []).map((entry) => ({ ...entry, kind: "heading" as const }));
      const pageLabels = latexVisualPageLabels(current.state);
      return entries.map((entry) => {
        const page = latexVisualPageAt(current.state, entry.position);
        return { ...entry, page: page === null ? null : (pageLabels[page - 1] ?? null) };
      });
    },
  });
  const hasTableFloat = sourceMeta?.hasFloat === true;
  const canAddTableMetadata = hasTableFloat || Boolean(longtable);
  const captionEditable =
    tableEditable &&
    sourceMeta !== null &&
    (sourceMeta.captionRange !== null || (!tablePresentation.hasCaption && canAddTableMetadata));
  const labelEditable =
    tableEditable &&
    sourceMeta !== null &&
    (sourceMeta.labelRange !== null || (canAddTableMetadata && captionEditable));
  const tableSelection = useLatexTableSelection({
    root: tableRoot,
    editor,
    getPos,
    enabled: kind === "table" && editorEditable,
    rowCount: rows.length,
    columnCount: rows[0]?.length ?? 0,
    activeCell: selectedCell,
    canClear: tableEditable,
    resolveCell: (cell) => {
      const owner = tableLayout[cell.row]?.[cell.column];
      return owner ? { row: owner.row, column: owner.column } : cell;
    },
    normalizeSelection: (selection) => {
      if (!tableLayout.length || selection.whole) return selection;
      const bounds = latexTableSelectionBounds(
        tableLayout,
        Math.min(selection.anchor.row, selection.head.row),
        Math.max(selection.anchor.row, selection.head.row),
        Math.min(selection.anchor.column, selection.head.column),
        Math.max(selection.anchor.column, selection.head.column),
      );
      return {
        ...selection,
        anchor: { row: bounds.firstRow, column: bounds.firstColumn },
        head: { row: bounds.lastRow, column: bounds.lastColumn },
      };
    },
    onDelete: () => {
      if (!editorEditable) return;
      deleteNode();
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    onClear: (selection) => {
      if (!editorEditable || !tableEditable) return;
      const position = getPos();
      if (typeof position !== "number") return;
      const current = editor.state.doc.nodeAt(position);
      if (!current || !Array.isArray(current.attrs.rows)) return;
      const nextRows = (current.attrs.rows as string[][]).map((row, rowIndex) =>
        row.map((value, columnIndex) =>
          tableSelectionContains(selection, rowIndex, columnIndex) ? "" : value,
        ),
      );
      const before = editor.state.doc;
      editor.view.dispatch(
        closeHistory(editor.state.tr).setNodeMarkup(position, undefined, {
          ...current.attrs,
          rows: nextRows,
        }),
      );
      if (editor.state.doc === before) return;
      tableRoot.current?.querySelectorAll<HTMLElement>("[data-table-cell]").forEach((field) => {
        const [row, column] = (field.dataset.tableCell ?? "").split("-").map(Number);
        if (
          row !== undefined &&
          column !== undefined &&
          tableSelectionContains(selection, row, column)
        )
          replaceLatexFieldDraft(field, "");
      });
    },
    onClipboard: (selection) => {
      const position = getPos();
      const current = typeof position === "number" ? editor.state.doc.nodeAt(position) : null;
      if (!current) return null;
      if (selection.whole) return serializeLatexVisualBlock(current.toJSON());
      return latexVisualTableCellsClipboard(
        current.toJSON(),
        Math.min(selection.anchor.row, selection.head.row),
        Math.max(selection.anchor.row, selection.head.row),
        Math.min(selection.anchor.column, selection.head.column),
        Math.max(selection.anchor.column, selection.head.column),
      );
    },
  });
  const firstSelectedTableCell = tableSelection.selection
    ? tableLayout[
        Math.min(tableSelection.selection.anchor.row, tableSelection.selection.head.row)
      ]?.[Math.min(tableSelection.selection.anchor.column, tableSelection.selection.head.column)]
    : tableLayout[selectedCell.row]?.[selectedCell.column];
  const nextGeneratedId = (prefix: string) => {
    const used = new Set([...itemIds, ...rowIds, ...columnIds]);
    let id: string;
    do {
      generatedId.current += 1;
      id = `${prefix}-${generatedId.current}`;
    } while (used.has(id));
    return id;
  };
  const keyedItems = descriptionEditable
    ? items.map((item, index) => ({
        index,
        key: itemIds[index] ?? `description-item-${index}`,
        value: item,
      }))
    : withStableKeys(items, (item) => JSON.stringify([item.label, item.body]));
  const keyedRows = tableEditable
    ? rows.map((row, index) => ({
        index,
        key: rowIds[index] ?? `table-row-${index}`,
        value: row,
      }))
    : withStableKeys(rows, (row) => JSON.stringify(row));
  const updateDescriptionItem = (index: number, field: "label" | "body", value: string) => {
    if (!editorEditable || !descriptionEditable) return;
    const nextItems = items.map((item) => ({ ...item }));
    nextItems[index] = { ...nextItems[index], [field]: value };
    updateAttributes({ items: nextItems });
  };
  const addDescriptionItem = () => {
    if (!editorEditable || !descriptionEditable) return;
    updateAttributes({
      items: [...items, { label: "", body: "" }],
      itemIds: [...itemIds, nextGeneratedId("description-new")],
    });
  };
  const removeDescriptionItem = (index: number) => {
    if (!editorEditable || !descriptionEditable || items.length <= 1) return;
    updateAttributes({
      items: items.filter((_, itemIndex) => itemIndex !== index),
      itemIds: itemIds.filter((_, itemIndex) => itemIndex !== index),
    });
  };
  const descriptionKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    index: number,
    field: "label" | "body",
  ) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!editorEditable || !descriptionEditable) return;
    event.preventDefault();
    event.stopPropagation();
    const focusField = (item: number, name: "label" | "body") => {
      requestAnimationFrame(() => {
        objectRoot.current
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            `[aria-label="Description item ${item + 1} ${name}"]`,
          )
          ?.focus();
      });
    };
    if (field === "label") {
      focusField(index, "body");
      return;
    }
    const item = items[index];
    if (!item) return;
    const value = event.currentTarget.value;
    if (!item.label && !value) {
      const position = getPos();
      if (typeof position !== "number") return;
      const replacement: ProseMirrorNode[] = [];
      if (index > 0)
        replacement.push(
          node.type.create({
            ...node.attrs,
            items: items.slice(0, index),
            itemIds: itemIds.slice(0, index),
          }),
        );
      const paragraphPosition =
        position + replacement.reduce((size, part) => size + part.nodeSize, 0);
      replacement.push(editor.schema.nodes.paragraph!.create());
      if (index + 1 < items.length)
        replacement.push(
          node.type.create({
            ...node.attrs,
            sourceId: null,
            items: items.slice(index + 1),
            itemIds: itemIds.slice(index + 1),
          }),
        );
      const tr = editor.state.tr.replaceWith(position, position + node.nodeSize, replacement);
      tr.setSelection(TextSelection.create(tr.doc, paragraphPosition + 1));
      editor.view.dispatch(tr.scrollIntoView());
      editor.commands.focus(undefined, { scrollIntoView: false });
      return;
    }
    const from = event.currentTarget.selectionStart ?? value.length;
    const to = event.currentTarget.selectionEnd ?? from;
    updateAttributes({
      items: [
        ...items.slice(0, index),
        { ...item, body: value.slice(0, from) },
        { label: "", body: value.slice(to) },
        ...items.slice(index + 1),
      ],
      itemIds: [
        ...itemIds.slice(0, index + 1),
        nextGeneratedId("description-new"),
        ...itemIds.slice(index + 1),
      ],
    });
    focusField(index + 1, "label");
  };
  const updateCell = (rowIndex: number, cellIndex: number, value: string) => {
    if (!editorEditable || !tableEditable) return;
    const position = getPos();
    const currentNode = typeof position === "number" ? editor.state.doc.nodeAt(position) : null;
    if (!currentNode || currentNode.type !== node.type) return;
    const nextRows = (currentNode.attrs.rows as string[][]).map((row) => [...row]);
    if (!nextRows[rowIndex] || cellIndex >= nextRows[rowIndex]!.length) return;
    nextRows[rowIndex]![cellIndex] = value;
    updateAttributes({ rows: nextRows });
  };
  const updateTableStructure = (attributes: Record<string, unknown>) => {
    if (!editorEditable || !tableStructureEditable) return false;
    const position = getPos();
    if (typeof position !== "number") return false;
    updateAttributes({ ...attributes, tableCanonical: true });
    const accepted = editor.state.doc.nodeAt(position);
    const applied =
      accepted?.type === node.type &&
      Object.entries(attributes).every(
        ([key, value]) => JSON.stringify(accepted.attrs[key]) === JSON.stringify(value),
      );
    authoring.reportError?.(
      applied
        ? null
        : "This table change could not be applied. Finish any pending cell edit, then try again.",
    );
    return applied;
  };
  const focusTableCell = (row: number, column: number) => {
    const owner = tableLayout[row]?.[column];
    if (owner) {
      row = owner.row;
      column = owner.column;
    }
    requestAnimationFrame(() => {
      const field = tableRoot.current?.querySelector<HTMLElement>(
        `[data-table-cell="${row}-${column}"]`,
      );
      const inner = (field as (HTMLElement & { editor?: Editor }) | null)?.editor;
      if (inner) inner.commands.focus("end");
      else field?.focus();
    });
  };
  const focusCellWhitespace = (event: MouseEvent<HTMLTableCellElement>) => {
    if (!editorEditable || !tableEditable || event.button !== 0) return;
    if (tableRoot.current?.hasAttribute("data-table-selection")) return;
    const field = event.currentTarget.querySelector<HTMLElement>("[data-table-cell]");
    if (!field || (event.target instanceof globalThis.Node && field.contains(event.target))) return;
    event.preventDefault();
    event.stopPropagation();
    const inner = (field as HTMLElement & { editor?: Editor }).editor;
    if (inner) {
      const bounds = field.getBoundingClientRect();
      inner.commands.focus(
        event.clientX < bounds.left || event.clientY < bounds.top ? "start" : "end",
      );
    } else field.focus({ preventScroll: true });
  };
  const addTableRow = (after = selectedCell.row) => {
    if (!editorEditable || !tableStructureEditable || rows.length === 0) return;
    const insertion = Math.min(rows.length, Math.max(0, after + 1));
    const nextRows = rows.map((row) => [...row]);
    const nextRowIds = [...rowIds];
    nextRows.splice(
      insertion,
      0,
      Array.from({ length: rows[0]!.length }, () => ""),
    );
    nextRowIds.splice(insertion, 0, nextGeneratedId("table-row-new"));
    if (!updateTableStructure({ rows: nextRows, rowIds: nextRowIds })) return;
    setSelectedCell({ row: insertion, column: 0 });
    focusTableCell(insertion, 0);
  };
  const removeTableRow = () => {
    if (!tableStructureEditable || rows.length <= 1) return;
    const row = Math.min(selectedCell.row, rows.length - 1);
    const nextRows = rows.filter((_, index) => index !== row);
    const nextRowIds = rowIds.filter((_, index) => index !== row);
    const nextSelection = { row: Math.min(row, nextRows.length - 1), column: selectedCell.column };
    if (!updateTableStructure({ rows: nextRows, rowIds: nextRowIds })) return;
    setSelectedCell(nextSelection);
    focusTableCell(nextSelection.row, nextSelection.column);
  };
  const addTableColumn = (after = selectedCell.column) => {
    if (!tableStructureEditable || rows.length === 0) return;
    const insertion = Math.min(rows[0]!.length, Math.max(0, after + 1));
    const nextRows = rows.map((row) => {
      const next = [...row];
      next.splice(insertion, 0, "");
      return next;
    });
    const nextColumnIds = [...columnIds];
    const nextAlignments = [...columnAlignments];
    nextColumnIds.splice(insertion, 0, nextGeneratedId("table-column-new"));
    nextAlignments.splice(insertion, 0, "left");
    if (
      !updateTableStructure({
        rows: nextRows,
        columnIds: nextColumnIds,
        columnAlignments: nextAlignments,
      })
    )
      return;
    setSelectedCell({ row: selectedCell.row, column: insertion });
    focusTableCell(selectedCell.row, insertion);
  };
  const removeTableColumn = () => {
    if (!tableStructureEditable) return;
    const width = rows[0]?.length ?? 0;
    if (width <= 1) return;
    const column = Math.min(selectedCell.column, width - 1);
    const nextRows = rows.map((row) => row.filter((_, index) => index !== column));
    const nextColumnIds = columnIds.filter((_, index) => index !== column);
    const nextAlignments = columnAlignments.filter((_, index) => index !== column);
    const nextSelection = { row: selectedCell.row, column: Math.min(column, width - 2) };
    if (
      !updateTableStructure({
        rows: nextRows,
        columnIds: nextColumnIds,
        columnAlignments: nextAlignments,
      })
    )
      return;
    setSelectedCell(nextSelection);
    focusTableCell(nextSelection.row, nextSelection.column);
  };
  const moveTableRow = (direction: -1 | 1) => {
    if (!tableStructureEditable) return;
    const from = selectedCell.row;
    const to = from + direction;
    if (to < 0 || to >= rows.length) return;
    const nextRows = rows.map((row) => [...row]);
    const nextRowIds = [...rowIds];
    [nextRows[from], nextRows[to]] = [nextRows[to]!, nextRows[from]!];
    [nextRowIds[from], nextRowIds[to]] = [nextRowIds[to]!, nextRowIds[from]!];
    if (!updateTableStructure({ rows: nextRows, rowIds: nextRowIds })) return;
    setSelectedCell({ row: to, column: selectedCell.column });
    focusTableCell(to, selectedCell.column);
  };
  const moveTableColumn = (direction: -1 | 1) => {
    if (!tableStructureEditable) return;
    const from = selectedCell.column;
    const to = from + direction;
    const width = rows[0]?.length ?? 0;
    if (to < 0 || to >= width) return;
    const nextRows = rows.map((row) => {
      const next = [...row];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
    const nextColumnIds = [...columnIds];
    const nextAlignments = [...columnAlignments];
    [nextColumnIds[from], nextColumnIds[to]] = [nextColumnIds[to]!, nextColumnIds[from]!];
    const movedAlignment = nextAlignments[from]!;
    nextAlignments[from] = nextAlignments[to]!;
    nextAlignments[to] = movedAlignment;
    if (
      !updateTableStructure({
        rows: nextRows,
        columnIds: nextColumnIds,
        columnAlignments: nextAlignments,
      })
    )
      return;
    setSelectedCell({ row: selectedCell.row, column: to });
    focusTableCell(selectedCell.row, to);
  };
  const tableShortcut = useRef<(id: string) => boolean>(() => false);
  tableShortcut.current = (id) => {
    if (!editorEditable || !tableStructureEditable) return false;
    if (id === "table.addRow") addTableRow();
    else if (id === "table.deleteRow" && rows.length > 1) removeTableRow();
    else if (id === "table.addColumn") addTableColumn();
    else if (id === "table.deleteColumn" && (rows[0]?.length ?? 0) > 1) removeTableColumn();
    else return false;
    return true;
  };
  useEffect(() => {
    const root = tableRoot.current;
    if (!root || !tableEditable) return;
    return attachShortcutHost(root, "table", {
      capture: true,
      accepts: (event) =>
        editor.isEditable &&
        event.target instanceof Element &&
        Boolean(event.target.closest("[data-table-cell]")),
      execute: (id) => tableShortcut.current(id),
    });
  }, [tableEditable, editor]);
  if (kind === "title") {
    return (
      <LatexTitleView
        node={node}
        updateAttributes={updateAttributes}
        editor={editor}
        selected={selected}
        getPos={getPos}
        draftKey={workspace.draftKey}
        editable={editorEditable}
      />
    );
  }
  if (kind === "abstract") {
    return (
      <NodeViewWrapper
        className="scient-latex-abstract-preview"
        data-selected={selected || undefined}
        contentEditable={false}
      >
        <h2>{languageLabels.abstract}</h2>
        <LatexTextField
          aria-label="Abstract"
          draftKey={fieldDraft("body")}
          disabled={!editorEditable || !structureEditable}
          rows={1}
          value={String(node.attrs.body ?? "")}
          onValueChange={(body) => updateAttributes({ body })}
        />
      </NodeViewWrapper>
    );
  }
  if (kind === "part") {
    const position = getPos();
    let ordinal = 1;
    if (typeof position === "number")
      editor.state.doc.nodesBetween(0, position, (earlier) => {
        if (
          earlier.type.name === "latexRichPreview" &&
          earlier.attrs.kind === "part" &&
          earlier.attrs.unnumbered !== true
        )
          ordinal += 1;
      });
    return (
      <NodeViewWrapper
        ref={objectRoot}
        className="scient-latex-rich-preview scient-latex-part-preview"
        contentEditable={false}
        onFocusCapture={focusObject}
      >
        <LatexObjectToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          label="Part tools"
          position="Part"
          inline
        >
          <PartNumberedOption
            editor={editor}
            getPos={getPos}
            fallback={node.attrs.unnumbered !== true}
            disabled={!editorEditable || !structureEditable}
            updateAttributes={updateAttributes}
          />
          <LatexFooterLabel
            label="Part reference label"
            value={String(node.attrs.label ?? "")}
            disabled={!editorEditable || !structureEditable}
            draftKey={fieldDraft("label")}
            onCommit={(label) => updateAttributes({ label })}
          />
        </LatexObjectToolbar>
        {node.attrs.unnumbered === true ? null : (
          <div className="scient-latex-part-number">Part {latexRomanNumber(ordinal)}</div>
        )}
        <LatexTextField
          aria-label="Part title"
          rows={1}
          draftKey={fieldDraft("title")}
          disabled={!editorEditable || !structureEditable}
          value={String(node.attrs.title ?? "")}
          onValueChange={(title) => updateAttributes({ title })}
        />
      </NodeViewWrapper>
    );
  }
  if (kind === "simple") {
    const environment = String(node.attrs.environment ?? "quotation");
    if (sourceMeta?.literal === true) {
      const boxLayout = sourceMeta.boxLayout as
        | NonNullable<ReturnType<typeof latexColorBoxOpening>>["layout"]
        | null;
      return (
        <NodeViewWrapper
          ref={objectRoot}
          className={
            boxLayout
              ? "scient-latex-simple-preview scient-latex-color-box scient-latex-framed-listing"
              : "scient-latex-simple-preview"
          }
          data-environment={environment}
          contentEditable={false}
          onFocusCapture={focusObject}
          style={
            boxLayout
              ? ({
                  "--scient-box-background": latexColorCss(boxLayout.colback),
                  "--scient-box-frame": latexColorCss(boxLayout.colframe),
                  "--scient-box-title": latexColorCss(boxLayout.coltitle),
                  "--scient-box-padding": boxLayout.padding,
                  borderWidth: boxLayout.borderWidth,
                  borderRadius: boxLayout.radius,
                } as CSSProperties)
              : undefined
          }
        >
          {boxLayout && node.attrs.title && (
            <div className="scient-latex-color-box-title">
              <LatexStatementTitle
                editor={editor}
                label="Box title"
                value={String(node.attrs.title)}
                source={escapeText(String(node.attrs.title))}
                editing={statementTitleEditing}
                editable={editorEditable && structureEditable}
                draftKey={fieldDraft("title")}
                onEditing={setStatementTitleEditing}
                onChange={(title) => updateAttributes({ title })}
                onExit={() =>
                  objectRoot.current
                    ?.querySelector<HTMLTextAreaElement>('[aria-label="Code listing"]')
                    ?.focus({ preventScroll: true })
                }
              />
            </div>
          )}
          <LatexLiteralCodeView
            environment={environment}
            body={String(node.attrs.body ?? "")}
            caption={typeof node.attrs.caption === "string" ? node.attrs.caption : null}
            captionEditing={environment === "lstlisting" && captionEditing}
            ordinal={listingOrdinal ?? ""}
            presentation={
              (sourceMeta.listingPresentation ?? null) as LatexListingPresentation | null
            }
            disabled={!editorEditable || !structureEditable}
            bodyDraftKey={fieldDraft("body")}
            captionDraftKey={fieldDraft("caption")}
            onBodyChange={(body) => updateAttributes({ body })}
            onCaptionEditing={setCaptionEditing}
            onCaptionChange={(caption) =>
              updateAttributes({ caption: caption || null, ...(caption ? {} : { label: null }) })
            }
            onExit={() => leaveObject(1)}
          />
          {environment === "lstlisting" && (
            <LatexObjectToolbar
              editor={editor}
              root={objectRoot}
              selected={selected}
              label="Code tools"
              position="Code"
              inline
            >
              <LatexCodeControls
                node={node}
                editor={editor}
                getPos={getPos}
                updateAttributes={updateAttributes}
                editable={editorEditable && structureEditable}
                draftKey={fieldDraft("label")}
                onCaption={() => {
                  setCaptionEditing(true);
                  requestAnimationFrame(() =>
                    objectRoot.current
                      ?.querySelector<HTMLTextAreaElement>('[aria-label="Listing caption"]')
                      ?.focus({ preventScroll: true }),
                  );
                }}
              />
            </LatexObjectToolbar>
          )}
        </NodeViewWrapper>
      );
    }
    const label =
      (
        {
          quotation: "Quotation",
          verse: "Verse",
          verbatim: "Verbatim",
          "verbatim*": "Verbatim*",
          alltt: "LyX-Code",
          lstlisting: "LyX-Code",
          flushleft: "Address",
          flushright: "Right Address",
        } as Record<string, string>
      )[environment] ?? environment;
    return (
      <NodeViewWrapper
        ref={objectRoot}
        className="scient-latex-simple-preview"
        data-environment={environment}
        contentEditable={false}
        onFocusCapture={focusObject}
      >
        <LatexTextField
          aria-label={label}
          rows={environment === "quotation" ? 2 : 1}
          draftKey={fieldDraft("body")}
          disabled={!editorEditable || !structureEditable}
          value={String(node.attrs.body ?? "")}
          onValueChange={(body) => updateAttributes({ body })}
        />
      </NodeViewWrapper>
    );
  }
  if (kind === "compiledAlgorithm") {
    return (
      <NodeViewWrapper
        ref={objectRoot}
        contentEditable={false}
        className="scient-latex-compiled-algorithm"
      >
        <LatexTikzArtwork
          source={compiledAlgorithmPresentation?.source ?? String(node.attrs.raw)}
          preamble={authoring?.source.slice(0, latexPreambleEnd(authoring.source)) ?? ""}
          environmentId={workspace.environmentId}
          cwd={workspace.cwd}
          relativePath={drawingRootPath ?? workspace.relativePath}
          algorithmNumber={
            compiledAlgorithmPresentation?.number == null
              ? undefined
              : Number(compiledAlgorithmPresentation.number)
          }
          label="Compiled algorithm"
        />
      </NodeViewWrapper>
    );
  }
  if (kind === "bibliography") {
    const external = sourceMeta?.externalBibliography === true;
    const bibliographyItems = external ? (bibliographyPresentation?.items ?? []) : items;
    return (
      <NodeViewWrapper
        ref={objectRoot}
        className="scient-latex-rich-preview scient-latex-bibliography-preview"
        contentEditable={false}
        onFocusCapture={focusObject}
      >
        <h2>{bibliographyPresentation?.title ?? "References"}</h2>
        {external && !bibliographyPresentation?.items && (
          <p>
            Rebuild the PDF to display the bibliography. Manage entries in Document → References.
          </p>
        )}
        <ol>
          {bibliographyItems.map((item, index) => (
            <Fragment key={`${String(item.label ?? "")}:${index}`}>
              {objectPageGaps[index] ? (
                <li
                  className="scient-latex-object-page-gap"
                  aria-hidden="true"
                  style={{ height: objectPageGaps[index] }}
                />
              ) : null}
              <li
                data-latex-bibliography-item={index}
                onPointerDown={() => setDescriptionItem(index)}
              >
                <span className="scient-latex-bibliography-label">
                  [{bibliographyPresentation?.labels[index] ?? "?"}]
                </span>
                <LatexProsePreview
                  source={
                    sourceMeta?.bibliographySource === true || external
                      ? String(item.body ?? "")
                      : escapeText(String(item.body ?? ""))
                  }
                />
              </li>
            </Fragment>
          ))}
        </ol>
      </NodeViewWrapper>
    );
  }
  if (kind === "toc") {
    const entries = contentsPresentation ?? [];
    const listKind =
      node.attrs.environment === "listoffigures"
        ? "figures"
        : node.attrs.environment === "listoftables"
          ? "tables"
          : "contents";
    return (
      <NodeViewWrapper
        className="scient-latex-toc-preview"
        data-list-kind={listKind}
        contentEditable={false}
      >
        <h2>
          {listKind === "figures"
            ? languageLabels.figures
            : listKind === "tables"
              ? languageLabels.tables
              : languageLabels.contents}
        </h2>
        {entries.length > 0 ? (
          <ol>
            {entries.map((entry, index) => (
              <Fragment key={index}>
                {objectPageGaps[index] ? (
                  <li
                    className="scient-latex-object-page-gap"
                    aria-hidden="true"
                    style={{ height: objectPageGaps[index] }}
                  />
                ) : null}
                <li
                  data-level={Number(entry.level ?? 1)}
                  data-unnumbered={!entry.number || undefined}
                  data-latex-toc-entry={index}
                >
                  <button
                    type="button"
                    aria-label={`Go to ${entry.title}`}
                    onClick={() =>
                      navigateToEquation(editor.view, {
                        position: entry.position,
                        row: 0,
                        number: entry.number,
                        kind: entry.kind,
                      })
                    }
                  >
                    <span>{String(entry.number ?? "")}</span>
                    <span className="scient-latex-toc-title">
                      <span>{String(entry.title ?? "")}</span>
                    </span>
                    <span className="scient-latex-toc-page">{entry.page ?? ""}</span>
                  </button>
                </li>
              </Fragment>
            ))}
          </ol>
        ) : (
          <p>
            {listKind === "contents"
              ? "The table of contents will be generated from headings and explicit contents entries."
              : `No captioned ${listKind} yet.`}
          </p>
        )}
      </NodeViewWrapper>
    );
  }
  if (kind === "documentCommand") {
    return (
      <NodeViewWrapper
        className="scient-latex-document-command"
        contentEditable={false}
        aria-hidden="true"
      />
    );
  }
  if (kind === "spacing") {
    return (
      <NodeViewWrapper
        className="scient-latex-layout-spacing"
        data-spacing={String(node.attrs.environment)}
        contentEditable={false}
        aria-hidden="true"
      />
    );
  }
  if (kind === "pagebreak") {
    const command =
      String(node.attrs.raw ?? "").trim() === "\\clearpage" ? "\\clearpage" : "\\newpage";
    return (
      <NodeViewWrapper
        aria-label={`${command} page break`}
        className="scient-latex-page-break"
        contentEditable={false}
      />
    );
  }
  if (kind === "figureLayout") {
    const panels = (sourceMeta?.panels ?? []) as LatexFigurePanel[];
    const figureItems = (node.attrs.items ?? []) as {
      body: string;
      path: string;
      caption: string;
      label: string;
    }[];
    const editable = editorEditable && structureEditable;
    const changeItem = (
      index: number,
      field: "body" | "caption" | "label" | "path",
      value: string,
    ) => {
      if (!editable) return false;
      updateAttributes({
        items: figureItems.map((item, at) => (at === index ? { ...item, [field]: value } : item)),
      });
      const position = getPos();
      return (
        typeof position === "number" &&
        editor.state.doc.nodeAt(position)?.attrs.items?.[index]?.[field] === value
      );
    };
    const activePanel = Math.min(descriptionItem, panels.length - 1);
    const panel = panels[activePanel];
    const item = figureItems[activePanel];
    const focusCaption = (index?: number) =>
      requestAnimationFrame(() =>
        objectRoot.current
          ?.querySelector<HTMLTextAreaElement>(
            index === undefined
              ? '[aria-label="Figure caption"]'
              : `[aria-label="Panel ${index + 1} caption"]`,
          )
          ?.focus({ preventScroll: true }),
      );
    return (
      <NodeViewWrapper
        ref={objectRoot}
        className="scient-latex-rich-preview scient-latex-figure-preview scient-latex-figure-layout"
        contentEditable={false}
        onFocusCapture={focusObject}
      >
        <LatexObjectToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          label="Figure tools"
          position="Figure"
          inline
        >
          {panels.length > 1 && (
            <DockMenu icon={undefined} label="Panel" commandScope="latex">
              <MenuRadioGroup value={String(activePanel)}>
                {panels.map((_panel, index) => (
                  <DockCommandRadioItem
                    key={index}
                    value={String(index)}
                    size="compact"
                    onClick={() => setDescriptionItem(index)}
                  >
                    Panel {index + 1}
                  </DockCommandRadioItem>
                ))}
              </MenuRadioGroup>
            </DockMenu>
          )}
          {panel?.path != null &&
            item &&
            workspace.environmentId &&
            workspace.cwd &&
            workspace.relativePath && (
              <DockMenu icon={undefined} label="Replace" commandScope="latex" disabled={!editable}>
                <ReplacementImages
                  environmentId={workspace.environmentId}
                  cwd={workspace.cwd}
                  onChoose={(path) =>
                    changeItem(
                      activePanel,
                      "path",
                      relativeLatexImagePath(workspace.relativePath!, path),
                    )
                  }
                />
              </DockMenu>
            )}
          {Boolean(sourceMeta?.captionRange) && (
            <button
              type="button"
              className={dockButtonClass()}
              disabled={!editable}
              onClick={() => focusCaption()}
            >
              Caption
            </button>
          )}
          {Boolean(sourceMeta?.labelRange) && (
            <LatexFooterLabel
              label="Figure reference label"
              value={tableLabel}
              disabled={!editable}
              draftKey={fieldDraft("label")}
              onCommit={(label) => updateAttributes({ label })}
            />
          )}
          {panel?.captionRange && (
            <button
              type="button"
              className={dockButtonClass()}
              disabled={!editable}
              onClick={() => focusCaption(activePanel)}
            >
              Panel caption
            </button>
          )}
          {panel?.labelRange && item && (
            <LatexFooterLabel
              label="Panel reference label"
              value={item.label}
              disabled={!editable}
              draftKey={fieldDraft(`panel:${activePanel}:label`)}
              onCommit={(value) => changeItem(activePanel, "label", value)}
            />
          )}
        </LatexObjectToolbar>
        <figure>
          <div
            className="scient-latex-figure-panels"
            data-spread={sourceMeta?.spreadPanels === true || undefined}
          >
            {panels.map((panel, index) => {
              const item = figureItems[index]!;
              const letter = figurePresentation?.panels[index] ?? null;
              return (
                <div
                  key={index}
                  className="scient-latex-figure-panel"
                  data-latex-figure-panel={index}
                  onPointerDownCapture={() => setDescriptionItem(index)}
                  onFocusCapture={() => setDescriptionItem(index)}
                  style={{ width: panel.panelWidth ?? "100%" }}
                >
                  <LatexFigureArtwork artwork={panel}>
                    {panel.tikz ? (
                      <LatexTikzArtwork
                        source={item.body}
                        preamble={
                          authoring?.source.slice(0, latexPreambleEnd(authoring.source)) ?? ""
                        }
                        environmentId={workspace.environmentId}
                        cwd={workspace.cwd}
                        relativePath={drawingRootPath ?? workspace.relativePath}
                      />
                    ) : panel.path !== null ? (
                      <LatexFigureImage
                        alt={item.caption || caption}
                        path={item.path}
                        width={"\\linewidth"}
                        workspace={workspace}
                      />
                    ) : (
                      <LatexTextField
                        aria-label={`Figure panel ${index + 1} text`}
                        draftKey={fieldDraft(`panel:${index}:body`)}
                        disabled={!editable}
                        rows={1}
                        value={item.body}
                        onValueChange={(value) => changeItem(index, "body", value)}
                      />
                    )}
                  </LatexFigureArtwork>
                  {panel.captionRange ? (
                    <div className="scient-latex-subfigure-caption">
                      {letter ? <span>({letter})</span> : null}
                      <LatexTextField
                        aria-label={`Panel ${index + 1} caption`}
                        draftKey={fieldDraft(`panel:${index}:caption`)}
                        disabled={!editable}
                        rows={1}
                        value={item.caption}
                        onValueChange={(value) => changeItem(index, "caption", value)}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {sourceMeta?.captionRange ? (
            <figcaption className="scient-latex-figure-numbered-caption">
              {figurePresentation?.number ? (
                <span>
                  {languageLabels.figure} {figurePresentation.number}:
                </span>
              ) : null}
              <LatexTextField
                aria-label="Figure caption"
                draftKey={fieldDraft("caption")}
                disabled={!editable}
                rows={1}
                value={caption}
                onValueChange={(caption) => updateAttributes({ caption })}
              />
            </figcaption>
          ) : null}
        </figure>
      </NodeViewWrapper>
    );
  }
  if (kind === "figure") {
    const figureEditable = structureEditable && editorEditable;
    const hasCaption = latexVisualFloatHasCaption({ attrs: node.attrs });
    const captionPosition = String(node.attrs.figureCaptionPosition ?? "below");
    const figureCaption =
      hasCaption || captionEditing ? (
        <figcaption className="scient-latex-figure-numbered-caption">
          {hasCaption && figurePresentation?.number ? (
            <span>
              {languageLabels.figure} {figurePresentation.number}:
            </span>
          ) : null}
          <LatexTextField
            aria-label="Figure caption"
            rows={1}
            disabled={!figureEditable}
            onRemoveEmpty={removeEmptyCaption}
            draftKey={fieldDraft("caption")}
            value={caption}
            onFocus={() => setCaptionEditing(true)}
            onBlur={() => setCaptionEditing(false)}
            onValueChange={(caption) =>
              updateAttributes({
                caption,
                captionRemoved: caption === "",
                ...(caption === "" ? { label: "" } : {}),
              })
            }
          />
        </figcaption>
      ) : null;
    return (
      <NodeViewWrapper
        ref={objectRoot}
        onFocusCapture={focusObject}
        className="scient-latex-rich-preview scient-latex-figure-preview"
        contentEditable={false}
      >
        <LatexFigureToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          editable={figureEditable}
          workspace={workspace}
          width={String(node.attrs.figureWidth ?? "")}
          alignment={String(node.attrs.figureAlignment ?? "center")}
          placement={String(node.attrs.figurePlacement ?? "")}
          captionPosition={captionPosition}
          hasCaption={hasCaption}
          label={String(node.attrs.label ?? "")}
          draftKey={fieldDraft("label")}
          onReplace={(path) => updateAttributes({ path })}
          onAppearance={(attrs) => updateAttributes(attrs)}
          onLabel={(label) => updateAttributes({ label })}
          onCaption={() => {
            setCaptionEditing(true);
            requestAnimationFrame(() =>
              objectRoot.current
                ?.querySelector<HTMLTextAreaElement>('[aria-label="Figure caption"]')
                ?.focus(),
            );
          }}
          onDelete={deleteNode}
        />
        <figure data-align={String(node.attrs.figureAlignment ?? "center")}>
          {captionPosition === "above" && figureCaption}
          <LatexFigureImage
            alt={caption}
            path={String(node.attrs.path ?? "")}
            width={String(node.attrs.figureWidth ?? "")}
            workspace={workspace}
          />
          {captionPosition !== "above" && figureCaption}
        </figure>
      </NodeViewWrapper>
    );
  }
  if (kind === "scientific") {
    const scientificEditable = structureEditable && editorEditable;
    const environment = String(node.attrs.environment ?? "theorem");
    const title = String(node.attrs.title ?? "");
    const proof = environment === "proof";
    const exitTitle = () => {
      objectRoot.current
        ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Scientific statement body"]')
        ?.focus();
    };
    const titleField = (
      <LatexStatementTitle
        editor={editor}
        value={title}
        source={escapeText(title)}
        editing={statementTitleEditing}
        editable={scientificEditable}
        draftKey={fieldDraft("title")}
        onEditing={setStatementTitleEditing}
        onChange={(title) => updateAttributes({ title, titleRemoved: title === "" })}
        onExit={exitTitle}
      />
    );
    return (
      <NodeViewWrapper
        ref={objectRoot}
        onFocusCapture={focusObject}
        className="scient-latex-rich-preview scient-latex-scientific-preview"
        data-environment={environment}
        contentEditable={false}
      >
        <LatexStatementToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          editable={scientificEditable}
          environment={environment}
          proof={proof}
          hasTitle={Boolean(title)}
          labels={[
            { id: "label", value: String(node.attrs.label ?? ""), draftKey: fieldDraft("label") },
          ]}
          onType={(environment) => updateAttributes({ environment })}
          onTitle={() => {
            setStatementTitleEditing(true);
            requestAnimationFrame(() => {
              const field = objectRoot.current?.querySelector<HTMLTextAreaElement>(
                ".scient-latex-statement-title textarea",
              );
              field?.focus({ preventScroll: true });
              field?.setSelectionRange(0, 0);
            });
          }}
          onLabel={(_id, label) => updateAttributes({ label })}
        />
        <div className="scient-latex-scientific-heading">
          <strong>
            {proof && (title || statementTitleEditing)
              ? titleField
              : environment[0]!.toUpperCase() + environment.slice(1)}
            {!proof && (title || statementTitleEditing) ? <> ({titleField})</> : null}.
          </strong>
        </div>
        <LatexTextField
          aria-label="Scientific statement body"
          disabled={!scientificEditable}
          rows={1}
          draftKey={fieldDraft("body")}
          value={String(node.attrs.body ?? "")}
          onValueChange={(body) => updateAttributes({ body })}
        />
      </NodeViewWrapper>
    );
  }
  const tableCaption =
    kind === "table" &&
    (tableHasCaption || captionEditing ? (
      <figcaption
        data-placement={tablePresentation.captionAfter ? "below" : "above"}
        data-numbered={tableNumber !== null || undefined}
      >
        {tableHasCaption && tableNumber !== null ? (
          <span className="scient-latex-table-caption-number">
            {languageLabels.table} {tableNumber}:{" "}
          </span>
        ) : null}
        {captionEditable ? (
          <LatexTextField
            aria-label="Table caption"
            draftKey={fieldDraft("caption")}
            onRemoveEmpty={removeEmptyCaption}
            onFocus={() => setCaptionEditing(true)}
            onBlur={() => setCaptionEditing(false)}
            rows={1}
            disabled={!editorEditable}
            value={caption}
            onValueChange={(nextCaption) => {
              updateAttributes({
                caption: nextCaption,
                captionRemoved: nextCaption === "",
                ...(nextCaption === "" ? { label: "" } : {}),
              });
            }}
          />
        ) : (
          caption
        )}
      </figcaption>
    ) : null);
  return (
    <NodeViewWrapper
      ref={objectRoot}
      className="scient-latex-rich-preview"
      data-kind={kind}
      data-document-selected={
        decorations.some((decoration) => decoration.spec.latexDocumentSelected === true) ||
        undefined
      }
      data-description-style={
        kind === "description" ? String(node.attrs.descriptionStyle ?? "standard") : undefined
      }
      data-selected={selected || undefined}
      contentEditable={false}
      style={
        kind === "description" && typeof node.attrs.descriptionLeftMargin === "string"
          ? ({
              "--scient-description-left-margin": node.attrs.descriptionLeftMargin,
            } as CSSProperties)
          : undefined
      }
      onFocusCapture={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.target)) return;
        focusObject(event);
        if (kind !== "table") setObjectActive(true);
      }}
      onBlurCapture={(event: FocusEvent<HTMLElement>) => {
        if (
          kind !== "table" &&
          event.currentTarget.contains(event.target) &&
          !event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)
        )
          setObjectActive(false);
      }}
    >
      {kind === "description" ? (
        <>
          <LatexObjectToolbar
            editor={editor}
            root={objectRoot}
            selected={selected}
            label="Description list tools"
            position="List"
            inline
          >
            <DockMenu
              icon={undefined}
              label="Items"
              commandScope="latex"
              disabled={!editorEditable || !descriptionEditable}
            >
              <DockCommandItem onClick={addDescriptionItem}>Insert item</DockCommandItem>
              <DockCommandItem
                disabled={items.length <= 1}
                onClick={() => removeDescriptionItem(Math.min(descriptionItem, items.length - 1))}
              >
                Delete item
              </DockCommandItem>
            </DockMenu>
          </LatexObjectToolbar>
          <dl>
            {keyedItems.map(({ index, key, value: item }) => (
              <Fragment key={key}>
                {objectPageGaps[index] ? (
                  <div
                    className="scient-latex-object-page-gap"
                    aria-hidden="true"
                    style={{ height: objectPageGaps[index] }}
                  />
                ) : null}
                <div
                  data-latex-description-item={index}
                  onFocusCapture={() => setDescriptionItem(index)}
                >
                  <dt>
                    {descriptionEditable ? (
                      <input
                        aria-label={`Description item ${index + 1} label`}
                        onKeyDown={(event) => descriptionKeyDown(event, index, "label")}
                        disabled={!editorEditable}
                        data-empty={!String(item.label ?? "").trim() || undefined}
                        value={String(item.label ?? "")}
                        onChange={(event) =>
                          updateDescriptionItem(index, "label", event.currentTarget.value)
                        }
                      />
                    ) : (
                      String(item.label ?? "")
                    )}
                  </dt>
                  <dd>
                    {descriptionEditable ? (
                      <textarea
                        aria-label={`Description item ${index + 1} body`}
                        onKeyDown={(event) => descriptionKeyDown(event, index, "body")}
                        disabled={!editorEditable}
                        rows={1}
                        data-empty={!String(item.body ?? "").trim() || undefined}
                        value={String(item.body ?? "")}
                        onChange={(event) =>
                          updateDescriptionItem(index, "body", event.currentTarget.value)
                        }
                      />
                    ) : (
                      String(item.body ?? "")
                    )}
                  </dd>
                </div>
              </Fragment>
            ))}
          </dl>
        </>
      ) : (
        <figure
          ref={tableRoot}
          tabIndex={-1}
          aria-label="Table selection"
          data-table-style={String(node.attrs.tableStyle ?? "plain")}
          data-table-kind={String(node.attrs.tableKind ?? "fixed")}
          data-table-float={tablePresentation.hasFloat || undefined}
        >
          <LatexTableToolbar
            source={serializeLatexVisualBlock(node.toJSON()) ?? String(node.attrs.raw ?? "")}
            onProperties={(action) => {
              if (!authoring.prepare()) return;
              const selection = tableSelection.selection;
              const bounds = selection
                ? latexTableSelectionBounds(
                    tableLayout,
                    Math.min(selection.anchor.row, selection.head.row),
                    Math.max(selection.anchor.row, selection.head.row),
                    Math.min(selection.anchor.column, selection.head.column),
                    Math.max(selection.anchor.column, selection.head.column),
                  )
                : {
                    firstRow: selectedCell.row,
                    lastRow: selectedCell.row,
                    firstColumn: selectedCell.column,
                    lastColumn: selectedCell.column,
                  };
              const error = editLatexObjectSource(editor, getPos(), authoring.source, (source) =>
                editLatexTable(source, bounds, action),
              );
              authoring.reportError?.(error);
            }}
            editor={editor}
            tableRoot={tableRoot}
            selected={selected}
            editable={editorEditable && tableEditable}
            structureEditable={editorEditable && tableStructureEditable}
            canMergeCells={Boolean(
              tableSelection.selection &&
              (tableSelection.selection.anchor.row !== tableSelection.selection.head.row ||
                tableSelection.selection.anchor.column !== tableSelection.selection.head.column),
            )}
            canSplitCell={Boolean(
              firstSelectedTableCell &&
              (firstSelectedTableCell.rowSpan > 1 || firstSelectedTableCell.colSpan > 1),
            )}
            row={selectedCell.row}
            column={selectedCell.column}
            rowCount={rows.length}
            columnCount={rows[0]?.length ?? 0}
            style={String(node.attrs.tableStyle ?? "plain")}
            width={String(node.attrs.tableKind ?? "fixed")}
            header={node.attrs.hasHeader === true}
            hasCaption={tableHasCaption}
            label={tableLabel}
            draftKey={fieldDraft("label")}
            captionEditable={captionEditable}
            labelEditable={labelEditable}
            onActiveChange={setObjectActive}
            onAddRow={addTableRow}
            onRemoveRow={removeTableRow}
            onMoveRow={moveTableRow}
            onAddColumn={addTableColumn}
            onRemoveColumn={removeTableColumn}
            onMoveColumn={moveTableColumn}
            onStyle={(tableStyle) => updateTableStructure({ tableStyle })}
            onWidth={(tableKind) => updateTableStructure({ tableKind })}
            onHeader={() => updateTableStructure({ hasHeader: node.attrs.hasHeader !== true })}
            onEditCaption={() => {
              setCaptionEditing(true);
              requestAnimationFrame(() =>
                tableRoot.current
                  ?.querySelector<HTMLTextAreaElement>('[aria-label="Table caption"]')
                  ?.focus(),
              );
            }}
            onLabel={(label) => {
              updateAttributes({ label });
            }}
            onDelete={deleteNode}
          />
          {!tablePresentation.captionAfter && tableCaption}
          <div className="scient-latex-rich-table-scroll">
            <table
              data-mixed-columns={mixedTableColumns || undefined}
              data-trim-left={
                (!node.attrs.tableCanonical && tablePresentation.trimLeft) || undefined
              }
              data-trim-right={
                (!node.attrs.tableCanonical && tablePresentation.trimRight) || undefined
              }
              style={{
                fontSize: `var(--scient-latex-size-${tablePresentation.size})`,
                lineHeight: `var(--scient-latex-baseline-${tablePresentation.size})`,
                width:
                  !node.attrs.tableCanonical && node.attrs.tableKind === "stretch"
                    ? tablePresentation.width
                    : undefined,
              }}
            >
              {!node.attrs.tableCanonical &&
              (mixedTableColumns ||
                tablePresentation.columnWidths.some((width) => width !== null)) ? (
                <colgroup>
                  {tablePresentation.columnWidths.map((width, index) => (
                    <col
                      key={columnIds[index] ?? index}
                      style={
                        width === null
                          ? tableColumnKinds[index] === "natural" && mixedTableColumns
                            ? { width: "1px" }
                            : undefined
                          : {
                              width: `${
                                width * CSS_PIXELS_PER_INCH +
                                (12 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH -
                                (index === 0 && tablePresentation.trimLeft
                                  ? (6 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH
                                  : 0) -
                                (index === tablePresentation.columnWidths.length - 1 &&
                                tablePresentation.trimRight
                                  ? (6 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH
                                  : 0)
                              }px`,
                            }
                      }
                    />
                  ))}
                </colgroup>
              ) : null}
              <tbody>
                {keyedRows.map(({ index: rowIndex, key, value: row }) => (
                  <Fragment key={key}>
                    {objectPageGaps[rowIndex] && longtable ? (
                      <LatexLongTableBand
                        band={longtable.foot}
                        kind="foot"
                        columns={row.length}
                        alignments={columnAlignments}
                        number={tableNumber ?? null}
                      />
                    ) : null}
                    {objectPageGaps[rowIndex] ? (
                      <tr key="page-gap" className="scient-latex-table-page-gap" aria-hidden="true">
                        <td colSpan={Math.max(1, row.length)}>
                          <div
                            style={{
                              height: Math.max(
                                0,
                                objectPageGaps[rowIndex]! -
                                  (longtable
                                    ? continuationHeights.head + continuationHeights.foot
                                    : 0),
                              ),
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                    {objectPageGaps[rowIndex] && longtable ? (
                      <LatexLongTableBand
                        band={longtable.head}
                        kind="head"
                        columns={row.length}
                        alignments={columnAlignments}
                        number={tableNumber ?? null}
                      />
                    ) : null}
                    <tr
                      key="row"
                      data-latex-table-row={rowIndex}
                      data-page-start={Boolean(objectPageGaps[rowIndex]) || undefined}
                      data-page-end={Boolean(objectPageGaps[rowIndex + 1]) || undefined}
                    >
                      {(tableEditable
                        ? row.map((cell, index) => ({
                            index,
                            key: columnIds[index] ?? `table-column-${index}`,
                            value: cell,
                          }))
                        : withStableKeys(row, String)
                      ).map(({ index: cellIndex, key: cellKey, value: cell }) => {
                        const layout = tableLayout[rowIndex]?.[cellIndex];
                        if (layout && (layout.row !== rowIndex || layout.column !== cellIndex))
                          return null;
                        const format = tableFormatting[rowIndex]?.[cellIndex];
                        const columnKind = tableColumnKinds[cellIndex] ?? "natural";
                        const cellStyle: CSSProperties & {
                          "--scient-latex-table-cell-background"?: string;
                        } = {
                          fontWeight: format?.bold ? 700 : 400,
                          fontStyle: !tableEditable && format?.italic ? "italic" : "normal",
                          fontFamily:
                            !tableEditable && format?.monospace
                              ? '"KaTeX_Typewriter", var(--font-mono)'
                              : undefined,
                          fontVariantCaps:
                            !tableEditable && format?.smallCaps ? "small-caps" : undefined,
                          textDecoration:
                            !tableEditable && format?.underline ? "underline" : undefined,
                          ...(layout
                            ? {
                                borderTop: layout.top
                                  ? `0.5px solid ${layout.topColor ?? "currentColor"}`
                                  : "0",
                                borderBottom: layout.bottom
                                  ? `0.5px solid ${layout.bottomColor ?? "currentColor"}`
                                  : "0",
                                borderLeft: layout.left
                                  ? `0.5px solid ${layout.ruleColor ?? "currentColor"}`
                                  : "0",
                                borderRight: layout.right
                                  ? `0.5px solid ${layout.ruleColor ?? "currentColor"}`
                                  : "0",
                                verticalAlign: layout.rowSpan > 1 ? "middle" : "top",
                                "--scient-latex-table-cell-background":
                                  layout.background ?? "transparent",
                              }
                            : {}),
                        };
                        const content = tableEditable ? (
                          <LatexInlineField
                            owner={editor}
                            extensions={inlineFieldExtensions}
                            source={cell}
                            label={`Table row ${rowIndex + 1} column ${cellIndex + 1}`}
                            cell={`${rowIndex}-${cellIndex}`}
                            width={
                              columnKind === "flexible"
                                ? "stretch"
                                : columnKind === "fixed"
                                  ? "fixed"
                                  : "content"
                            }
                            style={
                              !node.attrs.tableCanonical &&
                              tablePresentation.columnWidths[cellIndex] != null
                                ? {
                                    width: `${tablePresentation.columnWidths[cellIndex]! * CSS_PIXELS_PER_INCH}px`,
                                  }
                                : undefined
                            }
                            disabled={!editorEditable}
                            draftKey={fieldDraft(`cell:${key}:${cellKey}`)}
                            onFocus={() => setSelectedCell({ row: rowIndex, column: cellIndex })}
                            onChange={(value) => {
                              updateCell(rowIndex, cellIndex, value);
                              const position = getPos();
                              return (
                                typeof position === "number" &&
                                editor.state.doc.nodeAt(position)?.attrs.rows?.[rowIndex]?.[
                                  cellIndex
                                ] === value
                              );
                            }}
                            onTab={(direction) => {
                              const current = tableCells.findIndex(
                                (item) => item.row === rowIndex && item.column === cellIndex,
                              );
                              const next = tableCells[current + direction];
                              if (next) focusTableCell(next.row, next.column);
                              else if (direction > 0 && tableStructureEditable)
                                addTableRow(rows.length - 1);
                              else leaveObject(direction);
                            }}
                            onExit={leaveObject}
                          />
                        ) : (
                          cell
                        );
                        return node.attrs.hasHeader === true && rowIndex === 0 ? (
                          <th
                            colSpan={layout?.colSpan}
                            rowSpan={layout?.rowSpan}
                            style={cellStyle}
                            data-cell-selection={
                              tableSelectionContains(
                                tableSelection.selection,
                                rowIndex,
                                cellIndex,
                              ) || undefined
                            }
                            onMouseDownCapture={focusCellWhitespace}
                            data-align={layout?.alignment ?? columnAlignments[cellIndex] ?? "left"}
                            data-selected={
                              controlsVisible &&
                              selectedCell.row === rowIndex &&
                              selectedCell.column === cellIndex
                                ? true
                                : undefined
                            }
                            key={cellKey}
                            scope="col"
                          >
                            {content}
                          </th>
                        ) : (
                          <td
                            colSpan={layout?.colSpan}
                            rowSpan={layout?.rowSpan}
                            style={cellStyle}
                            data-cell-selection={
                              tableSelectionContains(
                                tableSelection.selection,
                                rowIndex,
                                cellIndex,
                              ) || undefined
                            }
                            onMouseDownCapture={focusCellWhitespace}
                            data-align={layout?.alignment ?? columnAlignments[cellIndex] ?? "left"}
                            data-selected={
                              controlsVisible &&
                              selectedCell.row === rowIndex &&
                              selectedCell.column === cellIndex
                                ? true
                                : undefined
                            }
                            key={cellKey}
                          >
                            {content}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                ))}
                {longtable ? (
                  <LatexLongTableBand
                    band={longtable.lastFoot}
                    kind="lastfoot"
                    columns={Math.max(1, rows[0]?.length ?? 1)}
                    alignments={columnAlignments}
                    number={tableNumber ?? null}
                  />
                ) : null}
              </tbody>
            </table>
          </div>
          {longtable ? (
            <div className="scient-latex-longtable-measurements" aria-hidden="true">
              {(["head", "foot"] as const).map((kind) => (
                <table key={kind} data-latex-longtable-measure={kind}>
                  <tbody>
                    <LatexLongTableBand
                      band={longtable[kind]}
                      kind="measurement"
                      columns={Math.max(1, rows[0]?.length ?? 1)}
                      alignments={columnAlignments}
                      number={tableNumber ?? null}
                    />
                  </tbody>
                </table>
              ))}
            </div>
          ) : null}
          {tablePresentation.captionAfter && tableCaption}
        </figure>
      )}
    </NodeViewWrapper>
  );
}

function stopMathControlEvent({ event }: { event: Event }): boolean {
  // A math-field is a custom element, so Tiptap's default INPUT/TEXTAREA check
  // misses it. Let it own symbol selection, clipboard and keyboard interaction.
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        (target.tagName === "MATH-FIELD" ||
          target.classList.contains("scient-latex-math-source-popover")),
    );
}

const LatexInlineMath = Node.create({
  name: "latexInlineMath",
  group: "inline",
  inline: true,
  marks: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return { tex: { default: "" }, wrapper: { default: "paren" } };
  },
  parseHTML() {
    return [{ tag: "span[data-latex-inline-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-latex-inline-math": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexMathView, { stopEvent: stopMathControlEvent });
  },
});

const LatexDisplayMath = Node.create({
  name: "latexDisplayMath",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      tex: { default: "" },
      environment: { default: null },
      wrapper: { default: "bracket" },
      sourceId: { default: null, rendered: false },
      numbering: { default: null, rendered: false },
      numberingSource: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-display-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-display-math": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexMathView, { stopEvent: stopMathControlEvent });
  },
});

const LatexInlineCommand = Node.create({
  name: "latexInlineCommand",
  group: "inline",
  inline: true,
  marks: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: { default: "command" },
      argument: { default: "" },
      linkText: { default: null },
      raw: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-latex-command]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-latex-command": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexInlineCommandView);
  },
});

const LatexRawBlock = Node.create({
  name: "latexRawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: "" },
      label: { default: "Raw LaTeX" },
      sourceId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-raw]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-raw": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexRawBlockView);
  },
});

const LatexRichPreview = Node.create<LatexVisualWorkspace>({
  name: "latexRichPreview",
  group: "block",
  atom: true,
  selectable: true,
  addOptions() {
    return {
      environmentId: null,
      cwd: null,
      relativePath: null,
      draftKey: null,
    };
  },
  addAttributes() {
    return {
      kind: { default: "description" },
      raw: { default: "" },
      items: { default: null },
      rows: { default: null },
      cellRanges: { default: null, rendered: false },
      sourceMeta: { default: null, rendered: false },
      itemIds: { default: null, rendered: false },
      rowIds: { default: null, rendered: false },
      columnIds: { default: null, rendered: false },
      columnAlignments: { default: null },
      tableStyle: { default: "plain" },
      tableKind: { default: "fixed" },
      hasHeader: { default: false },
      tableCanonical: { default: false, rendered: false },
      editable: { default: false, rendered: false },
      caption: { default: null },
      captionRemoved: { default: false, rendered: false },
      label: { default: null },
      environment: { default: null },
      title: { default: null },
      titleRemoved: { default: false, rendered: false },
      unnumbered: { default: false },
      widestLabel: { default: null },
      author: { default: null },
      date: { default: null },
      authorEnabled: { default: false },
      dateEnabled: { default: true },
      dateMode: { default: "default" },
      tocEntries: { default: null, rendered: false },
      descriptionStyle: { default: "standard" },
      descriptionLeftMargin: { default: null },
      body: { default: null },
      path: { default: null },
      figureWidth: { default: null },
      figureOptions: { default: null, rendered: false },
      figurePlacement: { default: null },
      figureAlignment: { default: null },
      figureCaptionPosition: { default: null },
      figureStarred: { default: false },
      sourceId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-rich-preview]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-rich-preview": "" }];
  },
  addNodeView() {
    const workspace = this.options;
    return ReactNodeViewRenderer(
      (props) => <LatexRichPreviewInWorkspace {...props} created={workspace} />,
      {
        // Typing in a field here (title, abstract, captions) belongs to that
        // field. Without this the document editor also takes the key and acts
        // on its own last selection: Backspace in the title could delete a
        // formula, join paragraphs, or remove the title block itself.
        stopEvent: ({ event }) =>
          event.target instanceof Element &&
          (Boolean(event.target.closest(".scient-latex-inline-field")) ||
            event.target.matches("input, textarea, select")),
        trackNodeViewPosition: true,
        update({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) {
          if (oldNode !== newNode || oldDecorations !== newDecorations) updateProps();
          return true;
        },
      },
    );
  },
});

function fieldSourceId(
  editor: Editor,
  node: ProseMirrorNode,
  position: number | undefined,
): string {
  const ancestors: string[] = [];
  if (typeof position === "number") {
    const resolved = editor.state.doc.resolve(position);
    for (let depth = 1; depth <= resolved.depth; depth++) {
      const parent = resolved.node(depth);
      if (parent.attrs.sourceId != null) ancestors.push(String(parent.attrs.sourceId));
    }
  }
  return [...ancestors, String(node.attrs.sourceId)].join(":");
}

function LatexScientificView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
  deleteNode,
}: NodeViewProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const languageLabels = latexLanguageLabels(useContext(LatexLanguageContext));
  const documentEditing = useContext(LatexMathEditingContext);
  const editable = useEditorEditable(editor);
  const environment = String(node.attrs.environment);
  const presentation = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const position = getPos();
      const references = current && latexEquationReferencesKey.getState(current.state);
      return {
        statement:
          typeof position === "number" ? (references?.statements?.get(position) ?? null) : null,
        environments: references?.environments ?? [],
      };
    },
  });
  const statement = presentation?.statement;
  if (environment === "abstract")
    return (
      <NodeViewWrapper className="scient-latex-abstract-preview">
        <h2 contentEditable={false}>{languageLabels.abstract}</h2>
        <NodeViewContent className="scient-latex-abstract-body" aria-label="Abstract" />
      </NodeViewWrapper>
    );
  if (node.attrs.layout?.kind === "algorithm")
    return (
      <LatexAlgorithmView
        node={node}
        editor={editor}
        selected={selected}
        getPos={getPos}
        updateAttributes={updateAttributes}
        deleteNode={deleteNode}
        editable={editable}
        draftKey={
          documentEditing
            ? `${documentEditing.draftKey}:algorithm:${fieldSourceId(editor, node, getPos())}`
            : undefined
        }
      />
    );
  if (node.attrs.layout?.kind === "colorBox")
    return (
      <LatexColorBoxView
        node={node}
        editor={editor}
        selected={selected}
        getPos={getPos}
        updateAttributes={updateAttributes}
        editable={editable}
        draftKey={
          documentEditing
            ? `${documentEditing.draftKey}:box:${fieldSourceId(editor, node, getPos())}`
            : undefined
        }
      />
    );
  if (node.attrs.layout?.kind === "boxRegion")
    return (
      <NodeViewWrapper
        className="scient-latex-box-region"
        data-lower={environment === "tcblower" || undefined}
        style={{ background: latexColorCss(node.attrs.layout.background) ?? undefined }}
      >
        <NodeViewContent
          aria-label={environment === "tcblower" ? "Lower box content" : "Upper box content"}
        />
      </NodeViewWrapper>
    );
  if (node.attrs.layout?.kind === "basicBox") {
    const layout = node.attrs.layout;
    return (
      <NodeViewWrapper
        className="scient-latex-basic-box"
        style={{
          background: layout.background
            ? (latexColorCss(layout.background) ?? undefined)
            : undefined,
          borderColor: latexColorCss(layout.color) ?? undefined,
          borderWidth: layout.borderWidth,
          padding: layout.padding,
          width: layout.width ?? "fit-content",
        }}
      >
        <NodeViewContent aria-label="Framed text" />
      </NodeViewWrapper>
    );
  }
  if (node.attrs.layout?.kind === "direction") {
    const language = String(node.attrs.layout.language ?? "");
    return (
      <NodeViewWrapper
        className="scient-latex-direction-block"
        dir={node.attrs.layout.direction}
        lang={language === "hebrew" ? "he" : language === "english" ? "en" : undefined}
      >
        <NodeViewContent
          className="scient-latex-direction-body"
          aria-label={language ? `${language} text` : `${node.attrs.layout.direction} text`}
        />
      </NodeViewWrapper>
    );
  }
  if (node.attrs.layout) {
    const layout = node.attrs.layout as {
      kind: string;
      columns?: number;
      width?: string;
      alignment?: string;
      height?: string;
      innerAlignment?: string;
    };
    return (
      <NodeViewWrapper
        className="scient-latex-page-layout"
        ref={root}
        data-layout={layout.kind}
        data-alignment={layout.alignment}
        data-inner-alignment={layout.innerAlignment}
        style={
          {
            "--scient-latex-columns": layout.columns ?? 1,
            "--scient-latex-panel-height": layout.height,
          } as CSSProperties
        }
      >
        <NodeViewContent
          className="scient-latex-page-layout-body"
          aria-label={
            layout.kind === "columns"
              ? "Column text"
              : layout.kind === "row"
                ? "Minipage row"
                : "Minipage text"
          }
        />
        <LatexObjectToolbar
          editor={editor}
          root={root}
          selected={selected}
          label={layout.kind === "columns" ? "Columns tools" : "Panel tools"}
          position={layout.kind === "columns" ? "Columns" : "Panel"}
          inline
        >
          <LatexLayoutControls node={node} editor={editor} getPos={getPos} />
        </LatexObjectToolbar>
      </NodeViewWrapper>
    );
  }
  const quoted = statement?.kind === "quote";
  const displayTitle = statement?.title ?? environment[0]!.toUpperCase() + environment.slice(1);
  const referenceLabels: { position: number; argument: string }[] = [];
  const position = getPos();
  if (typeof position === "number")
    node.descendants((child, offset) => {
      if (["latexScientific", "latexDisplayMath"].includes(child.type.name)) return false;
      if (child.type.name === "latexInlineCommand" && child.attrs.name === "label")
        referenceLabels.push({
          position: position + 1 + offset,
          argument: String(child.attrs.argument),
        });
    });
  const title = String(node.attrs.title ?? "");
  const enterStatementBody = () => {
    const position = getPos();
    if (typeof position === "number") enterLatexObjectBody(editor.view, position);
  };
  const titleField = (
    <LatexStatementTitle
      editor={editor}
      value={title}
      source={node.attrs.titleSource ?? escapeText(title)}
      editing={titleEditing}
      editable={editable}
      draftKey={
        documentEditing
          ? `${documentEditing.draftKey}:scientific:${fieldSourceId(editor, node, getPos())}:title`
          : undefined
      }
      onEditing={setTitleEditing}
      onChange={(title) =>
        updateAttributes({ title, titleSource: null, titleRemoved: title === "" })
      }
      onExit={enterStatementBody}
    />
  );
  const setLabel = (id: string, value: string) => {
    if (!editable || editor.isDestroyed) return;
    const position = getPos();
    if (typeof position !== "number") return;
    const current = editor.state.doc.nodeAt(position);
    if (current?.type.name !== "latexScientific") return;
    const tr = editor.state.tr;
    const existing = referenceLabels.find(
      (label) => String(label.position - (position + 1)) === id,
    );
    if (existing) {
      const labelNode = editor.state.doc.nodeAt(existing.position);
      if (labelNode?.type.name !== "latexInlineCommand" || labelNode.attrs.name !== "label") return;
      if (!value) tr.delete(existing.position, existing.position + labelNode.nodeSize);
      else
        tr.setNodeMarkup(existing.position, undefined, {
          ...labelNode.attrs,
          argument: value,
          raw: `\\label{${value}}`,
        });
    } else if (value && id === "new") {
      const labelNode = editor.schema.nodes.latexInlineCommand!.create({
        name: "label",
        argument: value,
        raw: `\\label{${value}}`,
      });
      if (current.firstChild?.type.name === "paragraph") tr.insert(position + 2, labelNode);
      else tr.insert(position + 1, editor.schema.nodes.paragraph!.create(null, labelNode));
    } else return;
    editor.view.dispatch(tr);
  };
  const enterBody = (event: MouseEvent<HTMLElement>) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const position = getPos();
    if (typeof position === "number") enterLatexObjectBody(editor.view, position);
  };
  return (
    <NodeViewWrapper
      ref={root}
      className="scient-latex-scientific-structure"
      data-environment={environment}
      data-theorem-style={statement?.style}
      data-quote-wrapper={quoted || undefined}
      data-bold-prefix={statement?.boldPrefix || undefined}
      data-proof={statement?.proof || undefined}
      data-proof-end={statement?.proofEnd ? "square" : undefined}
      data-run-in={node.firstChild?.type.name === "paragraph" || undefined}
    >
      {(!quoted || displayTitle) && (
        <div
          className="scient-latex-scientific-heading"
          contentEditable={false}
          onClick={enterBody}
        >
          <span>
            {statement?.proof && (title || titleEditing) ? titleField : displayTitle}
            {statement?.number ? " " + statement.number : ""}
            {!statement?.proof && (title || titleEditing) && (
              <span className="scient-latex-scientific-note">
                {" ("}
                {titleField}
                {")"}
              </span>
            )}
            {quoted ? "" : "."}
          </span>
        </div>
      )}
      <NodeViewContent
        className="scient-latex-scientific-body"
        aria-label="Scientific statement body"
      />
      {!quoted ? (
        <LatexStatementToolbar
          editor={editor}
          root={root}
          selected={selected}
          editable={editable}
          environment={environment}
          proof={statement?.proof === true}
          hasTitle={Boolean(title)}
          labels={(referenceLabels.length ? referenceLabels : [{ position: -1, argument: "" }]).map(
            (label) => {
              const id =
                label.position < 0 ? "new" : String(label.position - ((position ?? 0) + 1));
              return {
                id,
                value: label.argument,
                draftKey: documentEditing
                  ? `${documentEditing.draftKey}:scientific:${fieldSourceId(editor, node, getPos())}:label:${id}`
                  : undefined,
              };
            },
          )}
          onType={(environment) => updateAttributes({ environment })}
          onTitle={() => {
            setTitleEditing(true);
            requestAnimationFrame(() => {
              const field = root.current?.querySelector<HTMLTextAreaElement>(
                ".scient-latex-statement-title textarea",
              );
              field?.focus({ preventScroll: true });
              field?.setSelectionRange(0, 0);
            });
          }}
          onLabel={setLabel}
        />
      ) : (
        referenceLabels.length > 0 && (
          <LatexObjectToolbar
            editor={editor}
            root={root}
            selected={selected}
            label={`${displayTitle} tools`}
            position={displayTitle}
            inline
          >
            {referenceLabels.map((label) => (
              <LatexFooterLabel
                key={label.position}
                label="Statement reference label"
                value={label.argument}
                disabled={!editable}
                onCommit={(value) =>
                  setLabel(String(label.position - ((position ?? 0) + 1)), value)
                }
              />
            ))}
          </LatexObjectToolbar>
        )
      )}
    </NodeViewWrapper>
  );
}

const LatexScientific = Node.create({
  name: "latexScientific",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      environment: { default: "theorem" },
      title: { default: "" },
      titleSource: { default: null, rendered: false },
      titleRemoved: { default: false, rendered: false },
      raw: { default: "", rendered: false },
      sourceId: { default: null, rendered: false },
      layout: { default: null, rendered: false },
      layoutGap: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-scientific]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-scientific": "" }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexScientificView, {
      attrs: ({ node }) => {
        const layout = node.attrs.layout;
        return {
          "data-latex-page-layout": layout?.kind ?? "",
          "data-alignment": layout?.alignment ?? "",
          style:
            layout?.kind === "minipage"
              ? `width: ${layout.width}; min-width: 0; flex-shrink: 0; margin-inline-start: ${node.attrs.layoutGap ?? "0px"};`
              : "",
        };
      },
    });
  },
});

function toggleLatexProseMark(editor: Editor | null, mark: "bold" | "italic" | "code"): boolean {
  if (!editor) return false;
  let chain = editor.chain().focus();
  // A mark replaces the others of its kind: weight, shape, or family.
  const conflicts =
    mark === "bold"
      ? ["latexMedium"]
      : mark === "code"
        ? ["latexRoman", "latexSans"]
        : ["latexSmallCaps", "latexSlanted", "latexUpright"];
  for (const conflict of conflicts) chain = chain.unsetMark(conflict);
  return chain.toggleMark(mark).run();
}

const LatexTextMarks = LATEX_CANVAS_TEXT_MARKS.map(({ name, style }) =>
  Mark.create({
    name,
    parseHTML() {
      return [{ tag: `span[data-latex-text-style="${style}"]` }];
    },
    renderHTML() {
      return ["span", { "data-latex-text-style": style }, 0];
    },
  }),
).concat(
  LATEX_DIRECTION_MARKS.map(({ name, direction, language }) =>
    Mark.create({
      name,
      group: "latexTextDirection",
      excludes: "latexTextDirection",
      inclusive: false,
      parseHTML() {
        return [{ tag: `span[data-latex-direction-mark="${name}"]` }];
      },
      renderHTML() {
        return [
          "span",
          {
            "data-latex-direction-mark": name,
            dir: direction,
            ...(language ? { lang: language === "hebrew" ? "he" : "en" } : {}),
          },
          0,
        ];
      },
    }),
  ),
);

const LatexColor = Mark.create({
  name: "latexColor",
  priority: 1100,
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      command: { default: "textcolor" },
      color: { default: "black" },
      background: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-latex-color]" }];
  },
  renderHTML({ mark }) {
    const command = String(mark.attrs.command);
    const foreground = command === "textcolor" ? latexColorCss(mark.attrs.color) : null;
    const background =
      command === "colorbox"
        ? latexColorCss(mark.attrs.color)
        : command === "fcolorbox"
          ? latexColorCss(mark.attrs.background)
          : null;
    const frame =
      command === "fcolorbox" || command === "fbox" ? latexColorCss(mark.attrs.color) : null;
    return [
      "span",
      {
        ...mark.attrs,
        "data-latex-color": command,
        style: [
          foreground && `color:${foreground}`,
          background && `background:${background};padding:3pt;white-space:nowrap`,
          frame && `border:0.4pt solid ${frame};padding:3pt;white-space:nowrap`,
        ]
          .filter(Boolean)
          .join(";"),
      },
      0,
    ];
  },
});

// TeX's typewriter family can contain bold, accents and other text styling.
const LatexMonospace = Code.extend({ excludes: "" });

const inlineFieldExtensions = [
  ...LatexTextMarks,
  LatexColor,
  LatexColor.extend({
    name: "latexBackground",
    parseHTML() {
      return [
        {
          tag: 'span[data-latex-color="colorbox"],span[data-latex-color="fcolorbox"],span[data-latex-color="fbox"]',
        },
      ];
    },
  }),
  LatexMonospace,
  LatexInlineMath,
  LatexInlineCommand,
];

const baseExtensions = [
  Extension.create({
    name: "latexDocumentObjectSelection",
    addProseMirrorPlugins() {
      return [latexDocumentObjectSelection()];
    },
  }),
  LatexWritingKeys,
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    codeBlock: false,
    horizontalRule: false,
    link: false,
    strike: false,
    code: false,
    trailingNode: false,
  }),
  ...LatexTextMarks,
  LatexColor,
  LatexColor.extend({
    name: "latexBackground",
    parseHTML() {
      return [
        {
          tag: 'span[data-latex-color="colorbox"],span[data-latex-color="fcolorbox"],span[data-latex-color="fbox"]',
        },
      ];
    },
  }),
  LatexAlgorithmLine,
  LatexAlgorithmComment,
  LatexMonospace,
  LatexSourceAttributes,
  LatexInlineMath,
  LatexDisplayMath,
  LatexInlineCommand,
  LatexRawBlock,
  LatexScientific,
];

export interface LatexVisualEditorProps {
  /** Confirms accepted reference edits through their owning file sessions. */
  readonly flushReferenceEdits?: (() => Promise<boolean>) | undefined;
  /** The assembled published source when the editor spans more than one file. */
  readonly confirmedReferenceSource?: (() => string | null) | undefined;
  readonly documentPersistence?: readonly MarkdownPersistenceLease[] | undefined;
  readonly onLocalDraftChange?: (pending: boolean) => void;
  readonly draftKey: string;
  /**
   * Which editor this is. Defaults to `draftKey`; set it to keep the editor,
   * its history and selection when the storage key changes with an in-place
   * rename.
   */
  readonly editorInstanceKey?: string;
  readonly fileRevision: string;
  readonly source: string;
  readonly rootSource?: string | null;
  readonly compiledBibliography?: string | null;
  readonly rootRelativePath?: string | null;
  readonly disabled: boolean;
  readonly onEdit: (
    expected: string,
    next: string,
    rootUpdate?: LatexRootUpdate,
    originOffset?: number,
  ) => boolean;
  readonly canEditRoot?: boolean;
  /** False when the document is assembled from several files; recovery is then offered to read and copy only. */
  readonly singleFileDocument?: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onOpenSource: () => void;
  readonly onOpenSourceAt?: (offset: number) => void;
  readonly onOpenFileSource?: (path: string, line?: number) => void;
  readonly referenceFiles?: ReferenceFileCallbacks | undefined;
  readonly sourceError?: string | null;
  readonly onOpenRoot?: (mode?: "source" | "visual") => void;
  readonly environmentId?: EnvironmentId | undefined;
  readonly cwd?: string | undefined;
  readonly relativePath?: string | undefined;
  readonly registerFinishEditing?: (finish: (() => boolean) | null) => void;
}

const visualJsonNodes = new WeakMap<ProseMirrorNode, JSONContent>();
function visualDocumentJson(doc: ProseMirrorNode): JSONContent {
  const content: JSONContent[] = [];
  doc.forEach((node) => {
    let json = visualJsonNodes.get(node);
    if (!json) {
      json = node.toJSON() as JSONContent;
      visualJsonNodes.set(node, json);
    }
    content.push(json);
  });
  return { type: "doc", content };
}

export function LatexVisualEditor(props: LatexVisualEditorProps) {
  const identity = props.editorInstanceKey ?? props.draftKey;
  const requestIdentity = useRef(props);
  useLayoutEffect(() => {
    requestIdentity.current = props;
  }, [props]);
  const [prepared, setPrepared] = useState(() =>
    props.source.length < 12_000 || typeof Worker === "undefined"
      ? {
          key: identity,
          projection: projectLatexVisualDocument(props.source, 0, props.rootSource ?? props.source),
        }
      : null,
  );
  const [failure, setFailure] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (prepared?.key === identity) return;
    setFailure(false);
    if (typeof Worker === "undefined") {
      try {
        setPrepared({
          key: identity,
          projection: projectLatexVisualDocument(props.source, 0, props.rootSource ?? props.source),
        });
      } catch {
        setFailure(true);
      }
      return;
    }
    return processVisualDocument(
      { kind: "project", source: props.source, setupSource: props.rootSource ?? props.source },
      (result) => {
        const current = requestIdentity.current;
        if (
          (current.editorInstanceKey ?? current.draftKey) !== identity ||
          current.source !== props.source ||
          current.rootSource !== props.rootSource
        )
          return;
        if (result?.kind === "project")
          setPrepared({ key: identity, projection: result.projection });
        else setFailure(true);
      },
    );
  }, [prepared, identity, props.source, props.rootSource, retry]);
  if (prepared?.key !== identity)
    return (
      <div className="scient-latex-placeholder" role="status" aria-busy={!failure}>
        {failure
          ? "Visual could not prepare this document. Your source is unchanged and remains available in Source."
          : "Preparing Visual…"}
        {failure && (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry Visual
          </button>
        )}
      </div>
    );
  return (
    <LatexVisualEditorReady key={identity} {...props} initialProjection={prepared.projection} />
  );
}

function LatexVisualEditorReady(
  props: LatexVisualEditorProps & { initialProjection: LatexVisualDocument },
) {
  const mathSetupSource = useMemo(() => {
    const source = props.rootSource ?? props.source;
    return source.slice(0, latexPreambleEnd(source));
  }, [props.rootSource, props.source]);
  const documentMathSetup = useMemo(
    () => latexDocumentMathSetup(mathSetupSource),
    [mathSetupSource],
  );
  const documentLanguage = useMemo(() => latexDocumentLanguage(mathSetupSource), [mathSetupSource]);
  const completionSource = useRef(props.rootSource ?? props.source);
  useLayoutEffect(() => {
    completionSource.current = props.rootSource ?? props.source;
  }, [props.rootSource, props.source]);
  const commandContext = useMemo(
    () => ({
      source: mathSetupSource,
      referenceSource: () => completionSource.current,
      macros: documentMathSetup.macros,
      colors: latexDocumentColors(mathSetupSource),
    }),
    [documentMathSetup.macros, mathSetupSource],
  );
  const completionContext = useRef(commandContext);
  useLayoutEffect(() => {
    completionContext.current = commandContext;
  }, [commandContext]);
  const projectionSetupKey = useMemo(() => {
    const declarations = latexEnvironmentDeclarations(mathSetupSource);
    // Title metadata changes do not invalidate the parser or its undo history.
    return JSON.stringify({
      macros: documentMathSetup.macros,
      unsupportedMath: documentMathSetup.unsupported,
      environments: [...declarations.environments],
      unsupportedEnvironments: [...declarations.unsupported],
      defaultProofEnd: declarations.defaultProofEnd,
      listingDefaults: [...(latexListingDefaults(mathSetupSource) ?? [])],
    });
  }, [documentMathSetup, mathSetupSource]);
  const [mathActive, setMathActive] = useState(false);
  const [mathPicker, setMathPicker] = useState<"matrix" | "symbols" | null>(null);
  const [matrixEnvironment, setMatrixEnvironment] = useState<MatrixEnvironment>("bmatrix");
  const mathPickerTarget = useRef<{
    editor: Editor;
    doc: ProseMirrorNode;
    selection: Selection;
    field: ActiveMathEditor | null;
  } | null>(null);
  const pendingMathInsert = useRef<{
    tex: string;
    display: boolean;
    action?: MathSymbol["action"];
  } | null>(null);
  const mathTarget = useRef<ActiveMathEditor | null>(null);
  const [mathFormattingState, setMathFormattingState] = useState("");
  const activeMath = useMemo(
    () => ({
      draftKey: props.draftKey,
      get: () => mathTarget.current,
      activate: (controls: ActiveMathEditor) => {
        mathTarget.current = controls;
        setMathActive(true);
      },
      update: (controls: ActiveMathEditor) => {
        if (mathTarget.current?.id !== controls.id) return;
        const availabilityChanged =
          mathTarget.current.formattingAvailable !== controls.formattingAvailable;
        mathTarget.current = controls;
        if (availabilityChanged)
          setMathFormattingState(
            `${controls.id}:${controls.formattingAvailable ? "visual" : "source"}`,
          );
      },
      formatChanged: (id: string, state: string) => {
        if (mathTarget.current?.id === id) setMathFormattingState(`${id}:${state}`);
      },
      deactivate: (id: string) => {
        if (mathTarget.current?.id !== id) return;
        mathTarget.current = null;
        setMathActive(false);
      },
    }),
    [props.draftKey],
  );
  const pendingFields = useRef(new Set<string>());
  const localDraftReporter = useRef(props.onLocalDraftChange);
  const [localDraftState, setLocalDraftState] = useState({ pending: false, version: 0 });
  const hasLocalDraft = localDraftState.pending;
  const cancelDraftReport = useRef<(() => void) | null>(null);
  const reportDraft = useCallback((id: string, pending: boolean) => {
    if (pendingFields.current.has(id) === pending) return;
    if (pending) pendingFields.current.add(id);
    else pendingFields.current.delete(id);
    localDraftReporter.current?.(pendingFields.current.size > 0);
    if (!cancelDraftReport.current)
      cancelDraftReport.current = afterEditorPaint(() => {
        cancelDraftReport.current = null;
        setLocalDraftState((previous) => ({
          pending: pendingFields.current.size > 0,
          version: previous.version + 1,
        }));
      });
  }, []);
  useEffect(() => () => cancelDraftReport.current?.(), []);
  const onLocalDraftChange = props.onLocalDraftChange;
  useLayoutEffect(() => {
    localDraftReporter.current = onLocalDraftChange;
    onLocalDraftChange?.(pendingFields.current.size > 0);
    return () => onLocalDraftChange?.(false);
  }, [onLocalDraftChange]);

  // A typing snapshot is reinstalled only over the source it was typed on.
  // Other unsaved work is parked apart from the live draft slots and waits for
  // the user's choice, so writing continues meanwhile.
  const [startup] = useState(() => readStartupRecovery(props.draftKey, { source: props.source }));
  // A snapshot to put back, with the stored version it was read from, so this
  // editor later removes exactly that version and no other.
  const typingToReinstall = (next: typeof startup) =>
    next.typing && next.typingIdentity !== null
      ? { draft: next.typing, identity: next.typingIdentity }
      : null;
  const [typingRecovery, setTypingRecovery] = useState(() => typingToReinstall(startup));
  const [recovery, setRecovery] = useState(startup.recovery);
  // Set once work has been resolved from a live draft slot: whatever else waits
  // in those slots is then read again, as on opening.
  const [rereadStartup, setRereadStartup] = useState(false);
  // Work that could not be parked is still in a live draft slot, which writing
  // would replace, so the editor waits for the user's choice.
  const [unsynced, setUnsynced] = useState(false);
  const readOnly =
    props.disabled || unsynced || rereadStartup || (recovery !== null && !recovery.parked);
  const editBlocked = useRef(readOnly);
  editBlocked.current = readOnly;
  const refusedChanges = useRef(0);
  const ordinaryDocuments = useRef(new WeakSet<ProseMirrorNode>());
  const textReadOnly = readOnly || mathActive;
  const mathFormattingUnavailable =
    mathActive &&
    (!mathTarget.current?.formattingAvailable || mathFormattingState.endsWith(":latex"));
  const [initial] = useState(props.initialProjection);
  const projection = useRef<LatexVisualDocument>(initial);
  const currentSource = useRef(initial.source);
  const referenceSource = useRef(props.rootSource ?? props.source);
  referenceSource.current = props.rootSource ?? props.source;
  const compiledBibliographySource = useRef(props.compiledBibliography ?? null);
  compiledBibliographySource.current = props.compiledBibliography ?? null;
  // The file revision that `currentSource` descends from. It moves only when
  // the editor adopts a source, so a draft kept over an older source is never
  // stamped with a newer file's revision.
  const sourceRevision = useRef(props.fileRevision);
  // Plugins live as long as the editor; they read the storage key here.
  const draftKeyRef = useRef(props.draftKey);
  useLayoutEffect(() => {
    draftKeyRef.current = props.draftKey;
  }, [props.draftKey]);

  const observedSource = useRef({ source: props.source, revision: props.fileRevision });
  const deferredSource = useRef(false);

  // The typing snapshot this editor last stored or put back. Another view of
  // the document may have stored a different one since; only ours is removed.
  const ownTyping = useRef<string | null>(null);
  const draftKey = props.draftKey;
  const retainOwnTyping = useCallback(
    (baseSource: string, doc: ProseMirrorNode) => {
      ownTyping.current =
        retainTypingDraft(draftKey, baseSource, doc, ownTyping.current) ?? ownTyping.current;
    },
    [draftKey],
  );
  const discardOwnTyping = useCallback(() => {
    if (ownTyping.current === null || discardTypingDraft(draftKey, ownTyping.current))
      ownTyping.current = null;
  }, [draftKey]);
  const onEdit = useRef(props.onEdit);
  const applying = useRef(false);
  // The ProseMirror plugins live for the editor's lifetime. Keep their source
  // adapter current across renderer hot updates without resetting user edits.
  const applyDocumentChange = useRef(applyLatexVisualDocumentChange);
  const explicitSourceChange = useRef(projectLatexTitleSourceEdit);
  explicitSourceChange.current = (source, content) =>
    projectLatexTitleSourceEdit(source, content, props.rootSource ?? undefined);
  applyDocumentChange.current = (source, document, content) =>
    applyLatexVisualDocumentChange(source, document, content, {
      rootSource: props.rootSource ?? null,
      allowRootUpdates: props.canEditRoot === true,
      onMissingRequirement: (message) => setNotice(message),
    });
  const accepted = useRef<{
    doc: ProseMirrorNode;
    expected: string;
    change: NonNullable<ReturnType<typeof applyLatexVisualDocumentChange>>;
    published?: boolean;
  } | null>(null);
  const pendingTyping = useRef<ProseMirrorNode | null>(null);
  const cancelTyping = useRef<(() => void) | null>(null);
  const cancelConversion = useRef<(() => void) | null>(null);
  const processingContext = useRef({
    rootSource: props.rootSource ?? null,
    allowRootUpdates: props.canEditRoot === true,
  });
  useLayoutEffect(() => {
    processingContext.current = {
      rootSource: props.rootSource ?? null,
      allowRootUpdates: props.canEditRoot === true,
    };
  }, [props.rootSource, props.canEditRoot]);
  const [typingTask] = useState(createEditorBackgroundTask);
  const flushTypingRef = useRef<() => boolean>(() => true);
  const pendingSourceEdit = useRef<{
    expected: string;
    previousProjection: LatexVisualDocument;
    change: NonNullable<ReturnType<typeof applyLatexVisualDocumentChange>>;
  } | null>(null);
  const cancelSourcePublish = useRef<(() => void) | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const imageUploadSequence = useRef(0);
  const imageContext = useRef({
    environmentId: props.environmentId,
    cwd: props.cwd,
    documentPath: props.rootRelativePath ?? props.relativePath,
  });
  useLayoutEffect(() => {
    imageContext.current = {
      environmentId: props.environmentId,
      cwd: props.cwd,
      documentPath: props.rootRelativePath ?? props.relativePath,
    };
  }, [props.environmentId, props.cwd, props.rootRelativePath, props.relativePath]);
  const [editorRevision, refreshToolbar] = useState(0);
  const [newHeadingNumbered, setNewHeadingNumbered] = useState(true);
  const cancelToolbarRefresh = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelToolbarRefresh.current?.(), []);
  const [notice, setNotice] = useState<string | null>(null);
  const rawInputRecovery = useRef<LatexVisualRecovery | null>(null);
  const rawInputPersistedRecovery = useRef<LatexVisualRecovery | null>(null);
  const rawInputInteraction = useRef("");
  const [blockSource, setBlockSource] = useState<{
    id: string;
    position: number;
    baseSource: string;
    original: string;
    draft: string;
  } | null>(null);
  useEffect(() => {
    const failed = (event: Event) => {
      const key: unknown = (event as CustomEvent).detail;
      if (
        typeof key === "string" &&
        (key === props.draftKey || key.startsWith(`${props.draftKey}:`))
      )
        setNotice(
          "Your writing remains in the editor, but its recovery copy could not be updated. Another window may have newer recovery data, or storage may be unavailable. Keep this document open until its workspace save succeeds.",
        );
    };
    window.addEventListener("scient-latex-recovery-error", failed);
    return () => window.removeEventListener("scient-latex-recovery-error", failed);
  }, [props.draftKey]);
  const [insertOpen, setInsertOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<LatexDocumentSettingsSection | null>(null);
  const [titleHelp, setTitleHelp] = useState<string | null>(null);
  const titleHelpAction = useRef<(() => void) | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (id: string) =>
    commandKeys(id)
      .map((keys) => labelKeys(keys))
      .join(" / ");
  const shortcutAction = useRef<(id: string) => boolean>(() => false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [referencesRequest, setReferencesRequest] = useState<{ key?: string; sequence: number }>({
    sequence: 0,
  });
  const [referenceCatalog, setReferenceCatalog] = useState<BibliographyDetails[]>([]);
  const referenceDraftChanged = useCallback(
    (pending: boolean) => reportDraft("references", pending),
    [reportDraft],
  );
  const [bibliographyDialog, setBibliographyDialog] = useState<{ open: boolean } | null>(null);
  const [referenceMode, setReferenceMode] = useState<"reference" | "citation">("reference");
  const [linkDialog, setLinkDialog] = useState<{
    open: boolean;
    text: string;
    source: string;
  } | null>(null);
  const linkAnchor = useRef<HTMLDivElement>(null);
  const settingsSourceAfterClose = useRef(false);
  const pendingLink = useRef<{ text: string; url: string } | null>(null);
  const insertionTarget = useRef<{ doc: ProseMirrorNode; selection: Selection } | null>(null);
  const [figureOpen, setFigureOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationTab, setNavigationTab] = useState<"pages" | "outline">("pages");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const readerAction = useRef<(command: string) => boolean>(() => false);
  useEffect(() => {
    const workspace = workspaceRef.current;
    return workspace
      ? attachShortcutHost(workspace, "pdf", {
          execute: (command) => readerAction.current(command),
          accepts: (event, command) =>
            command === "pdf.find" ||
            !(
              event.target instanceof Element &&
              event.target.closest("input,textarea,select,math-field,[contenteditable='true']")
            ),
        })
      : undefined;
  }, []);
  useHostedReaderShortcuts(readerAction);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const visualScroll = useRef<HTMLDivElement | null>(null);
  const pageStage = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    onEdit.current = props.onEdit;
  }, [props.onEdit]);

  const installProjection = useCallback((next: LatexVisualDocument, resetEditor: boolean) => {
    projection.current = next;
    const editor = editorRef.current;
    if (!resetEditor || !editor || editor.isDestroyed) return;
    const oldSelection = editor.state.selection;
    const oldDocument = editor.state.doc;
    const document = editor.schema.nodeFromJSON(next.content);
    const from = oldDocument.content.findDiffStart(document.content);
    // Acknowledgements and declaration updates often project the same canvas.
    // Keep its node views, native fields and selection untouched in that case.
    if (from === null) return;
    const difference = oldDocument.content.findDiffEnd(document.content)!;
    const overlap = from - Math.min(difference.a, difference.b);
    const oldEnd = difference.a + Math.max(0, overlap);
    const newEnd = difference.b + Math.max(0, overlap);
    const oldMarks = editor.state.storedMarks;
    const scroll = editor.view.dom.closest(".scient-latex-visual-scroll");
    const scrollTop = scroll?.scrollTop ?? 0;
    const scrollLeft = scroll?.scrollLeft ?? 0;
    applying.current = true;
    try {
      const transaction = editor.state.tr
        .replace(from, oldEnd, document.slice(from, newEnd))
        .setMeta("preventUpdate", true);
      const selection = latexProjectionSelection(oldDocument, transaction.doc, oldSelection);
      editor.view.dispatch(
        transaction.setSelection(selection).setStoredMarks(selection.empty ? oldMarks : null),
      );
      if (scroll) {
        scroll.scrollTop = scrollTop;
        scroll.scrollLeft = scrollLeft;
      }
    } finally {
      applying.current = false;
    }
  }, []);

  const flushSourceEdit = useCallback(
    (_retainLiveText = false) => {
      cancelSourcePublish.current?.();
      cancelSourcePublish.current = null;
      const pending = pendingSourceEdit.current;
      if (!pending) return true;
      pendingSourceEdit.current = null;
      reportDraft("source-publication", false);
      const { expected, change } = pending;
      if (onEdit.current(expected, change.source, change.rootUpdate, change.origin)) {
        checkpointVisualDraft(
          props.draftKey,
          change.source,
          expected,
          change.source,
          sourceRevision.current,
        );
        setUnsynced(false);
        return true;
      }
      currentSource.current = expected;
      // A flush can run inside filterTransaction. Do not dispatch a replacement
      // transaction until ProseMirror has finished applying/rejecting that edit.
      installProjection(pending.previousProjection, false);
      const doc = editorRef.current?.state.doc;
      if (doc) {
        pendingTyping.current = doc;
        retainOwnTyping(expected, doc);
        reportDraft("ordinary-text", true);
      }
      setUnsynced(true);
      setNotice(
        "The source changed elsewhere. This edit could not be saved; check the current source.",
      );
      return false;
    },
    [installProjection, reportDraft, props.draftKey],
  );
  const flushSourceEditRef = useRef(flushSourceEdit);
  useLayoutEffect(() => {
    flushSourceEditRef.current = flushSourceEdit;
  }, [flushSourceEdit]);
  useEffect(() => {
    const flush = () => {
      flushTypingRef.current();
      flushSourceEditRef.current(pendingTyping.current !== null);
      flushVisualDraft(props.draftKey);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      cancelTyping.current?.();
    };
  }, [props.draftKey]);

  const handleUpdate = useCallback(
    (doc: ProseMirrorNode, retainLiveText = false): boolean => {
      if (applying.current) return true;
      const expected = currentSource.current;
      const previousProjection = projection.current;
      const cached = accepted.current;
      if (cached?.doc === doc && cached.published) {
        accepted.current = null;
        return true;
      }
      const changed =
        cached?.doc === doc && cached.expected === expected
          ? cached.change
          : applyDocumentChange.current(expected, projection.current, visualDocumentJson(doc));
      accepted.current = null;
      if (changed === null) {
        if (retainLiveText) setUnsynced(true);
        setNotice(
          retainLiveText
            ? "Your writing is retained in the editor. It could not yet be synchronized to LaTeX."
            : "That structure is source-only. Your LaTeX was not changed.",
        );
        if (!retainLiveText) installProjection(projection.current, true);
        return false;
      }
      if (changed.source === expected && !changed.rootUpdate) {
        installProjection(changed.projection, false);
        return true;
      }
      // Cross-file requirements need an immediate acknowledgement from both
      // file sessions. They are uncommon structural edits, not ordinary typing.
      if (changed.rootUpdate) {
        if (!onEdit.current(expected, changed.source, changed.rootUpdate, changed.origin)) {
          setNotice("The root document changed elsewhere. This edit could not be saved.");
          if (!retainLiveText) installProjection(projection.current, true);
          return false;
        }
        currentSource.current = changed.source;
        installProjection(changed.projection, false);
        setNotice(null);
        return true;
      }
      currentSource.current = changed.source;
      installProjection(changed.projection, false);
      // Recovery becomes a source checkpoint only after the file owner accepts it.
      pendingSourceEdit.current = { expected, previousProjection, change: changed };
      reportDraft("source-publication", true);
      cancelSourcePublish.current?.();
      cancelSourcePublish.current = afterEditorPaint(() => flushSourceEditRef.current());
      setNotice(
        changed.materializedGenerator
          ? "The edited loop is now ordinary LaTeX. Its generated content can be edited independently."
          : null,
      );
      return true;
    },
    [installProjection, reportDraft, props.draftKey],
  );
  const handleUpdateRef = useRef(handleUpdate);
  useLayoutEffect(() => {
    handleUpdateRef.current = handleUpdate;
  }, [handleUpdate]);

  const flushTyping = useCallback(() => {
    cancelConversion.current?.();
    cancelConversion.current = null;
    cancelTyping.current?.();
    cancelTyping.current = null;
    const doc = pendingTyping.current;
    if (!doc) return true;
    // Persistence and conversion are called after paint, or explicitly on exit.
    // Keep the immutable live document even if source conversion is rejected.
    const activeEditor = editorRef.current;
    if (activeEditor && !activeEditor.isDestroyed && activeEditor.view.composing) {
      retainOwnTyping(currentSource.current, doc);
      return false;
    }
    const base = pendingSourceEdit.current?.expected ?? currentSource.current;
    if (
      !flushSourceEditRef.current(true) ||
      !handleUpdateRef.current(doc, true) ||
      !flushSourceEditRef.current(true)
    ) {
      retainOwnTyping(base, doc);
      reportDraft("ordinary-text", true);
      return false;
    }
    pendingTyping.current = null;
    reportDraft("ordinary-text", false);
    // Transfer recovery to the validated source before removing the raw draft.
    if (flushVisualDraft(props.draftKey)) discardOwnTyping();
    else retainOwnTyping(base, doc);
    return true;
  }, [props.draftKey, reportDraft]);
  useLayoutEffect(() => {
    flushTypingRef.current = flushTyping;
  }, [flushTyping]);

  const queueTyping = useCallback(
    (doc: ProseMirrorNode) => {
      cancelConversion.current?.();
      cancelConversion.current = null;
      pendingTyping.current = doc;
      accepted.current = null;
      reportDraft("ordinary-text", true);
      cancelTyping.current = typingTask.cancel;
      typingTask.schedule(() => {
        cancelTyping.current = null;
        const finish = () => {
          if (!flushTypingRef.current()) return;
          const editor = editorRef.current;
          if (!editor || editor.isDestroyed || editor.view.composing || editor.state.doc !== doc)
            return;
          // Structured math is recognized after publication, using the existing
          // guarded structural transaction and document undo path.
          const { $from } = editor.state.selection;
          if (
            $from.parent.type.name !== "paragraph" ||
            !$from.parent.content.content.every((child) => child.isText)
          )
            return;
          const tex = parseStructuredMathEnvironment($from.parent.textContent);
          const math =
            tex === null
              ? null
              : editor.schema.nodes.latexDisplayMath?.create({ tex, wrapper: "bracket" });
          if (math)
            editor.view.dispatch(editor.state.tr.replaceWith($from.before(), $from.after(), math));
        };
        if (typeof Worker === "undefined") {
          finish();
          return;
        }
        const editor = editorRef.current;
        if (
          !editor ||
          editor.isDestroyed ||
          editor.view.composing ||
          !flushSourceEditRef.current(true)
        )
          return;
        const expected = currentSource.current;
        const document = projection.current;
        const context = processingContext.current;
        // Recovery is durable before the asynchronous conversion starts. Only
        // this exact immutable document/source pair may accept its result.
        retainOwnTyping(expected, doc);
        cancelConversion.current = processVisualDocument(
          {
            kind: "change",
            source: expected,
            projection: document,
            content: visualDocumentJson(doc),
            ...context,
          },
          (result) => {
            cancelConversion.current = null;
            if (
              editor.isDestroyed ||
              editor.view.composing ||
              editor.state.doc !== doc ||
              pendingTyping.current !== doc ||
              currentSource.current !== expected ||
              projection.current !== document ||
              processingContext.current !== context ||
              deferredSource.current ||
              editBlocked.current
            )
              return;
            if (result?.kind !== "change" || result.change === null) {
              setNotice(
                result?.kind === "change" && result.notices.length
                  ? result.notices.join(" ")
                  : "Your writing is retained in the editor and its recovery copy. Visual could not synchronize it yet.",
              );
              return;
            }
            accepted.current = { doc, expected, change: result.change };
            finish();
          },
        );
      });
    },
    [reportDraft, typingTask, retainOwnTyping],
  );

  const workspaceContext = useMemo<LatexVisualWorkspace>(
    () => ({
      draftKey: props.draftKey,
      environmentId: props.environmentId ?? null,
      cwd: props.cwd ?? null,
      relativePath: props.relativePath ?? null,
    }),
    [props.cwd, props.environmentId, props.relativePath, props.draftKey],
  );
  const richPreviewExtension = useMemo(
    () =>
      LatexRichPreview.configure({
        draftKey: props.draftKey,
        environmentId: props.environmentId ?? null,
        cwd: props.cwd ?? null,
        relativePath: props.relativePath ?? null,
      }),
    [props.cwd, props.environmentId, props.relativePath, props.draftKey],
  );

  const guardedExtensions = useMemo(
    () => [
      ...baseExtensions,
      LatexProseCompletion.configure({ context: () => completionContext.current }),
      LatexStructuredSelection.configure({
        source: (node) => {
          const block = projection.current.blocks.find((block) => block.id === node.attrs.sourceId);
          return block?.node.type === "paragraph" &&
            latexVisualNodeSignature(block.node) === latexVisualNodeSignature(node.toJSON())
            ? block.source
            : null;
        },
      }),
      LatexVisualSearch,
      LatexVisualPagination.configure({ onPageCount: setPageCount }),
      richPreviewExtension,
      Extension.create({
        name: "latexEquationReferences",
        addProseMirrorPlugins: () => [
          latexEquationReferences(
            () => referenceSource.current,
            () => compiledBibliographySource.current,
          ),
        ],
      }),
      Extension.create({
        name: "latexImageUploads",
        addProseMirrorPlugins: () => [latexImageUploads()],
      }),
      Extension.create({
        name: "latexGuidance",
        addProseMirrorPlugins: () => [latexGuidancePlaceholders(() => projection.current)],
      }),
      Extension.create({
        name: "latexSourceGuard",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              appendTransaction(transactions, _previousState, nextState) {
                if (!transactions.some((transaction) => transaction.docChanged)) return null;
                if (ordinaryDocuments.current.has(nextState.doc)) return null;
                const { $from } = nextState.selection;
                if ($from.parent.type.name !== "paragraph") return null;
                if (!$from.parent.content.content.every((child) => child.isText)) return null;
                const tex = parseStructuredMathEnvironment($from.parent.textContent);
                if (tex === null) return null;
                const from = $from.before();
                const to = $from.after();
                const math = nextState.schema.nodes.latexDisplayMath?.create({
                  tex,
                  wrapper: "bracket",
                });
                return math ? nextState.tr.replaceWith(from, to, math) : null;
              },
            }),
            // ProseMirror skips a plugin's own filter for transactions it
            // appends. Keep recognition separate so its edits are guarded too.
            new Plugin({
              filterTransaction(transaction) {
                if (!transaction.docChanged || applying.current) return true;
                if (editBlocked.current) {
                  refusedChanges.current++;
                  return false;
                }
                if (
                  !deferredSource.current &&
                  isSourceOwnedTyping(
                    transaction,
                    (index) => projection.current.blocks[index]?.editable === true,
                  )
                ) {
                  ordinaryDocuments.current.add(transaction.doc);
                  return true;
                }
                // Settle pending typing before validating a structural command.
                if (!flushTypingRef.current() || !flushSourceEditRef.current()) {
                  refusedChanges.current++;
                  return false;
                }
                const titleStep = transaction.steps.find((step) => step instanceof LatexTitleStep);
                const change: ReturnType<typeof applyLatexVisualDocumentChange> =
                  titleStep instanceof LatexTitleStep
                    ? titleStep.sourceBefore === currentSource.current
                      ? explicitSourceChange.current(
                          titleStep.sourceAfter,
                          visualDocumentJson(transaction.doc),
                        )
                      : null
                    : applyDocumentChange.current(
                        currentSource.current,
                        projection.current,
                        visualDocumentJson(transaction.doc),
                      );
                // A structural edit and its working source advance together. Refusing
                // either conversion or session admission leaves the document,
                // caret, selection and undo history untouched.
                const expected = currentSource.current;
                const supported =
                  change !== null &&
                  ((change.source === expected && !change.rootUpdate) ||
                    onEdit.current(expected, change.source, change.rootUpdate, change.origin));
                if (supported && change) {
                  accepted.current = {
                    doc: transaction.doc,
                    expected,
                    change,
                    published: true,
                  };
                  currentSource.current = change.source;
                  installProjection(change.projection, false);
                  if (change.source !== expected || change.rootUpdate)
                    checkpointVisualDraft(
                      draftKeyRef.current,
                      change.source,
                      expected,
                      change.source,
                      sourceRevision.current,
                    );
                  setUnsynced(false);
                  setNotice(
                    change.materializedGenerator ? "The edited loop is now ordinary LaTeX." : null,
                  );
                } else refusedChanges.current++;
                if (!supported)
                  setNotice(
                    (previous) =>
                      previous ??
                      (change
                        ? "Editing paused. Resolve the file's save status, then try again."
                        : "This edit is unavailable in Visual. Edit this part in Source."),
                  );
                return supported;
              },
            }),
          ];
        },
      }),
    ],
    [richPreviewExtension],
  );

  const handleImageTransfer = (view: EditorView, data: DataTransfer | null, position?: number) => {
    if (!data || !view.editable) return false;
    const files = data.files.length
      ? [...data.files]
      : [...data.items].flatMap((item) => {
          const file = item.kind === "file" ? item.getAsFile() : null;
          return file ? [file] : [];
        });
    const images = files.filter(
      (file) => file.type.startsWith("image/") || /\.(?:png|jpe?g)$/iu.test(file.name),
    );
    if (!images.length) return false;
    if (images.length !== 1) {
      setNotice("Add one image at a time.");
      return true;
    }
    const { environmentId, cwd, documentPath } = imageContext.current;
    if (!environmentId || !cwd || !documentPath) {
      setNotice("Open a LaTeX document in a project before adding an image.");
      return true;
    }
    const file = images[0]!;
    const selection =
      position === undefined
        ? view.state.selection
        : Selection.near(
            view.state.doc.resolve(Math.max(0, Math.min(position, view.state.doc.content.size))),
          );
    const id = `latex-image-${++imageUploadSequence.current}`;
    view.dispatch(
      addLatexImageUpload(view.state.tr, id, selection.getBookmark()).setMeta(
        "addToHistory",
        false,
      ),
    );
    setNotice("Adding image to the project…");
    void uploadLatexImage(environmentId, { cwd, documentRelativePath: documentPath, file }).then(
      (uploaded) => {
        const current = editorRef.current;
        if (!current || current.isDestroyed || current.view !== view) return;
        const bookmark = latexImageUploadBookmark(view.state, id);
        if (!bookmark) return;
        refreshProjectEntriesQuery(environmentId, cwd);
        const source = latexFigureSource({
          documentPath,
          assetPath: uploaded.relativePath,
          source: currentSource.current,
        });
        const figure = projectLatexVisualDocument(source).content.content?.[0];
        view.dispatch(removeLatexImageUpload(view.state.tr, id).setMeta("addToHistory", false));
        if (!figure) {
          setNotice(
            `Image saved as ${uploaded.relativePath}, but the figure could not be inserted.`,
          );
          return;
        }
        view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
        const before = current.state.doc;
        const inserted = current.chain().focus().insertContent(figure).run();
        if (!inserted || current.state.doc === before)
          setNotice(
            `Image saved as ${uploaded.relativePath}, but the figure could not be inserted.`,
          );
        else
          setNotice((previous) => (previous === "Adding image to the project…" ? null : previous));
      },
      () => {
        const current = editorRef.current;
        if (current?.view === view)
          view.dispatch(removeLatexImageUpload(view.state.tr, id).setMeta("addToHistory", false));
        setNotice("Could not add the image. Use a PNG or JPEG under 20 MB.");
      },
    );
    return true;
  };

  const editor = useEditor({
    shouldRerenderOnTransaction: false,
    extensions: guardedExtensions,
    enableInputRules: false,
    enablePasteRules: false,
    content: initial.content,
    editable: !readOnly,
    editorProps: {
      handleClickOn: handleLatexObjectClick,
      clipboardTextSerializer: latexSelectionClipboard,
      handleDOMEvents: {
        copy: (view, event) => {
          const selection = view.state.selection;
          if (!(selection instanceof NodeSelection) || !(event instanceof ClipboardEvent))
            return false;
          const node = selection.node;
          const display = node.type.name === "latexDisplayMath";
          if (!display && node.type.name !== "latexInlineMath") return false;
          if (!event.clipboardData) return false;
          const source = latexVisualMathSource(
            {
              tex: String(node.attrs.tex ?? ""),
              environment: node.attrs.environment ? String(node.attrs.environment) : null,
              wrapper: node.attrs.wrapper,
            },
            display,
          );
          event.clipboardData.setData("text/plain", source);
          event.clipboardData.setData("application/x-latex", source);
          event.preventDefault();
          return true;
        },
        compositionend: () => {
          const doc = pendingTyping.current;
          if (doc) queueTyping(doc);
          return false;
        },
        dragover: (_view, event) => {
          if (!(event instanceof DragEvent) || !event.dataTransfer?.types.includes("Files"))
            return false;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          return true;
        },
      },
      handlePaste(view, event) {
        if (!view.editable) return false;
        if (handleImageTransfer(view, event.clipboardData)) {
          event.preventDefault();
          return true;
        }
        const source = (
          event.clipboardData?.getData("text/plain") ||
          event.clipboardData?.getData("application/x-latex")
        )?.trim();
        if (!source) return false;
        const editor = editorRef.current;
        if (!editor) return false;
        const pasted = mathClipboardSource(source);
        if (!pasted) {
          const blocks = latexClipboardBlocks(source);
          if (!blocks?.length) return false;
          event.preventDefault();
          return editor.chain().focus().insertContent(blocks).run();
        }
        event.preventDefault();
        return insertVisualMath(editor, pasted.display, pasted.attributes.tex, pasted.attributes);
      },
      handleDrop(view, event) {
        if (!view.editable || !event.dataTransfer?.types.includes("Files")) return false;
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        const handled = handleImageTransfer(view, event.dataTransfer, position);
        event.preventDefault();
        if (!handled) setNotice("Drop a PNG or JPEG image into the document.");
        return true;
      },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing || !view.editable) return false;
        if (
          event.key === "/" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          view.state.selection.empty &&
          view.state.selection.$from.parent.type.name === "paragraph" &&
          view.state.selection.$from.parent.content.size === 0
        ) {
          event.preventDefault();
          setInsertOpen(true);
          return true;
        }
        return false;
      },
      attributes: {
        class: "scient-latex-visual-document",
        "aria-label": "Visual LaTeX document editor",
      },
    },
    onCreate: ({ editor: created }) => {
      // Tiptap finishes mounting before selecting the first editable paragraph.
      // Doing this in a React effect is too early: mount can reset it to the title.
      const editor = created;
      const { selection, doc } = editor.state;
      if (!(selection instanceof NodeSelection) && selection.$from.parent.isTextblock) return;
      let target: number | null = null;
      doc.descendants((node, position) => {
        if (target !== null) return false;
        if (node.isTextblock && node.type.name === "paragraph") target = position + 1;
        return target === null;
      });
      if (target === null) return;
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, target))
          .setMeta("addToHistory", false),
      );
    },
    onUpdate: ({ editor: updated }) => {
      const doc = updated.state.doc;
      if (ordinaryDocuments.current.has(doc)) queueTyping(doc);
      else handleUpdateRef.current(doc);
    },
    onTransaction: ({ transaction, editor: updated }) => {
      // Setup-only steps can leave the projected body equal. Tiptap omits
      // onUpdate for those transactions, but their source and undo still belong
      // to the document's normal publication path.
      if (
        transaction.steps.some((step) => step instanceof LatexTitleStep) &&
        transaction.doc.eq(transaction.before)
      )
        handleUpdateRef.current(updated.state.doc);
      if (
        !ordinaryDocuments.current.has(updated.state.doc) &&
        !transaction.getMeta(latexPaginationKey) &&
        !cancelToolbarRefresh.current
      )
        cancelToolbarRefresh.current = afterEditorPaint(() => {
          cancelToolbarRefresh.current = null;
          refreshToolbar((value) => value + 1);
        });
    },
  });

  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const guidancePluginFactory = useRef(latexGuidancePlaceholders);
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // A renderer hot update keeps the existing editor and its original plugins.
    if (
      guidancePluginFactory.current !== latexGuidancePlaceholders ||
      !hasLatexGuidance(editor.state)
    ) {
      // By name: a hot update makes a new key, and the old plugin keeps the old one.
      editor.unregisterPlugin("scientLatexGuidance");
      editor.registerPlugin(latexGuidancePlaceholders(() => projection.current));
      guidancePluginFactory.current = latexGuidancePlaceholders;
    }
  }, [editor, latexGuidancePlaceholders]);
  const referencePluginFactory = useRef(latexEquationReferences);
  const paginationPluginFactory = useRef(createLatexVisualPagination);
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (
      paginationPluginFactory.current !== createLatexVisualPagination ||
      latexPaginationKey.getState(editor.state)?.pages === undefined
    ) {
      const dimensions = latexPaginationKey.getState(editor.state)?.dimensions;
      editor.unregisterPlugin("scientLatexPagination");
      editor.registerPlugin(createLatexVisualPagination(setPageCount));
      if (dimensions) setLatexPaginationDimensions(editor.view, dimensions);
      paginationPluginFactory.current = createLatexVisualPagination;
    }
  }, [editor, createLatexVisualPagination]);
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // A renderer hot update keeps the existing editor and its original plugins.
    if (
      referencePluginFactory.current !== latexEquationReferences ||
      latexEquationReferencesKey.getState(editor.state)?.defaultProofEnd === undefined ||
      !latexEquationReferencesKey.getState(editor.state)?.tables ||
      !latexEquationReferencesKey.getState(editor.state)?.figures ||
      !latexEquationReferencesKey.getState(editor.state)?.contents ||
      !latexEquationReferencesKey.getState(editor.state)?.headings
    ) {
      editor.unregisterPlugin("latexEquationReferences");
      editor.registerPlugin(
        latexEquationReferences(
          () => referenceSource.current,
          () => compiledBibliographySource.current,
        ),
      );
      referencePluginFactory.current = latexEquationReferences;
    }
    editor.view.dispatch(editor.state.tr.setMeta(latexEquationReferencesKey, true));
  }, [editor, props.rootSource, props.source, props.compiledBibliography, latexEquationReferences]);
  // Replace all writes each text block to the source before it edits the next.
  const commitTyping = useCallback(
    () => flushTypingRef.current() && flushSourceEditRef.current(),
    [],
  );
  const find = useLatexVisualSearch(editor, !readOnly, commitTyping);
  // Search is a field in the reader controls; the full find and replace bar
  // opens from their More menu.
  const [searchFocus, setSearchFocus] = useState(0);
  const findSnapshot = find.snapshot;
  const findController = find.controller;
  const headerSearch: ReaderSearch = {
    query: findSnapshot.findQuery,
    current: findSnapshot.findMatchCount > 0 ? findSnapshot.findActiveIndex + 1 : 0,
    total: findSnapshot.findMatchCount,
    notFound: findSnapshot.findQuery !== "" && findSnapshot.findMatchCount === 0,
    focusRequest: searchFocus,
    onQuery: (query) =>
      findController.configureFind({
        query,
        caseSensitive: findSnapshot.findCaseSensitive,
        wholeWord: findSnapshot.findWholeWord,
      }),
    onNavigate: (backwards) => findController.navigateFind(backwards ? -1 : 1),
    onClear: () =>
      find.open
        ? find.close()
        : findController.configureFind({ query: "", caseSensitive: false, wholeWord: false }),
  };
  const textStyle = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      value: current?.isActive("heading")
        ? String(current.getAttributes("heading").level)
        : current?.isActive("blockquote")
          ? "quote"
          : "paragraph",
      numbered: current?.isActive("heading")
        ? current.getAttributes("heading").unnumbered !== true
        : null,
    }),
  });

  const listState = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current && {
        type: selectedLatexListType(current.state),
        available: {
          bulletList: changeLatexList(current, "bulletList", false),
          orderedList: changeLatexList(current, "orderedList", false),
          description: changeLatexList(current, "description", false),
        },
        canRemove: changeLatexList(current, null, false),
        canIndent: current.can().sinkListItem("listItem"),
        canOutdent: current.can().liftListItem("listItem"),
      },
  });

  const mathMenu = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const selection = current?.state.selection;
      const math = selection instanceof NodeSelection ? selection.node : null;
      return {
        placement:
          math?.type.name === "latexInlineMath"
            ? ("inline-math" as const)
            : math?.type.name === "latexDisplayMath"
              ? ("equation" as const)
              : ("" as const),
        protected: Boolean(math?.attrs.numberingSource),
      };
    },
  });

  const restoredTyping = useRef<typeof typingRecovery>(null);
  useLayoutEffect(() => {
    if (!editor || !typingRecovery || restoredTyping.current === typingRecovery) return;
    restoredTyping.current = typingRecovery;
    try {
      const doc = editor.schema.nodeFromJSON(typingRecovery.draft.content);
      doc.check();
      applying.current = true;
      editor.commands.setContent(doc.toJSON(), { emitUpdate: false });
      ownTyping.current = typingRecovery.identity;
      queueTyping(editor.state.doc);
    } catch {
      // Not loadable into this editor: keep it as readable text in the
      // recovery line, where ordinary editing cannot clear it.
      setRecovery(parkUninstalledTypingDraft(props.draftKey));
    } finally {
      applying.current = false;
    }
  }, [editor, props.draftKey, queueTyping, typingRecovery]);

  useEffect(() => {
    if (!editor) return;
    return attachShortcutHost(editor.view.dom, ["latex", "math"], {
      capture: true,
      feedback: setShortcutHint,
      accepts: (event, command) => {
        const target = latexEditingTarget(editor);
        return (
          editor.isEditable &&
          target.isEditable &&
          !target.view.composing &&
          event.target instanceof Element &&
          !event.target.closest("input, textarea, select, math-field") &&
          (event.target.closest("[contenteditable]") === target.view.dom ||
            Boolean(command && latexSelectionCommand(command)))
        );
      },
      execute: (id) => shortcutAction.current(id),
    });
  }, [editor]);

  const fieldContext = useMemo(
    () => ({
      reportDraft,
      commit: (change: () => void | boolean) => {
        if (editBlocked.current) return false;
        const before = refusedChanges.current;
        return change() !== false && before === refusedChanges.current;
      },
      undo: (redo: boolean) => {
        if (redo) editor?.commands.redo();
        else editor?.commands.undo();
      },
    }),
    [editor, reportDraft],
  );
  const renameLabelRef = useRef<(before: string, after: string, fieldId?: string) => boolean>(
    () => false,
  );
  const authoringContext = useMemo(
    () => ({
      get source() {
        return completionSource.current;
      },
      preamble: mathSetupSource,
      prepare: () => flushTypingRef.current() && flushSourceEditRef.current(),
      reportError: setNotice,
      renameLabel: (before: string, after: string, fieldId?: string) =>
        renameLabelRef.current(before, after, fieldId),
    }),
    [mathSetupSource],
  );

  // Briefly read-only (an in-place rename holds the document): give the caret
  // back where it was once editing resumes, in the editor or in one of its
  // fields (title, author, captions), as the Markdown editor does.
  const focusedWhenLocked = useRef<{
    readonly element: HTMLElement;
    readonly selection: readonly [number, number] | null;
  } | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (readOnly && editor.isEditable) {
      const active = document.activeElement;
      focusedWhenLocked.current =
        active instanceof HTMLElement && editor.view.dom.contains(active)
          ? {
              element: active,
              selection:
                active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
                  ? [active.selectionStart ?? 0, active.selectionEnd ?? 0]
                  : null,
            }
          : null;
    }
    editor.setEditable(!readOnly);
    const locked = focusedWhenLocked.current;
    if (!readOnly && locked) {
      focusedWhenLocked.current = null;
      // Only if focus has gone nowhere else meanwhile (a dialog, another field).
      const active = document.activeElement;
      if (active !== null && active !== document.body && !editor.view.dom.contains(active)) return;
      if (locked.element === editor.view.dom || !locked.element.isConnected) {
        editor.commands.focus(undefined, { scrollIntoView: false });
        return;
      }
      // The field's node view re-enables it in its own render: try for a few
      // frames, and only while focus is still nowhere else.
      const field = locked.element;
      let frames = 0;
      const restore = () => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active !== field) return;
        const disabled = "disabled" in field && (field as { disabled?: boolean }).disabled === true;
        if (disabled) {
          if (++frames < 10) requestAnimationFrame(restore);
          return;
        }
        field.focus({ preventScroll: true });
        if (
          locked.selection &&
          (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)
        )
          field.setSelectionRange(locked.selection[0], locked.selection[1]);
      };
      restore();
    }
  }, [editor, readOnly]);

  useEffect(() => {
    // The editor's own source, or the last acknowledged buffer carried by an
    // unrelated parent render: the revision belongs to this editor's lineage.
    if (
      props.source === currentSource.current ||
      props.source === pendingSourceEdit.current?.expected
    ) {
      sourceRevision.current = props.fileRevision;

      observedSource.current = { source: props.source, revision: props.fileRevision };
      deferredSource.current = false;
      return;
    }
    // A draft report alone is not a new host observation. The parent may still
    // carry the last acknowledged source after accepting a local publication.
    if (
      !deferredSource.current &&
      observedSource.current.source === props.source &&
      observedSource.current.revision === props.fileRevision
    )
      return;
    observedSource.current = { source: props.source, revision: props.fileRevision };
    // Field callbacks are relative to the displayed node and original source.
    // Keep that context until its input is accepted or explicitly discarded;
    // replacing it here would let a delayed callback overwrite the new source.
    if ([...pendingFields.current].some((id) => id !== "source-publication")) {
      deferredSource.current = true;
      if (pendingTyping.current) retainOwnTyping(currentSource.current, pendingTyping.current);
      window.dispatchEvent(
        new CustomEvent("scient-latex-checkpoint-fields", { detail: props.draftKey }),
      );
      const fields = parkVisualFieldDrafts(props.draftKey);
      if (fields) setRecovery(fields);

      setNotice(
        "The source changed elsewhere. Your unsaved writing is retained here; resolve the source change before saving.",
      );
      return;
    }
    deferredSource.current = false;
    cancelSourcePublish.current?.();
    cancelSourcePublish.current = null;
    // An edit the editor accepted but had not published yet has no stored copy.
    // The outside source wins the page; the edit is kept as recovered work.
    const unpublished = pendingSourceEdit.current;
    if (unpublished && unpublished.change.source !== props.source)
      setRecovery(
        parkUnpublishedSource(props.draftKey, unpublished.change.source, sourceRevision.current),
      );
    pendingSourceEdit.current = null;
    reportDraft("source-publication", false);
    currentSource.current = props.source;
    sourceRevision.current = props.fileRevision;
    installProjection(
      projectLatexVisualDocument(props.source, 0, props.rootSource ?? props.source),
      true,
    );
    if (editor) {
      // Recreate state to clear obsolete undo history without resetting the caret
      // to the first block, which may be the document title.
      editor.view.updateState(
        EditorState.create({
          schema: editor.schema,
          doc: editor.state.doc,
          selection: editor.state.selection,
          plugins: editor.state.plugins,
        }),
      );
      const nextLayout = latexVisualLayoutProfile(props.rootSource ?? props.source);
      setLatexPaginationDimensions(editor.view, {
        pageHeight: nextLayout.paperHeightIn * CSS_PIXELS_PER_INCH,
        pageGap: 28,
        marginTop: nextLayout.marginTopIn * CSS_PIXELS_PER_INCH,
        marginBottom: nextLayout.marginBottomIn * CSS_PIXELS_PER_INCH,
      });
    }
    setNotice(null);
  }, [
    editor,
    installProjection,
    props.source,
    props.fileRevision,
    props.rootSource,
    props.draftKey,
    reportDraft,

    localDraftState.version,
  ]);

  // Runs after the effect above, so the editor has adopted the source that the
  // stored work is judged against.
  useEffect(() => {
    if (!rereadStartup || props.source !== currentSource.current) return;
    const next = readStartupRecovery(props.draftKey, { source: props.source });
    setRereadStartup(false);
    setTypingRecovery(typingToReinstall(next));
    setRecovery(next.recovery);
  }, [rereadStartup, props.draftKey, props.source]);

  const projectionParser = useRef(projectLatexVisualDocument);
  const projectionPreamble = useRef(projectionSetupKey);
  useEffect(() => {
    const parserChanged = projectionParser.current !== projectLatexVisualDocument;
    const changed =
      parserChanged ||
      projectionPreamble.current !== projectionSetupKey ||
      !projection.current.setup;
    if (
      !changed ||
      !editor ||
      editor.isDestroyed ||
      recovery ||
      pendingTyping.current ||
      pendingSourceEdit.current ||
      pendingFields.current.size > 0
    )
      return;
    projectionParser.current = projectLatexVisualDocument;
    projectionPreamble.current = projectionSetupKey;
    // A local setup transaction already reprojects the complete root. Repeating
    // that work here would discard the source step that makes it undoable.
    if (
      !parserChanged &&
      projection.current.setup &&
      projection.current.source === currentSource.current &&
      (!props.rootSource || props.rootSource === currentSource.current)
    )
      return;
    // Root declarations and parser hot updates can unlock formerly opaque blocks.
    // Keep the current source/caret, and avoid rebuilding while an edit is pending.
    installProjection(
      projectLatexVisualDocument(
        currentSource.current,
        0,
        props.rootSource ?? currentSource.current,
      ),
      true,
    );
    editor.view.updateState(
      EditorState.create({
        schema: editor.schema,
        doc: editor.state.doc,
        selection: editor.state.selection,
        plugins: editor.state.plugins,
      }),
    );
  }, [
    editor,
    installProjection,
    projectionSetupKey,
    props.rootSource,
    recovery,
    hasLocalDraft,
    projectLatexVisualDocument,
  ]);

  const registerFinishEditing = props.registerFinishEditing;
  useLayoutEffect(() => {
    registerFinishEditing?.(() => {
      editor?.view.dom
        .querySelectorAll("[data-table-cell]")
        .forEach((field) => field.dispatchEvent(new Event("scient-latex-flush-field")));
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        editor?.view.dom.closest(".scient-latex-visual-workspace")?.contains(field)
      )
        field.blur();
      editor?.commands.blur();
      activeMath.get()?.dismiss();
      const typingFinished = flushTypingRef.current();
      const sourceFinished = flushSourceEditRef.current(pendingTyping.current !== null);
      return typingFinished && sourceFinished && pendingFields.current.size === 0;
    });
    return () => registerFinishEditing?.(null);
  }, [editor, registerFinishEditing, activeMath]);

  const onEditingChange = props.onEditingChange;
  useEffect(() => () => onEditingChange(false), [onEditingChange]);

  const insertMath = (display: boolean, tex = "") => {
    if (activeMath.get() && !readOnly) {
      if (tex) activeMath.get()?.insert(tex);
      else activeMath.get()?.changeType(display ? "display-bracket" : "inline-paren");
      return;
    }
    if (editor && !readOnly) {
      const target = latexEditingTarget(editor);
      if (display && target !== editor && !tex) {
        setNotice("Use inline math inside a table cell.");
        return;
      }
      insertVisualMath(target, display && target === editor, tex);
    }
  };
  const openMathPicker = (kind: "matrix" | "symbols") => {
    if (!editor || readOnly) return;
    const field = activeMath.get();
    if (field && !field.flush()) return;
    if (kind === "symbols" && field) {
      setMathPicker(null);
      mathPickerTarget.current = null;
      pendingMathInsert.current = null;
      field.symbols();
      return;
    }
    const target = latexEditingTarget(editor);
    mathPickerTarget.current = {
      editor: target,
      doc: target.state.doc,
      selection: target.state.selection,
      field,
    };
    pendingMathInsert.current = null;
    setMathPicker(kind);
  };
  const finishMathPicker = (tex: string, display: boolean, action?: MathSymbol["action"]) => {
    pendingMathInsert.current = { tex, display, action };
    setMathPicker(null);
  };
  const mathPickerClosed = (open: boolean) => {
    if (open) return;
    const target = mathPickerTarget.current;
    const insertion = pendingMathInsert.current;
    mathPickerTarget.current = null;
    pendingMathInsert.current = null;
    if (!editor || editor.isDestroyed || !target) return;
    if (
      target.editor.isDestroyed ||
      target.editor.state.doc !== target.doc ||
      !target.editor.isEditable
    ) {
      if (insertion)
        setNotice(
          "The document changed while the picker was open. Place the cursor and try again.",
        );
      return;
    }
    target.editor.view.dispatch(target.editor.state.tr.setSelection(target.selection));
    if (target.field) {
      if (insertion?.action) target.field.command(insertion.action);
      else if (insertion) target.field.insert(insertion.tex);
      else target.field.focus();
    } else if (insertion) {
      const source =
        insertion.action === "moveToSuperscript"
          ? "{}^{}"
          : insertion.action === "moveToSubscript"
            ? "{}_{}"
            : insertion.tex.replace(/#[0-9?]/gu, "{}");
      insertVisualMath(target.editor, insertion.display && target.editor === editor, source);
    } else target.editor.view.focus();
  };
  const alignedEquations = () => {
    if (readOnly) return;
    const field = activeMath.get();
    if (field) field.changeType("aligned-equations");
    else if (editor) {
      const tex = alignedMathBody("{}");
      const target = latexEditingTarget(editor);
      insertVisualMath(
        target,
        target === editor,
        tex,
        target === editor ? { tex, environment: "align*", wrapper: "bracket" } : undefined,
      );
    }
  };

  const insertVisualSource = (source: string, wrap = false) => {
    if (!editor || textReadOnly) return;
    const nodes = projectLatexVisualDocument(source).content.content ?? [];
    if (nodes.length && !insertLatexBlock(editor, nodes, wrap))
      setNotice(
        "This insertion cannot preserve the selected content here. Place the cursor in ordinary text or edit Source.",
      );
  };
  const captureInsertion = () => {
    if (!editor || textReadOnly || !flushTypingRef.current()) return false;
    insertionTarget.current = { doc: editor.state.doc, selection: editor.state.selection };
    return true;
  };
  const restoreInsertion = () => {
    const target = insertionTarget.current;
    insertionTarget.current = null;
    if (!editor || !target || editor.isDestroyed || !editor.isEditable) return false;
    if (editor.state.doc !== target.doc) {
      setNotice("The document changed while the picker was open. Place the cursor and try again.");
      return false;
    }
    editor.view.dispatch(editor.state.tr.setSelection(target.selection));
    editor.view.focus();
    return true;
  };
  const openReferences = (mode: "reference" | "citation") => {
    if (!captureInsertion()) return;
    setReferenceMode(mode);
    setReferenceOpen(true);
  };
  const selectionInlineSource = () => {
    if (!editor) return null;
    const selection = editor.state.selection;
    if (
      !selection.$from.sameParent(selection.$to) ||
      !selection.$from.parent.isTextblock ||
      selection instanceof NodeSelection
    )
      return null;
    return serializeLatexVisualBlock({
      type: "paragraph",
      content:
        selection.$from.parent.content
          .cut(selection.$from.parentOffset, selection.$to.parentOffset)
          .toJSON() ?? [],
    });
  };
  const visitExisting = (kind: string, sourcePattern?: RegExp) => {
    if (!editor) return false;
    let found: number | null = null;
    editor.state.doc.descendants((node, position) => {
      if (
        found === null &&
        (node.attrs.kind === kind ||
          node.attrs.environment === kind ||
          sourcePattern?.test(String(node.attrs.raw ?? "")))
      )
        found = position;
    });
    if (found === null) return false;
    editor.chain().focus().setNodeSelection(found).scrollIntoView().run();
    return true;
  };
  const insertBibliography = () => {
    if (!editor || textReadOnly) return;
    if (visitExisting("bibliography", /\\(?:printbibliography|bibliography)\b/u)) return;
    const setup = withoutComments(props.rootSource ?? currentSource.current);
    if (/\\(?:printbibliography|bibliography)\b|\\begin\{thebibliography\}/u.test(setup)) {
      setNotice(
        "A bibliography is already configured in the root document. Open its Source to edit it.",
      );
      return;
    }
    if (captureInsertion()) setBibliographyDialog({ open: true });
  };

  const applyRichLayout = (source: string, textField: "body" | "title" = "body") => {
    const node = projectLatexVisualDocument(source).content.content?.[0];
    if (!node || !editor) return;
    const selectedNode =
      editor.state.selection instanceof NodeSelection ? editor.state.selection.node : null;
    if (
      selectedNode?.type.name === "latexRichPreview" &&
      selectedNode.attrs.editable === true &&
      !selectedNode.attrs.label &&
      !(selectedNode.attrs.kind === "scientific" && selectedNode.attrs.title) &&
      ["simple", "part", "abstract", "scientific"].includes(String(selectedNode.attrs.kind))
    ) {
      const content = String(selectedNode.attrs.body ?? selectedNode.attrs.title ?? "");
      const replacement = content
        ? {
            ...node,
            attrs:
              node.attrs?.kind === "description"
                ? { ...node.attrs, items: [{ label: "", body: content }] }
                : node.attrs?.kind === "bibliography"
                  ? { ...node.attrs, items: [{ label: "reference1", body: escapeText(content) }] }
                  : { ...node.attrs, [textField]: content },
          }
        : node;
      editor
        .chain()
        .focus()
        .insertContentAt(
          {
            from: editor.state.selection.from,
            to: editor.state.selection.to,
          },
          replacement,
        )
        .run();
      return;
    }
    const { $from } = editor.state.selection;
    if ($from.depth > 0) {
      const block = $from.node(1);
      if (
        (block.type.name === "paragraph" || block.type.name === "heading") &&
        !block.attrs.referenceLabel &&
        block.content.content.every(
          (child) => child.type.name === "text" && child.marks.length === 0,
        )
      ) {
        const content = block.textContent;
        const replacement = content
          ? {
              ...node,
              attrs:
                node.attrs?.kind === "description"
                  ? { ...node.attrs, items: [{ label: "", body: content }] }
                  : node.attrs?.kind === "bibliography"
                    ? { ...node.attrs, items: [{ label: "reference1", body: escapeText(content) }] }
                    : { ...node.attrs, [textField]: content },
            }
          : node;
        editor
          .chain()
          .focus()
          .insertContentAt({ from: $from.before(1), to: $from.after(1) }, replacement)
          .run();
        return;
      }
    }
    editor.chain().focus().insertContent(node).run();
  };

  const selectedRichText = () => {
    if (!editor || !(editor.state.selection instanceof NodeSelection)) return null;
    const selection = editor.state.selection;
    const node = selection.node;
    if (
      node.type.name !== "latexRichPreview" ||
      node.attrs.editable !== true ||
      node.attrs.label ||
      (node.attrs.kind === "scientific" && node.attrs.title) ||
      !["simple", "part", "abstract", "scientific"].includes(String(node.attrs.kind))
    )
      return null;
    return {
      from: selection.from,
      to: selection.to,
      text: String(node.attrs.body ?? node.attrs.title ?? ""),
    };
  };

  const paragraphContent = (text: string): JSONContent => ({
    type: "paragraph",
    ...(text ? { content: [{ type: "text", text }] } : {}),
  });

  const setHeadingStyle = (level: number, unnumbered: boolean) => {
    setNewHeadingNumbered(!unnumbered);
    const rich = selectedRichText();
    if (rich) {
      editor
        ?.chain()
        .focus()
        .insertContentAt(
          { from: rich.from, to: rich.to },
          {
            type: "heading",
            attrs: { level, unnumbered },
            ...(rich.text ? { content: [{ type: "text", text: rich.text }] } : {}),
          },
        )
        .run();
      return;
    }
    const referenceLabel = editor?.isActive("heading")
      ? (editor.getAttributes("heading").referenceLabel ?? null)
      : null;
    editor?.chain().focus().setNode("heading", { level, unnumbered, referenceLabel }).run();
  };

  const setListStyle = (target: LatexListType | null) => {
    if (!editor || textReadOnly) return false;
    const changed = changeLatexList(editor, target);
    if (changed && target === "description") {
      requestAnimationFrame(() => {
        if (!(editor.state.selection instanceof NodeSelection)) return;
        const element = editor.view.nodeDOM(editor.state.selection.from);
        if (element instanceof HTMLElement)
          element
            .querySelector<HTMLInputElement>('input[aria-label="Description item 1 label"]')
            ?.focus();
      });
    }
    if (!changed)
      setNotice(
        "This list change cannot preserve all of the selected content in Visual. Edit its LaTeX source instead.",
      );
    return changed;
  };

  const setQuoteStyle = () => {
    if (!editor) return;
    const rich = selectedRichText();
    if (rich) {
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: rich.from, to: rich.to },
          { type: "blockquote", content: [paragraphContent(rich.text)] },
        )
        .run();
    } else if (!editor.isActive("blockquote")) editor.chain().focus().toggleBlockquote().run();
  };

  const setStandardStyle = () => {
    if (!editor) return;
    const selection = editor.state.selection;
    if (selection instanceof NodeSelection && selection.node.type.name === "latexRichPreview") {
      const attrs = selection.node.attrs;
      if (
        !["simple", "part", "abstract", "scientific"].includes(String(attrs.kind)) ||
        attrs.label ||
        (attrs.kind === "scientific" && attrs.title)
      ) {
        editor.chain().focus().insertContentAt(selection.to, { type: "paragraph" }).run();
        return;
      }
      const text = String(attrs.body ?? attrs.title ?? "");
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: selection.from, to: selection.to },
          { type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) },
        )
        .run();
      return;
    }
    editor.chain().focus().clearNodes().setParagraph().run();
  };

  const insertTable = (rows: number, columns: number) => {
    const source = latexVisualTableSource(rows, columns, "grid");
    const table = projectLatexVisualDocument(source).content.content?.[0];
    if (!table) return;
    if (!editor || textReadOnly || !insertLatexBlock(editor, table)) return;
    const inserted = editor.state.selection;
    if (!(inserted instanceof NodeSelection)) return;
    const position = inserted.from;
    // The atom remains the source-edit anchor. Move actual focus into its first
    // cell once React has mounted the inline editor, clearing whole-table paint.
    let attempts = 0;
    const focusFirstCell = () => {
      if (
        editor.isDestroyed ||
        editor.state.selection.from !== position ||
        editor.state.doc.nodeAt(position)?.attrs.kind !== "table"
      )
        return;
      const dom = editor.view.nodeDOM(position);
      const field =
        dom instanceof HTMLElement
          ? dom.querySelector<HTMLElement>('[data-table-cell="0-0"]')
          : null;
      const inner = (field as (HTMLElement & { editor?: Editor }) | null)?.editor;
      if (inner) inner.commands.focus("start");
      else if (field) field.focus({ preventScroll: true });
      else if (++attempts < 10) requestAnimationFrame(focusFirstCell);
    };
    requestAnimationFrame(focusFirstCell);
  };
  const insertReference = (command: string, key: string) => {
    if (readOnly || !key || /[{}\\%]/u.test(key) || !restoreInsertion()) return;
    if (editor) editor.commands.setTextSelection(editor.state.selection.to);
    editor
      ?.chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        return true;
      })
      .insertContent({
        type: "latexInlineCommand",
        attrs: {
          name: command,
          argument: key,
          raw: `\\${command}{${key}}`,
        },
      })
      .run();
  };
  const inlineInsertReason =
    editor &&
    (!editor.state.selection.$from.parent.isTextblock ||
      editor.state.selection instanceof NodeSelection)
      ? "Place the cursor in ordinary text to insert this item."
      : undefined;
  // A link wraps text inside one paragraph; the button, the menu entry and the
  // shortcut all refuse the same selections the action itself would refuse.
  const linkUnavailableReason =
    inlineInsertReason ??
    (editor && !editor.state.selection.$from.sameParent(editor.state.selection.$to)
      ? "Select text within one paragraph to link it."
      : undefined);
  const insertActions: LatexInsertAction[] = [
    ...LATEX_HEADING_STYLES.map(({ level, label }) => ({
      id: `heading-${level}`,
      label,
      description: "Add a heading to the document outline",
      group: "Text",
      run: () => {
        editor?.chain().focus().setHeading({ level }).run();
      },
    })),
    {
      id: "paragraph",
      label: WRITING_COMMAND_LABELS.text,
      description: "Continue with ordinary text",
      group: "Text",
      run: () => {
        editor?.chain().focus().setParagraph().run();
      },
    },
    {
      id: "inline-math",
      label: "Inline math",
      description: "Write mathematics within a sentence (Alt+=)",
      group: "Math",
      run: () => insertMath(false),
    },
    {
      id: "equation",
      label: "Display math",
      description: "Write an equation on its own line",
      group: "Math",
      run: () => insertMath(true),
    },
    {
      id: "aligned",
      label: "Aligned equations",
      description: "Write multiple equations aligned at a relation",
      group: "Math",
      run: alignedEquations,
    },
    {
      id: "matrix",
      label: "Matrix",
      description: "Choose rows, columns, and brackets",
      group: "Math",
      run: () => openMathPicker("matrix"),
    },
    {
      id: "cases",
      label: "Cases",
      description: "Write a piecewise expression with conditions",
      group: "Math",
      run: () => insertMath(true, LATEX_CASES_TEMPLATE),
    },
    {
      id: "math-symbols",
      label: "Symbols",
      description: "Find symbols, fractions, roots, and other math structures",
      group: "Math",
      run: () => openMathPicker("symbols"),
    },
    {
      id: "figure",
      label: "Figure",
      description: "Choose an image from your project",
      group: "Objects",
      run: () =>
        props.rootRelativePath
          ? captureInsertion() && setFigureOpen(true)
          : setNotice("Choose a root document before inserting a figure."),
    },
    ...[
      "theorem",
      "definition",
      "proof",
      "lemma",
      "claim",
      "proposition",
      "corollary",
      "example",
      "remark",
    ].map((environment) => ({
      id: environment,
      label: environment[0]!.toUpperCase() + environment.slice(1),
      description: "Add an academic statement",
      group: "Academic",
      run: () => {
        const source = latexVisualScientificSource(environment);
        if (source) insertVisualSource(source, true);
      },
    })),
    {
      id: "reference",
      disabledReason: inlineInsertReason,
      label: "Cross-reference",
      description: "Refer to a labelled heading, equation, figure, table, or theorem",
      group: "References",
      run: () => openReferences("reference"),
    },
    {
      id: "citation",
      disabledReason: inlineInsertReason,
      label: "Citation",
      description: "Cite one or more bibliography sources",
      group: "References",
      run: () => openReferences("citation"),
    },
    {
      id: "link",
      disabledReason: linkUnavailableReason,
      label: WRITING_COMMAND_LABELS.link,
      description: "Link text to a web or email address",
      group: "References",
      run: () => {
        const source = selectionInlineSource();
        if (source === null || !captureInsertion()) return;
        pendingLink.current = null;
        setLinkDialog({
          open: true,
          text: editor!.state.doc.textBetween(
            editor!.state.selection.from,
            editor!.state.selection.to,
          ),
          source: source === "\\par" ? "" : source,
        });
      },
    },
    {
      id: "footnote",
      disabledReason: inlineInsertReason,
      label: "Footnote",
      description: "Add a note to this text",
      group: "References",
      run: () => {
        if (!editor || textReadOnly) return;
        const source = selectionInlineSource();
        if (source === null) {
          setNotice(
            "Select text within one paragraph, or place the cursor in text, to add a footnote.",
          );
          return;
        }
        const argument = source === "\\par" ? "" : source;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            closeHistory(tr);
            return true;
          })
          .insertContent({
            type: "latexInlineCommand",
            attrs: { name: "footnote", argument, raw: `\\footnote{${argument}}` },
          })
          .command(({ tr }) => {
            tr.setSelection(NodeSelection.create(tr.doc, tr.selection.from - 1));
            return true;
          })
          .run();
      },
    },
    ...(
      [
        ["code", "Code block", "lstlisting"],
        ["verbatim", "Literal text", "verbatim"],
        ["quotation", "Long quotation", "quotation"],
        ["verse", "Verse", "verse"],
        ["left-text", "Left-aligned text", "flushleft"],
        ["right-text", "Right-aligned text", "flushright"],
      ] as const
    ).map(([id, label, environment]) => ({
      id,
      label,
      description: "Insert a text block",
      group: "Text blocks",
      run: () => insertVisualSource("\\begin{" + environment + "}\n\n\\end{" + environment + "}"),
    })),
    {
      id: "bibliography",
      label: "Bibliography",
      description: "Insert a reference list",
      group: "References",
      run: insertBibliography,
    },
    {
      id: "part",
      label: "Part",
      description: "Insert a document part",
      group: "Document",
      run: () => insertVisualSource("\\part{}"),
    },
    ...(["title", "author", "date"] as const).map((field) => ({
      id: "document-" + field,
      label: "Document " + field,
      description: "Edit document metadata",
      group: "Document",
      run: () => openTitleField(field),
    })),
    {
      id: "abstract",
      label: "Abstract",
      description: "Add a summary",
      group: "Academic",
      run: () => {
        if (!visitExisting("abstract")) insertVisualSource("\\begin{abstract}\n\n\\end{abstract}");
      },
    },
    {
      id: "contents",
      label: "Table of contents",
      description: "Use the document headings",
      group: "References",
      run: () => {
        if (!visitExisting("contents", /\\tableofcontents\b/u))
          insertVisualSource("\\tableofcontents");
      },
    },
    {
      id: "pagebreak",
      label: "Page break",
      description: "Start the next content on a new page",
      group: "Layout",
      run: () => insertVisualSource("\\newpage"),
    },
  ];
  shortcutAction.current = (id) => {
    if (!editor || readOnly) return false;
    const selectionCommand = latexSelectionCommand(id);
    if (selectionCommand) return runLatexSelectionCommand(editor.view.dom, selectionCommand);
    if (id === "latex.shortcuts") {
      setShortcutsOpen(true);
      return true;
    }
    if (id === "latex.outline") {
      setNavigationOpen(!navigationOpen || navigationTab !== "outline");
      setNavigationTab("outline");
      return true;
    }
    if (id === "latex.bold")
      return mathTarget.current
        ? mathTarget.current.toggleTextFormat("bold")
        : toggleLatexProseMark(editor ? latexEditingTarget(editor) : null, "bold");
    if (id === "latex.italic")
      return mathTarget.current
        ? mathTarget.current.toggleTextFormat("italic")
        : toggleLatexProseMark(editor ? latexEditingTarget(editor) : null, "italic");
    if (id === "latex.inlineCode")
      return mathTarget.current
        ? mathTarget.current.toggleTextFormat("monospace")
        : toggleLatexProseMark(editor ? latexEditingTarget(editor) : null, "code");
    if (id === "latex.link") {
      const link = insertActions.find((action) => action.id === "link");
      if (!link || link.disabled || link.disabledReason) return false;
      link.run();
      return true;
    }
    if (id === "latex.bulletList") return setListStyle("bulletList");
    if (id === "latex.orderedList") return setListStyle("orderedList");
    if (id === "latex.table") {
      insertTable(2, 2);
      return true;
    }
    if (id === "math.palette") {
      insertActions.find((action) => action.id === "math-symbols")?.run();
      return true;
    }
    if (id === "math.inline" || id === "math.display") {
      insertMath(id === "math.display");
      return true;
    }
    if (id.startsWith("math.")) {
      const command = mathCommand(id);
      const custom = getKeyboardPreferences().preferences.customMath?.find(
        (entry) => entry.id === id,
      );
      if (!command && !custom) return false;
      const selected = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      );
      const edit = custom
        ? customMathEdit(custom, selected, { from: 0, to: selected.length })
        : commandEdit(command!, selected, { from: 0, to: selected.length });
      return insertVisualMath(latexEditingTarget(editor), false, edit.insert);
    }
    const actionId =
      (
        { section: "heading-1", subsection: "heading-2", subsubsection: "heading-3" } as Record<
          string,
          string
        >
      )[id.slice(6)] ?? id.slice(6);
    const action = insertActions.find((entry) => entry.id === actionId);
    if (!action || action.disabled || action.disabledReason) return false;
    action.run();
    return true;
  };
  const commitDocumentSource = (expected: string, source: string, owner?: string) => {
    if (
      !editor ||
      readOnly ||
      !flushTypingRef.current() ||
      !flushSourceEditRef.current() ||
      currentSource.current !== expected
    )
      return false;
    if (
      [...pendingFields.current].some(
        (key) => ![owner, "ordinary-text", "source-publication"].includes(key),
      )
    ) {
      setNotice("Finish or cancel the other open field draft before changing document setup.");
      return false;
    }
    if (source === expected) return true;
    const projected = projectLatexVisualDocument(source);
    const content = editor.schema.nodeFromJSON(projected.content).content;
    const before = editor.state.doc;
    const tr = closeHistory(editor.state.tr).step(
      new LatexTitleStep(0, before.content.size, new Slice(content, 0, 0), expected, source),
    );
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr));
    return currentSource.current === source && flushSourceEditRef.current();
  };
  const renameDocumentLabel = (before: string, after: string, fieldId?: string) => {
    if (!editor || !flushTypingRef.current() || !flushSourceEditRef.current()) return false;
    if (props.singleFileDocument === false) {
      setNotice("Renaming this label needs coordinated edits in the included files.");
      return false;
    }
    const expected = currentSource.current;
    const result = renameLatexLabel(expected, before, after);
    if ("error" in result) {
      setNotice(result.error);
      return false;
    }
    const { from, to } = editor.state.selection;
    if (!commitDocumentSource(expected, result.source, fieldId)) return false;
    editor.commands.setTextSelection({
      from: Math.min(from, editor.state.doc.content.size),
      to: Math.min(to, editor.state.doc.content.size),
    });
    setNotice(null);
    return true;
  };
  useLayoutEffect(() => {
    renameLabelRef.current = renameDocumentLabel;
  });
  const commitTitleSource = (expected: string, source: string) => {
    if (!editor || readOnly || !flushTypingRef.current() || !flushSourceEditRef.current())
      return false;
    if (currentSource.current !== expected) {
      setNotice("The document changed. Select the paragraph and try the title action again.");
      return false;
    }
    if (
      [...pendingFields.current].some(
        (key) => key !== "ordinary-text" && key !== "source-publication",
      )
    ) {
      setNotice("Finish or cancel the current field draft before changing the title block.");
      return false;
    }
    if (source === expected) return true;
    const projected = projectLatexVisualDocument(source);
    const content = editor.schema.nodeFromJSON(projected.content).content;
    const before = editor.state.doc;
    const tr = closeHistory(editor.state.tr).step(
      new LatexTitleStep(0, before.content.size, new Slice(content, 0, 0), expected, source),
    );
    editor.view.dispatch(tr);
    // Keep later typing separate from the title/preamble operation.
    editor.view.dispatch(closeHistory(editor.state.tr));
    return editor.state.doc !== before && flushSourceEditRef.current();
  };
  const addTitleBlock = () => {
    if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
    const expected = currentSource.current;
    const prepared = prepareLatexDocumentTitle(expected);
    if (!prepared) {
      setTitleHelp(
        "This title uses a custom structure. Edit its LaTeX to preserve the existing layout.",
      );
      return;
    }
    if (commitTitleSource(expected, prepared.source)) openTitleField("title");
  };
  const openTitleField = (field: "title" | "author" | "date") => {
    if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
    const title = projection.current.blocks.find((block) => block.node.attrs?.kind === "title");
    if (!title) {
      if (!props.source.includes("\\begin{document}") && props.onOpenRoot) {
        props.onOpenRoot("visual");
        return;
      }
      setTitleHelp(
        "This document has no title yet. Add one, or open the existing title in Source.",
      );
      return;
    }
    requestAnimationFrame(() => {
      const root = editor?.view.dom.querySelector<HTMLElement>(".scient-latex-title-preview");
      const target = root?.querySelector<HTMLTextAreaElement>(`[aria-label="Document ${field}"]`);
      if (target?.disabled) {
        setTitleHelp(
          `This ${field} contains custom formatting. Edit its LaTeX to preserve that formatting.`,
        );
        return;
      }
      root?.dispatchEvent(new CustomEvent("scient-latex-edit-title", { detail: field }));
    });
  };
  const openReferenceManager = useCallback(
    (key?: string) => {
      if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
      setReferencesRequest((previous) => ({
        ...(key ? { key } : {}),
        sequence: previous.sequence + 1,
      }));
      setReferencesOpen(true);
    },
    [setReferencesOpen],
  );
  const applyBibliographyDocument = useCallback(
    async (id: string, expected: string, next: string) => {
      if (readOnly || !flushTypingRef.current() || !flushSourceEditRef.current()) return false;
      if ([...pendingFields.current].some((field) => field !== "references")) {
        setNotice("Finish the current document field before saving a reference.");
        return false;
      }
      const current = currentSource.current;
      const confirm = async () => {
        if ((await props.flushReferenceEdits?.()) !== true) return false;
        const path = id === "root" ? props.rootRelativePath : props.relativePath;
        const published = props.confirmedReferenceSource
          ? props.confirmedReferenceSource()
          : props.documentPersistence
              ?.find((lease) => lease.target.relativePath === path)
              ?.getSnapshot().baselineSource;
        return (
          published != null && bibliographyChangePublished(expected, next, published, "bibitem")
        );
      };
      if (id === "root") {
        const root = props.rootSource;
        const merged = root && mergeBibliographyChange(expected, next, root, "bibitem");
        const accepted =
          !!props.canEditRoot &&
          !!root &&
          merged != null &&
          onEdit.current(current, current, { expected: root, next: merged });
        return accepted && (await confirm());
      }
      const merged = mergeBibliographyChange(expected, next, current, "bibitem");
      if (merged === null || !onEdit.current(current, merged)) return false;
      currentSource.current = merged;
      installProjection(projectLatexVisualDocument(merged, 0, props.rootSource ?? merged), true);
      return confirm();
    },
    [
      readOnly,
      props.canEditRoot,
      props.rootSource,
      props.rootRelativePath,
      props.relativePath,
      props.flushReferenceEdits,
      props.confirmedReferenceSource,
      props.documentPersistence,
      installProjection,
    ],
  );
  const bibliographyDocuments = useMemo<BibliographyDocument[]>(() => {
    const documents: BibliographyDocument[] = [
      {
        id: "document",
        path: props.relativePath ?? "Current document",
        source: props.source,
        kind: "bibitem",
        readOnly,
        apply: (expected, next) => applyBibliographyDocument("document", expected, next),
      },
    ];
    if (
      !props.source.includes("\\begin{document}") &&
      props.rootSource &&
      props.rootSource !== props.source
    ) {
      documents.push({
        id: "root",
        path: props.rootRelativePath ?? "Root document",
        source: props.rootSource,
        kind: "bibitem",
        readOnly: readOnly || !props.canEditRoot,
        apply: (expected, next) => applyBibliographyDocument("root", expected, next),
      });
    }
    return documents;
  }, [
    props.source,
    props.rootSource,
    props.relativePath,
    props.rootRelativePath,
    props.canEditRoot,
    readOnly,
    applyBibliographyDocument,
  ]);
  const openReferenceManagerRef = useRef(openReferenceManager);
  useLayoutEffect(() => {
    openReferenceManagerRef.current = openReferenceManager;
  }, [openReferenceManager]);
  const referencesContext = useMemo(
    () => ({
      open: (key?: string) => openReferenceManagerRef.current(key),
      entries: referenceCatalog,
    }),
    [referenceCatalog],
  );
  const selectedCitation = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const selection = current?.state.selection;
      return (
        selection instanceof NodeSelection &&
        selection.node.type.name === "latexInlineCommand" &&
        ["cite", "citep", "citet", "parencite", "textcite", "citeauthor", "citeyear"].includes(
          String(selection.node.attrs.name),
        )
      );
    },
  });
  const documentSettings = (
    <LatexDocumentSettings
      onOpenChange={setSettingsOpen}
      source={props.rootSource ?? props.source}
      disabled={readOnly || (!props.source.includes("\\begin{document}") && !props.canEditRoot)}
      onOpenSource={() => {
        settingsSourceAfterClose.current = true;
      }}
      onApply={(draft, original) => {
        if (!flushTypingRef.current() || !flushSourceEditRef.current()) return false;
        const expected = currentSource.current;
        const ownRoot = expected.includes("\\begin{document}");
        const settingsSource = ownRoot ? expected : props.rootSource;
        if (!settingsSource || settingsSource !== original) return false;
        const next = updateLatexVisualLayoutSource(settingsSource, draft);
        if (next === null) return false;
        if (!ownRoot) return onEdit.current(expected, expected, { expected: settingsSource, next });
        return commitDocumentSource(expected, next);
      }}
    />
  );
  const layout = useMemo(() => latexVisualLayoutProfile(mathSetupSource), [mathSetupSource]);
  const runningStyle = useMemo(() => latexRunningPageStyle(mathSetupSource), [mathSetupSource]);
  const runningMarks = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const marks: { page: number; level: number; text: string }[] = [];
      let section = 0,
        subsection = 0;
      for (const heading of current ? latexNavigationEntries(current.state.doc) : []) {
        if (![1, 2].includes(heading.level) || heading.unnumbered) continue;
        if (heading.level === 1) {
          section++;
          subsection = 0;
        } else subsection++;
        marks.push({
          page: current ? (latexVisualPageAt(current.state, heading.position) ?? 1) : 1,
          level: heading.level,
          text: `${section}${heading.level === 2 ? "." + subsection : ""} ${heading.runningTitle}`.toUpperCase(),
        });
      }
      return marks;
    },
  });
  const printedPages = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? latexVisualPageLabels(current.state) : []),
  });
  const titlePage = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current ? latexEquationReferencesKey.getState(current.state)?.titlePage === true : false,
  });
  const runningFields = (page: number) => {
    const marks = (runningMarks ?? []).filter((mark) => mark.page <= page);
    const left = marks.filter((mark) => mark.level === 1).at(-1)?.text ?? "";
    const currentSubsections = marks.filter((mark) => mark.level === 2 && mark.page === page);
    const right =
      currentSubsections[0]?.text ?? marks.filter((mark) => mark.level === 2).at(-1)?.text ?? "";
    return latexRunningPageFields(
      runningStyle,
      page,
      left,
      right,
      printedPages?.[page - 1] === undefined ? String(page) : printedPages[page - 1],
    );
  };
  const headingStyles = LATEX_HEADING_STYLES.filter(
    (style) =>
      style.command !== "chapter" ||
      /^(?:report|book|memoir|scrreprt|scrbook)$/u.test(layout.documentClass),
  );
  void editorRevision;
  const outline = editor ? latexNavigationEntries(editor.state.doc) : [];
  const selectionContext = (() => {
    if (!editor) return "Document";
    const selection = editor.state.selection as typeof editor.state.selection & {
      readonly node?: ProseMirrorNode;
    };
    const node = selection.node ?? selection.$from.parent;
    if (mathActive || node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
      return "Equation";
    if (node.type.name === "latexScientific") return String(node.attrs.environment);
    if (node.type.name === "latexRichPreview") {
      const kind = String(node.attrs.kind ?? "object");
      return kind === "scientific"
        ? String(node.attrs.environment ?? "Statement")
        : kind[0]!.toUpperCase() + kind.slice(1);
    }
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      const parent = selection.$from.node(depth);
      if (parent.type.name === "latexScientific") return String(parent.attrs.environment);
    }
    if (node.type.name === "heading") return `Heading ${String(node.attrs.level ?? 1)}`;
    if (node.type.name === "bulletList" || node.type.name === "orderedList") return "List";
    return "Body text";
  })();
  const pageHeight = layout.paperHeightIn * CSS_PIXELS_PER_INCH;
  const paperWidth = layout.paperWidthIn * CSS_PIXELS_PER_INCH;
  const pageGap = 28;
  const texPixels = (points: number) => `${(points * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH}px`;
  const paperColors = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(latexDocumentColors(mathSetupSource)).map(([name, value]) => [
          `--scient-color-${name}`,
          value,
        ]),
      ),
    [mathSetupSource],
  );
  const paperStyle = {
    ...paperColors,
    ...Object.fromEntries(
      Object.entries(latexVisualFontMetrics(layout.baseFontPt)).flatMap(
        ([name, [size, baseline]]) => [
          [`--scient-latex-size-${name}`, texPixels(size)],
          [`--scient-latex-baseline-${name}`, texPixels(baseline)],
        ],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(layout.lists).flatMap(([kind, list]) => [
        [`--scient-latex-${kind}-topsep`, `${list.topSepEm}em`],
        [`--scient-latex-${kind}-itemsep`, `${list.itemSepEm + list.parsepEm}em`],
        [`--scient-latex-${kind}-parsep`, `${list.parsepEm}em`],
        [`--scient-latex-${kind}-leftmargin`, `${list.leftMarginEm}em`],
        [`--scient-latex-${kind}-nested-topsep`, `${(list.nested ?? list).topSepEm}em`],
        [
          `--scient-latex-${kind}-nested-itemsep`,
          `${(list.nested ?? list).itemSepEm + (list.nested ?? list).parsepEm}em`,
        ],
        [`--scient-latex-${kind}-nested-parsep`, `${(list.nested ?? list).parsepEm}em`],
        [`--scient-latex-${kind}-nested-leftmargin`, `${(list.nested ?? list).leftMarginEm}em`],
      ]),
    ),
    "--scient-latex-paper-width": `${paperWidth}px`,
    "--scient-latex-paper-height": `${pageHeight}px`,
    "--scient-latex-page-gap": `${pageGap}px`,
    "--scient-latex-margin-top": `${layout.marginTopIn}in`,
    "--scient-latex-margin-right": `${layout.marginRightIn}in`,
    "--scient-latex-margin-bottom": `${layout.marginBottomIn}in`,
    "--scient-latex-margin-left": `${layout.marginLeftIn}in`,
    "--scient-latex-font-size": texPixels(layout.fontSizePt),
    "--scient-latex-font-family": layout.fontFamily,
    "--scient-latex-hebrew-font": latexLanguageFont(
      documentLanguage.hebrewFont,
      '"David", "Noto Serif Hebrew", serif',
    ),
    "--scient-latex-english-font": latexLanguageFont(
      documentLanguage.mainFont,
      '"KaTeX_Main", "Cambria", serif',
    ),
    "--scient-latex-text-align": layout.textAlign,
    "--scient-latex-column-gap": texPixels(layout.columnGapPt),
    "--scient-latex-column-rule": texPixels(layout.columnRulePt),
    "--scient-latex-section-size": texPixels(layout.sectionSizePt),
    "--scient-latex-subsection-size": texPixels(layout.subsectionSizePt),
    "--scient-latex-subsubsection-size": texPixels(layout.subsubsectionSizePt),
    "--scient-latex-title-size": texPixels(layout.titleSizePt),
    "--scient-latex-author-size": texPixels(layout.authorSizePt),
    "--scient-latex-line-height": String(layout.lineHeight),
    "--scient-latex-par-indent": `${layout.paragraphIndentEm}em`,
    "--scient-latex-par-gap": `${layout.paragraphGapEm}em`,
    "--scient-latex-theorem-sep": texPixels(
      layout.baseFontPt === 12 ? 10 : layout.baseFontPt === 11 ? 9 : 8,
    ),
    "--scient-latex-proof-sep": texPixels(6),
  } as CSSProperties;

  const layoutKey = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!editor) return;
    setLatexPaginationDimensions(editor.view, {
      pageHeight,
      pageGap,
      marginTop: layout.marginTopIn * CSS_PIXELS_PER_INCH,
      marginBottom: layout.marginBottomIn * CSS_PIXELS_PER_INCH,
    });
  }, [editor, layoutKey, layout.marginTopIn, layout.marginBottomIn, pageHeight]);

  const measureFitZoom = useCallback(() => {
    const scroll = visualScroll.current;
    if (!scroll) return null;
    const scale = pdfFitWidthScale(scroll.clientWidth, paperWidth);
    // Hidden or temporarily collapsed panes must not replace the last usable fit.
    if (scale === null || Math.round(scale * 100) <= 0) return null;
    return scale;
  }, [paperWidth]);

  useLayoutEffect(() => {
    const scroll = visualScroll.current;
    if (!scroll) return;
    const updateFitZoom = () => {
      const scale = measureFitZoom();
      if (scale !== null) setFitZoom(scale);
    };
    updateFitZoom();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFitZoom);
    observer?.observe(scroll);
    return () => observer?.disconnect();
  }, [measureFitZoom]);

  const zoom = zoomMode === "fit" ? fitZoom : zoomMode;
  const changeZoom = useLatexPinchZoom(visualScroll, zoom, setZoomMode);
  const fitWidth = () => {
    // The resize observer may not have delivered the pane's latest dimensions yet.
    const scale = measureFitZoom() ?? fitZoom;
    changeZoom(scale, () => {
      setFitZoom(scale);
      setZoomMode("fit");
    });
  };
  readerAction.current = (command) => {
    if (command === "pdf.find") setSearchFocus((request) => request + 1);
    else if (command === "pdf.zoomIn") changeZoom(stepPdfZoom(zoom, "in"));
    else if (command === "pdf.zoomOut") changeZoom(stepPdfZoom(zoom, "out"));
    else if (command === "pdf.actualSize") changeZoom(1);
    else return false;
    return true;
  };
  const pageStackHeight = pageCount * pageHeight + (pageCount - 1) * pageGap;
  const stageHeight = pageStackHeight;

  useEffect(() => {
    const scroll = visualScroll.current;
    if (!scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const paper = scroll.querySelector<HTMLElement>(".scient-latex-visual-paper");
      if (!paper) return;
      const top = scroll.getBoundingClientRect().top + Math.min(160, scroll.clientHeight / 3);
      setCurrentPage(
        Math.max(
          1,
          Math.min(
            pageCount,
            Math.floor(
              (top - paper.getBoundingClientRect().top) / (zoom * (pageHeight + pageGap)),
            ) + 1,
          ),
        ),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      scroll.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [pageCount, pageHeight, zoom]);

  // The same inline formatting, in the same order, as the Markdown bar; LaTeX
  // has no strikethrough.
  // Inline formatting acts on text; on an object (title, figure, equation) it is off.
  const { editor: editingTarget, state: editingState } = useLatexEditingState(editor, true);
  const caretInText = Boolean(
    editor &&
    !(editor.state.selection instanceof NodeSelection) &&
    editor.state.selection.$from.parent.isTextblock,
  );
  const formattingAvailable = Boolean(
    editingTarget?.isEditable &&
    editingState &&
    !(editingState.selection instanceof NodeSelection) &&
    editingState.selection.$from.parent.isTextblock,
  );
  const formatActions = [
    {
      id: "latex.bold",
      mathFormat: "bold" as const,
      label: WRITING_COMMAND_LABELS.bold,
      icon: <WritingCommandIcon command="bold" />,
      action: () => shortcutAction.current("latex.bold"),
      active: editingTarget?.isActive("bold"),
      preserveIconWeight: true,
      disabled: !formattingAvailable,
    },
    {
      id: "latex.italic",
      mathFormat: "italic" as const,
      label: WRITING_COMMAND_LABELS.italic,
      icon: <WritingCommandIcon command="italic" />,
      action: () => shortcutAction.current("latex.italic"),
      active: editingTarget?.isActive("italic"),
      preserveIconWeight: false,
      disabled: !formattingAvailable,
    },
    {
      id: "latex.inlineCode",
      mathFormat: "monospace" as const,
      label: mathActive ? "Monospace" : WRITING_COMMAND_LABELS.inlineCode,
      icon: <WritingCommandIcon command="inlineCode" />,
      action: () => shortcutAction.current("latex.inlineCode"),
      active: editingTarget?.isActive("code"),
      preserveIconWeight: true,
      disabled: !formattingAvailable,
    },
  ];

  const singleFile = props.singleFileDocument !== false;
  // Show what storage holds after a choice.
  const settleRecovery = (shown: LatexVisualRecovery, resolved: boolean) => {
    if (shown.parked) {
      setRecovery(readStoredRecovery(props.draftKey));
      return;
    }
    // Still waiting in its live slot: the editor stays read-only.
    if (!resolved && isRecoveryStored(props.draftKey, shown)) return;
    setRecovery(null);
    setRereadStartup(true);
  };
  const applyRecovery = (comparedSource: string) => {
    if (recovery?.source == null) return false;
    // Another view may have resolved or replaced this entry meanwhile.
    if (!isRecoveryStored(props.draftKey, recovery)) {
      settleRecovery(recovery, false);
      return false;
    }
    if (!canApplyRecovery(recovery, comparedSource, { source: props.source, singleFile }))
      return false;
    // Writing done since must be part of the source the user compared. If any
    // of it was still unconverted or unpublished, the comparison is out of date.
    if (!flushTypingRef.current() || !flushSourceEditRef.current()) return false;
    if (currentSource.current !== comparedSource) return false;
    // Saved against the exact source the user compared. If the file moved
    // since, the revision-checked save refuses and the bar shows the new state.
    if (!onEdit.current(comparedSource, recovery.source)) return false;
    // The recovered work stays recoverable until its save is acknowledged.
    const resolved = journalAppliedRecovery(
      props.draftKey,
      { ...recovery, source: recovery.source },
      { source: comparedSource, revision: sourceRevision.current },
    );
    settleRecovery(recovery, resolved);
    return true;
  };
  const discardRecovery = () => {
    if (!recovery) return;
    // Remove only the record this bar shows; any other waiting work is shown next.

    const removed = removeRecovery(props.draftKey, recovery);
    if (removed && rawInputRecovery.current?.identity === recovery.identity) {
      if (rawInputPersistedRecovery.current !== null)
        removeRecovery(props.draftKey, rawInputPersistedRecovery.current);
      rawInputPersistedRecovery.current = null;
      rawInputRecovery.current = null;
      reportDraft("block-source", false);
      setBlockSource(null);
    }
    settleRecovery(recovery, removed);
  };

  const openBlockSource = (position: number) => {
    if (
      blockSource &&
      blockSource.draft !== blockSource.original &&
      blockSource.position !== position
    ) {
      setNotice("Apply or cancel this LaTeX draft before opening another block.");
      return;
    }
    if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
    if (!editor) return;
    const blocks = projection.current.blocks;
    // Source IDs reflect the previous projection until the next renderer install.
    // The node view's live position follows insertions and deletions immediately.
    const index = editor.state.doc.resolve(position).index(0);
    const block = blocks[index];
    const node = editor.state.doc.nodeAt(position);
    if (
      !block ||
      block.editable ||
      node?.type.name !== "latexRawBlock" ||
      node.attrs.raw !== block.source
    )
      return;
    rawInputInteraction.current = randomUUID();
    rawInputRecovery.current = null;
    rawInputPersistedRecovery.current = null;
    setBlockSource({
      id: block.id,
      position,
      baseSource: currentSource.current,
      original: block.source,
      draft: block.source,
    });
    editor.commands.setNodeSelection(position);
    requestAnimationFrame(() => {
      editor.view.dom.querySelector<HTMLElement>('[aria-label="Block LaTeX source"]')?.focus();
    });
  };
  const retireRawInput = () => {
    const retained = rawInputRecovery.current;
    if (retained === null) return;
    removeRecovery(props.draftKey, retained);
    if (rawInputPersistedRecovery.current !== null)
      removeRecovery(props.draftKey, rawInputPersistedRecovery.current);
    rawInputPersistedRecovery.current = null;
    rawInputRecovery.current = null;
    // A quota failure exposes the in-memory copy in the recovery bar.
    // Cancelling that exact draft must also release its read-only fallback.
    setRecovery((shown) =>
      shown?.identity === retained.identity ? readStoredRecovery(props.draftKey) : shown,
    );
  };
  const blockSourceContext = {
    active: blockSource,
    disabled: readOnly,
    open: openBlockSource,
    remove: (position: number, original: string) => {
      if (!editor || readOnly || !editor.isEditable || editor.isDestroyed) return;
      if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
      const ownDraft = blockSource?.position === position;
      if (
        deferredSource.current ||
        [...pendingFields.current].some(
          (id) =>
            id !== "ordinary-text" &&
            id !== "source-publication" &&
            !(ownDraft && id === "block-source"),
        )
      ) {
        setNotice("Finish or cancel the other draft before deleting this source block.");
        return;
      }
      if (position < 0 || position >= editor.state.doc.content.size) return;
      const current = editor.state.doc.nodeAt(position);
      const block = projection.current.blocks[editor.state.doc.resolve(position).index(0)];
      const expected = currentSource.current;
      if (
        !block ||
        block.editable ||
        current?.type.name !== "latexRawBlock" ||
        current.attrs.raw !== original ||
        block.source !== original ||
        (ownDraft && blockSource.baseSource !== expected)
      ) {
        setNotice("This source block changed. Reopen it before deleting it.");
        return;
      }
      const next = expected.slice(0, block.from) + expected.slice(block.to);
      const projected = projectLatexVisualDocument(next, 0, props.rootSource ?? next);
      const content = editor.schema.nodeFromJSON(projected.content).content;
      const before = editor.state.doc;
      const tr = closeHistory(editor.state.tr).step(
        new LatexTitleStep(0, before.content.size, new Slice(content, 0, 0), expected, next),
      );
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(position, tr.doc.content.size))));
      editor.view.dispatch(tr);
      if (editor.state.doc === before || !flushSourceEditRef.current()) return;
      editor.view.dispatch(closeHistory(editor.state.tr));
      retireRawInput();
      reportDraft("block-source", false);
      setBlockSource(null);
      preserveLatexCaret(editor.view);
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    change: (draft: string) => {
      const changed = draft !== blockSource?.original;
      if (changed) {
        const retained = parkUnappliedInput(
          props.draftKey,
          draft,
          rawInputInteraction.current,
          rawInputPersistedRecovery.current,
        );
        rawInputRecovery.current = retained;
        if (retained.parked) rawInputPersistedRecovery.current = retained;
        if (!retained.parked) setRecovery(retained);
      } else retireRawInput();
      reportDraft("block-source", changed);
      setBlockSource((previous) => (previous ? { ...previous, draft } : null));
    },
    close: () => {
      retireRawInput();
      reportDraft("block-source", false);
      setBlockSource(null);
    },
    apply: () => {
      if (!blockSource || readOnly) return;
      const block = projection.current.blocks.find((item) => item.id === blockSource.id);
      if (
        !block ||
        block.source !== blockSource.original ||
        currentSource.current !== blockSource.baseSource
      ) {
        setNotice(
          "This block changed outside Visual. Copy your draft, then reopen the current block.",
        );
        return;
      }
      const expected = currentSource.current;
      const next = expected.slice(0, block.from) + blockSource.draft + expected.slice(block.to);
      if (!onEdit.current(expected, next)) {
        setNotice(
          "The LaTeX draft has not been saved. Resolve the file conflict and try Apply again.",
        );
        return;
      }
      // Do not retire unapplied input until the accepted source has a durable copy.
      checkpointVisualDraft(props.draftKey, next, expected, next, sourceRevision.current);
      if (flushVisualDraft(props.draftKey) && rawInputRecovery.current !== null)
        removeRecovery(props.draftKey, rawInputRecovery.current);
      rawInputRecovery.current = null;
      rawInputPersistedRecovery.current = null;
      currentSource.current = next;
      reportDraft("block-source", false);
      setBlockSource(null);
      installProjection(projectLatexVisualDocument(next, 0, props.rootSource ?? next), true);
    },
  };
  const headingNumbered = textStyle?.numbered ?? newHeadingNumbered;
  // Icons follow the depth of the heading in this document class, as in the Markdown bar.
  const headingIcons = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6];
  const headingIcon = (level: number) => {
    const Icon =
      headingIcons[headingStyles.findIndex((style) => style.level === level)] ?? Heading1;
    return <Icon className="size-4" />;
  };
  const activeStyle = textStyle?.value ?? "paragraph";
  // Inside a list item the LaTeX source cannot hold a quote.
  const quoteUnavailable = !textReadOnly && Boolean(listState?.type);
  const textBlockItems = (ids: readonly string[]) =>
    ids.map((id) => {
      const action = insertActions.find((item) => item.id === id);
      if (!action) return null;
      return (
        <DockCommandItem
          key={id}
          disabled={textReadOnly || action.disabled || Boolean(action.disabledReason)}
          title={action.disabledReason}
          onClick={action.run}
        >
          <MenuRow label={action.label} />
        </DockCommandItem>
      );
    });
  const writingStyleItems = (
    <>
      <MenuRadioGroup value={activeStyle}>
        <DockCommandRadioItem value="paragraph" disabled={textReadOnly} onClick={setStandardStyle}>
          <MenuRow
            icon={<WritingCommandIcon command="text" />}
            label="Paragraph"
            shortcut={menuShortcut("latex.paragraph")}
          />
        </DockCommandRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuRadioGroup value={textStyle?.value ?? "paragraph"}>
        {headingStyles.map(({ level, label, command }) => (
          <DockCommandRadioItem
            key={level}
            value={String(level)}
            disabled={textReadOnly}
            onClick={() => setHeadingStyle(level, !headingNumbered)}
          >
            <MenuRow
              icon={headingIcon(level)}
              label={label}
              // "paragraph" here is the Paragraph heading, not the Text style.
              shortcut={
                command === "section" || command === "subsection" || command === "subsubsection"
                  ? menuShortcut(`latex.${command}`)
                  : undefined
              }
            />
          </DockCommandRadioItem>
        ))}
      </MenuRadioGroup>
      {textBlockItems(["part"])}
      {/* Whether headings are numbered: the last line of the headings, a small switch. */}
      <MenuCheckboxItem
        variant="switch"
        checked={headingNumbered}
        disabled={textReadOnly}
        closeOnClick={false}
        onCheckedChange={(numbered) => {
          if (textReadOnly) return;
          setNewHeadingNumbered(numbered);
          // Keep focus in the open menu while updating the selected heading.
          if (editor?.isActive("heading"))
            editor.commands.updateAttributes("heading", { unnumbered: !numbered });
        }}
      >
        Numbered headings
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuRadioGroup value={textStyle?.value ?? "paragraph"}>
        <DockCommandRadioItem
          value="quote"
          disabled={textReadOnly || quoteUnavailable}
          onClick={setQuoteStyle}
        >
          <MenuRow
            icon={<WritingCommandIcon command="quote" />}
            label={WRITING_COMMAND_LABELS.quote}
          />
        </DockCommandRadioItem>
      </MenuRadioGroup>
      {textBlockItems(["quotation"])}
    </>
  );
  const writingFormattingItems = (
    <>
      {formatActions.map((action) => (
        <DockCommandCheckboxItem
          key={action.id}
          checked={
            mathActive
              ? Boolean(mathTarget.current?.textFormatActive(action.mathFormat))
              : Boolean(action.active)
          }
          disabled={
            readOnly || !editor || mathFormattingUnavailable || (!mathActive && action.disabled)
          }
          aria-keyshortcuts={commandShortcut(action.id)?.ariaKeyShortcuts}
          onClick={action.action}
        >
          <MenuRow icon={action.icon} label={action.label} shortcut={commandShortcut(action.id)} />
        </DockCommandCheckboxItem>
      ))}
    </>
  );
  const writingTextContents = {
    paragraphStyle: writingStyleItems,
    formatting: writingFormattingItems,
    alignment: textBlockItems(["left-text", "right-text"]),
    commandScope: "latex",
  };
  const writingTextTools = <TextMenu {...writingTextContents} disabled={readOnly} />;
  // Some places cannot hold a list (a statement's title, a selected figure).
  const listsUnavailable =
    !textReadOnly &&
    listState !== null &&
    listState !== undefined &&
    listState.type === null &&
    !listState.available.bulletList &&
    !listState.available.orderedList;
  const writingListItems = (
    <>
      <MenuRadioGroup value={listState?.type ?? "none"}>
        {(
          [
            {
              value: "bulletList",
              label: WRITING_COMMAND_LABELS.bulletList,
              icon: <WritingCommandIcon command="bulletList" />,
              shortcut: menuShortcut("latex.bulletList"),
            },
            {
              value: "orderedList",
              label: WRITING_COMMAND_LABELS.numberedList,
              icon: <WritingCommandIcon command="numberedList" />,
              shortcut: menuShortcut("latex.orderedList"),
            },
          ] as const
        ).map(({ value, label, icon, shortcut }) => (
          <DockCommandRadioItem
            key={value}
            value={value}
            disabled={textReadOnly || !listState?.available[value]}
            aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
            onClick={() => setListStyle(value)}
          >
            <MenuRow icon={icon} label={label} shortcut={shortcut} />
          </DockCommandRadioItem>
        ))}
        <MenuSeparator />
        <DockCommandRadioItem
          value="none"
          disabled={textReadOnly || (Boolean(listState?.type) && !listState?.canRemove)}
          onClick={() => {
            // Outside a list this is the current state, not a change.
            if (listState?.type) setListStyle(null);
          }}
        >
          <MenuRow
            icon={<WritingCommandIcon command="noList" />}
            label={WRITING_COMMAND_LABELS.noList}
          />
        </DockCommandRadioItem>
      </MenuRadioGroup>
    </>
  );
  const activeListLabel =
    listState?.type === "orderedList"
      ? "Numbered"
      : listState?.type === "bulletList"
        ? "Bullet"
        : listState?.type === "description"
          ? "Description"
          : "None";
  const writingListTools = (
    <>
      <DockMenu
        commandScope="latex"
        label={`List: ${activeListLabel}`}
        icon={
          <WritingCommandIcon
            command={listState?.type === "orderedList" ? "numberedList" : "bulletList"}
          />
        }
        disabled={textReadOnly}
        popupClassName="w-48"
      >
        {writingListItems}
      </DockMenu>
      <DockDivider />
    </>
  );
  const writingInsertTools = (
    <div ref={linkAnchor} className="scient-latex-toolbar-group">
      <LatexInsertMenu
        open={insertOpen && !readOnly}
        onOpenChange={setInsertOpen}
        actions={insertActions.filter(
          (action) =>
            !action.id.startsWith("heading-") &&
            action.id !== "paragraph" &&
            !action.id.startsWith("document-") &&
            action.group !== "Math",
        )}
        disabled={readOnly}
        unavailableReason={
          mathActive
            ? "Finish editing math to insert a document element. Math tools remain in Math."
            : undefined
        }
        onInsertTable={insertTable}
        onReturnFocus={() =>
          activeMath.get()
            ? activeMath.get()?.focus()
            : editor?.commands.focus(undefined, { scrollIntoView: false })
        }
      />
      <DockDivider />
    </div>
  );
  const writingMathItems = (
    <LatexMathMenuItems
      placement={mathMenu?.placement ?? ""}
      disabled={readOnly}
      protectedSource={mathMenu?.protected}
      displayAvailable={Boolean(editingTarget?.schema.nodes.latexDisplayMath)}
      onPlacement={(display) => insertMath(display)}
      onAligned={alignedEquations}
      matrixEnvironment={matrixEnvironment}
      onMatrixEnvironment={setMatrixEnvironment}
      onInsert={(tex) => insertMath(true, tex)}
      onBrackets={(tex) => insertMath(false, activeMath.get() ? tex : tex.replaceAll("#0", "{}"))}
      onSymbols={() => openMathPicker("symbols")}
    />
  );
  const writingMathTools = (
    <DockMenu
      commandScope="latex"
      label="Math"
      // The word alone: "Math" says what it is.
      icon={<span className="text-[13px]">Math</span>}
      disabled={readOnly}
      // Size to the menu's contents.
      popupClassName="w-max [&_[role=menuitem]]:whitespace-nowrap [&_[role=menuitemradio]]:whitespace-nowrap"
    >
      {writingMathItems}
    </DockMenu>
  );
  const writingMathBar = (
    <>
      {writingMathTools}
      <DockDivider />
    </>
  );
  const undo = () => {
    if (activeMath.get()) activeMath.get()?.undo(false);
    else editor?.chain().focus().undo().run();
  };
  const redo = () => {
    if (activeMath.get()) activeMath.get()?.undo(true);
    else editor?.chain().focus().redo().run();
  };
  const writingHistoryTools = (
    <>
      <DockButton
        label={WRITING_COMMAND_LABELS.undo}
        shortcut={scientMarkdownShortcut("undo")}
        icon={<WritingCommandIcon command="undo" />}
        disabled={readOnly || (!mathActive && !editor?.can().undo())}
        onClick={undo}
      />
      <DockButton
        label={WRITING_COMMAND_LABELS.redo}
        shortcut={scientMarkdownShortcut("redo")}
        icon={<WritingCommandIcon command="redo" />}
        disabled={readOnly || (!mathActive && !editor?.can().redo())}
        onClick={redo}
      />
      <DockDivider />
    </>
  );
  const goToPage = (requested: number) => {
    const scroll = visualScroll.current;
    const paper = scroll?.querySelector<HTMLElement>(".scient-latex-visual-paper");
    if (!scroll || !paper) return;
    const page = clampPdfPage(requested, pageCount);
    setCurrentPage(page);
    scroll.scrollTop +=
      paper.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      (page - 1) * zoom * (pageHeight + pageGap);
  };
  const overflowInsertActions = insertActions.filter(
    (action) =>
      !action.id.startsWith("heading-") &&
      action.id !== "paragraph" &&
      !action.id.startsWith("document-") &&
      action.group !== "Math",
  );
  const displayedTitle = projection.current.blocks.some(
    (block) => block.node.attrs?.kind === "title",
  );
  const canAddTitle = useMemo(
    () => !displayedTitle && prepareLatexDocumentTitle(props.source) !== null,
    [displayedTitle, props.source],
  );
  const openDocumentSettings = (section: LatexDocumentSettingsSection) => {
    if (!flushTypingRef.current() || !flushSourceEditRef.current()) return;
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  const readerHost = useContext(ReaderBarHostContext);
  const documentItems = (
    <>
      <MenuSub>
        <MenuSubTrigger>Title &amp; authors</MenuSubTrigger>
        <MenuSubPopup className="w-max min-w-0" data-dock-command-scope="latex">
          {displayedTitle ? (
            <>
              <DockCommandItem disabled={readOnly} onClick={() => openTitleField("title")}>
                Edit title
              </DockCommandItem>
              <DockCommandItem disabled={readOnly} onClick={() => openTitleField("author")}>
                Edit authors
              </DockCommandItem>
              <DockCommandItem disabled={readOnly} onClick={() => openTitleField("date")}>
                Edit date
              </DockCommandItem>
            </>
          ) : (
            // Only when the document has none: adding a title is always a choice.
            <DockCommandItem
              disabled={readOnly || !canAddTitle}
              title={canAddTitle ? undefined : "This title is controlled by its LaTeX source."}
              onClick={addTitleBlock}
            >
              Add a title
            </DockCommandItem>
          )}
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      <MenuSub
        open={settingsOpen}
        onOpenChange={(open) => {
          if (open) openDocumentSettings("page");
          else setSettingsOpen(false);
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          setSettingsSection(null);
          if (settingsSourceAfterClose.current) {
            settingsSourceAfterClose.current = false;
            (props.onOpenRoot ?? props.onOpenSource)();
          }
        }}
      >
        <MenuSubTrigger disabled={readOnly}>Document settings</MenuSubTrigger>
        <MenuSubPopup
          className="w-96 max-w-[calc(100vw-2rem)]"
          aria-label="Document settings"
          data-dock-command-scope="latex"
          finalFocus={false}
        >
          {settingsSection !== null ? documentSettings : null}
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      <DockCommandItem onClick={() => openReferenceManager()}>References</DockCommandItem>
      {readOnly ? null : <DockCommandItem onClick={find.show}>Find and replace</DockCommandItem>}
      {readerHost?.documentActions}
      <MenuSeparator />
      <DockCommandItem onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts</DockCommandItem>
    </>
  );
  const [objectPosition, setObjectPosition] = useState<string | null>(null);
  const [activeObjectPosition, setActiveObjectPosition] = useState<string | null>(null);
  // The footer follows the caret: where it is, and how much has been written.
  const footerPosition = (() => {
    if (activeObjectPosition)
      return activeObjectPosition.slice(0, 1).toUpperCase() + activeObjectPosition.slice(1);
    const heading = /^Heading (\d+)$/u.exec(selectionContext);
    if (heading)
      return headingStyles.find((style) => String(style.level) === heading[1])?.label ?? "Heading";
    const selected = (editor?.state.selection as { readonly node?: ProseMirrorNode } | undefined)
      ?.node;
    if (selected?.type.name === "latexRawBlock") return "Source-only block";
    if (objectPosition) return objectPosition;
    if (selectionContext === "Body text" || selectionContext === "List") {
      if (listState?.type === "bulletList") return WRITING_COMMAND_LABELS.bulletList;
      if (listState?.type === "orderedList") return WRITING_COMMAND_LABELS.numberedList;
      if (listState?.type === "description") return "Description list";
      return WRITING_COMMAND_LABELS.text;
    }
    return selectionContext.slice(0, 1).toUpperCase() + selectionContext.slice(1);
  })();
  // Counted only where the footer shows it.
  const hostsFooter = readerHost !== null && readerHost.slot !== null;
  const sourceWords = useMemo(
    () => (hostsFooter ? countLatexWords(props.source) : 0),
    [hostsFooter, props.source],
  );
  const selectedWords = editingState ? countSelectedWords(editingState) : null;
  const footerWords = {
    // The total is an estimate from the source; it never reads below the selection.
    total: Math.max(sourceWords, selectedWords ?? 0),
    selected: selectedWords,
  };
  // The same find and replace bar as the Markdown editor.
  const searchBar = find.open ? (
    <ScientFindBar controller={find.controller} snapshot={find.snapshot} />
  ) : null;
  const contextTools = (
    <LatexContextTools onPositionChange={setActiveObjectPosition}>
      {editor && !readOnly && editor.isActive("heading") ? (
        <LatexHeadingToolbar
          editor={editor}
          draftKey={props.draftKey}
          onRename={renameDocumentLabel}
        />
      ) : null}
      {editor && !readOnly ? <LatexListControls editor={editor} /> : null}
    </LatexContextTools>
  );
  return (
    <LatexCommandContext value={commandContext}>
      <LatexBlockSourceContext value={blockSourceContext}>
        <LatexRootContext value={props.rootRelativePath ?? null}>
          <LatexWorkspaceContext value={workspaceContext}>
            <LatexReferencesContext value={referencesContext}>
              <LatexDocumentAuthoring value={authoringContext}>
                <LatexFooterPositionContext value={setObjectPosition}>
                  <LatexMathEditingContext value={activeMath}>
                    <LatexDraftContext value={fieldContext}>
                      <div
                        ref={workspaceRef}
                        className="scient-latex-visual-workspace"
                        onKeyDown={(event) => {
                          if (
                            find.open &&
                            event.key === "Escape" &&
                            !event.defaultPrevented &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            find.close();
                          }
                        }}
                        onFocusCapture={() => props.onEditingChange(true)}
                        onBlurCapture={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget))
                            props.onEditingChange(false);
                        }}
                      >
                        <WritingShortcutsDialog
                          open={shortcutsOpen}
                          onOpenChange={setShortcutsOpen}
                          environmentId={props.environmentId}
                        />
                        <Dialog
                          open={titleHelp !== null}
                          onOpenChange={(open) => {
                            if (!open) setTitleHelp(null);
                          }}
                          onOpenChangeComplete={(open) => {
                            if (!open) {
                              const action = titleHelpAction.current;
                              titleHelpAction.current = null;
                              action?.();
                            }
                          }}
                        >
                          <DialogPopup finalFocus={() => titleHelpAction.current === null}>
                            <DialogTitle>Document title</DialogTitle>
                            <DialogDescription>{titleHelp}</DialogDescription>
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button variant="outline" onClick={() => setTitleHelp(null)}>
                                Cancel
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => {
                                  titleHelpAction.current = () =>
                                    (props.onOpenRoot ?? props.onOpenSource)();
                                  setTitleHelp(null);
                                }}
                              >
                                Open Source
                              </Button>
                              {canAddTitle && (
                                <Button
                                  onClick={() => {
                                    titleHelpAction.current = addTitleBlock;
                                    setTitleHelp(null);
                                  }}
                                >
                                  Add a title
                                </Button>
                              )}
                            </div>
                          </DialogPopup>
                        </Dialog>
                        <div
                          className="scient-latex-writing-toolbar"
                          onMouseDown={(event) => {
                            if (event.target instanceof Element && event.target.closest("button"))
                              event.preventDefault();
                          }}
                        >
                          <DockOverflowRow
                            label="Writing tools"
                            fixed
                            compactLabels
                            commandScope="latex"
                            expanded
                            onExpandedChange={() => {}}
                            groups={[
                              {
                                id: "history",
                                priority: 30,
                                estimatedWidth: 70,
                                bar: writingHistoryTools,
                                overflowLabel: "History",
                                overflow: (
                                  <>
                                    <DockCommandItem
                                      disabled={readOnly || (!mathActive && !editor?.can().undo())}
                                      onClick={undo}
                                    >
                                      <WritingCommandIcon command="undo" />{" "}
                                      {WRITING_COMMAND_LABELS.undo}
                                    </DockCommandItem>
                                    <DockCommandItem
                                      disabled={readOnly || (!mathActive && !editor?.can().redo())}
                                      onClick={redo}
                                    >
                                      <WritingCommandIcon command="redo" />{" "}
                                      {WRITING_COMMAND_LABELS.redo}
                                    </DockCommandItem>
                                  </>
                                ),
                              },
                              {
                                id: "text",
                                priority: 100,
                                estimatedWidth: 62,
                                bar: writingTextTools,
                                overflowLabel: "Text",
                                overflow: <TextMenuItems {...writingTextContents} />,
                              },
                              {
                                id: "insert",
                                priority: 20,
                                estimatedWidth: 48,
                                bar: writingInsertTools,
                                overflowLabel: "Insert",
                                overflow: (
                                  <LatexInsertMenuContent
                                    actions={overflowInsertActions}
                                    onInsertTable={insertTable}
                                    unavailableReason={
                                      readOnly
                                        ? "This document is read-only."
                                        : mathActive
                                          ? "Finish editing math to insert a document element."
                                          : undefined
                                    }
                                  />
                                ),
                              },
                              {
                                id: "math",
                                priority: 90,
                                estimatedWidth: 96,
                                bar: writingMathBar,
                                overflowLabel: "Math",
                                overflow: writingMathItems,
                              },
                              {
                                id: "lists",
                                priority: 40,
                                estimatedWidth: 48,
                                bar: writingListTools,
                                overflowLabel: "Lists",
                                overflow: writingListItems,
                              },
                              {
                                id: "document",
                                priority: 10,
                                estimatedWidth: 44,
                                bar: (
                                  <span className="inline-flex">
                                    <DockMenu
                                      commandScope="latex"
                                      label="Document"
                                      icon={<FileText className="size-4" />}
                                    >
                                      {documentItems}
                                    </DockMenu>
                                  </span>
                                ),
                                overflowLabel: "Document",
                                overflow: documentItems,
                              },
                            ]}
                          />
                        </div>
                        {readerHost ? searchBar : null}
                        <LatexMatrixDialog
                          display={
                            mathMenu?.placement !== "inline-math" && editingTarget === editor
                          }
                          open={mathPicker === "matrix"}
                          environment={matrixEnvironment}
                          onEnvironmentChange={setMatrixEnvironment}
                          onOpenChange={(open) => {
                            if (!open) setMathPicker(null);
                          }}
                          onOpenChangeComplete={mathPickerClosed}
                          onInsert={(tex) => finishMathPicker(tex, true)}
                        />
                        {bibliographyDialog && (
                          <LatexBibliographyDialog
                            open={bibliographyDialog.open}
                            source={props.rootSource ?? props.source}
                            onClose={() => setBibliographyDialog({ open: false })}
                            onCancel={() => {
                              restoreInsertion();
                              setBibliographyDialog(null);
                            }}
                            onInsert={(source) => {
                              if (restoreInsertion()) insertVisualSource(source);
                              setBibliographyDialog(null);
                            }}
                          />
                        )}
                        {linkDialog && (
                          <LatexLinkDialog
                            anchor={linkAnchor}
                            fallbackAnchor={workspaceRef}
                            open={linkDialog.open}
                            text={linkDialog.text}
                            onClose={(restoreFocus) => {
                              if (!restoreFocus) insertionTarget.current = null;
                              setLinkDialog((current) => current && { ...current, open: false });
                            }}
                            onInsert={(text, url) => {
                              pendingLink.current = { text, url };
                              setLinkDialog((current) => current && { ...current, open: false });
                            }}
                            onClosed={() => {
                              const value = pendingLink.current;
                              pendingLink.current = null;
                              if (restoreInsertion() && value && editor) {
                                const argument = value.url.replace(
                                  /[%#&]/gu,
                                  (character) => "\\" + character,
                                );
                                const linkText =
                                  value.text === linkDialog.text && linkDialog.source
                                    ? linkDialog.source
                                    : escapeText(value.text);
                                editor
                                  .chain()
                                  .focus()
                                  .command(({ tr }) => {
                                    closeHistory(tr);
                                    return true;
                                  })
                                  .insertContent({
                                    type: "latexInlineCommand",
                                    attrs: {
                                      name: "href",
                                      argument,
                                      linkText,
                                      raw: `\\href{${argument}}{${linkText}}`,
                                    },
                                  })
                                  .run();
                              }
                              setLinkDialog(null);
                            }}
                          />
                        )}
                        <LatexReferenceDialog
                          open={referenceOpen && !readOnly}
                          onOpenChange={setReferenceOpen}
                          source={props.source}
                          setupSource={props.rootSource ?? props.source}
                          mode={referenceMode}
                          onCancel={() => {
                            restoreInsertion();
                          }}
                          environmentId={props.environmentId}
                          cwd={props.cwd}
                          relativePath={props.rootRelativePath ?? props.relativePath}
                          onInsert={insertReference}
                        />
                        {props.environmentId && props.cwd ? (
                          <LatexFigureInsertDialog
                            open={figureOpen && !readOnly}
                            onOpenChange={setFigureOpen}
                            environmentId={props.environmentId}
                            cwd={props.cwd}
                            relativePath={props.rootRelativePath ?? ""}
                            source={props.source}
                            onCancel={() => {
                              restoreInsertion();
                            }}
                            onInsert={(source) => {
                              if (restoreInsertion()) insertVisualSource(source);
                            }}
                          />
                        ) : null}

                        {(props.sourceError ?? notice) === null ? null : (
                          <div
                            className="scient-latex-visual-notice"
                            role="status"
                            aria-live="polite"
                          >
                            <span>{props.sourceError ?? notice}</span>
                            <Button size="xs" variant="ghost" onClick={props.onOpenSource}>
                              Open Source
                            </Button>
                            {!unsynced && !props.sourceError && (
                              <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>
                                Dismiss
                              </Button>
                            )}
                            {unsynced ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    setNotice(
                                      "Your draft is kept locally and has not replaced the file.",
                                    )
                                  }
                                >
                                  Keep draft
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => {
                                    cancelTyping.current?.();
                                    cancelSourcePublish.current?.();
                                    pendingTyping.current = null;
                                    pendingSourceEdit.current = null;
                                    reportDraft("ordinary-text", false);
                                    reportDraft("source-publication", false);
                                    discardOwnTyping();
                                    currentSource.current = props.source;
                                    installProjection(
                                      projectLatexVisualDocument(
                                        props.source,
                                        0,
                                        props.rootSource ?? props.source,
                                      ),
                                      true,
                                    );
                                    setUnsynced(false);
                                    setNotice(null);
                                  }}
                                >
                                  Discard draft
                                </Button>
                              </>
                            ) : null}
                          </div>
                        )}
                        <div
                          className="scient-latex-visual-body"
                          data-navigation={navigationOpen || undefined}
                          data-references={referencesOpen || undefined}
                        >
                          {navigationOpen ? (
                            <aside
                              className="scient-latex-document-navigation"
                              aria-label="Document navigation"
                            >
                              <div className="scient-latex-navigation-section">
                                <strong>Document</strong>
                                <span>
                                  {props.relativePath?.split(/[\\/]/u).at(-1) ?? "LaTeX document"}
                                </span>
                              </div>
                              <div
                                className="scient-latex-navigation-tabs"
                                role="group"
                                aria-label="Document navigation view"
                              >
                                <button
                                  type="button"
                                  aria-pressed={navigationTab === "pages"}
                                  onClick={() => setNavigationTab("pages")}
                                >
                                  Pages
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={navigationTab === "outline"}
                                  onClick={() => setNavigationTab("outline")}
                                >
                                  Outline
                                </button>
                              </div>
                              {navigationTab === "pages" ? (
                                <LatexPageThumbnails
                                  stage={pageStage}
                                  pageCount={pageCount}
                                  currentPage={currentPage}
                                  width={paperWidth}
                                  height={pageHeight}
                                  gap={pageGap}
                                  onSelect={goToPage}
                                />
                              ) : (
                                <nav aria-label="Document outline">
                                  <div className="scient-latex-navigation-heading">Outline</div>
                                  {outline.length === 0 ? (
                                    <p>Add headings to build an outline.</p>
                                  ) : (
                                    outline.map((heading, index) => (
                                      <button
                                        key={`${heading.position}-${heading.title}`}
                                        onClick={() => {
                                          if (!editor || !commitTyping()) return;
                                          const current = latexNavigationEntries(editor.state.doc)[
                                            index
                                          ];
                                          if (!current) return;
                                          editor
                                            .chain()
                                            .focus()
                                            .setTextSelection(current.position + 1)
                                            .scrollIntoView()
                                            .run();
                                        }}
                                        style={
                                          { "--outline-level": heading.level } as CSSProperties
                                        }
                                        type="button"
                                      >
                                        {heading.title}
                                      </button>
                                    ))
                                  )}
                                </nav>
                              )}
                            </aside>
                          ) : null}
                          <div
                            className="scient-latex-visual-scroll"
                            ref={visualScroll}
                            style={
                              {
                                "--scient-reader-page-inset": `${PDF_FIT_WIDTH_PADDING / 2}px`,
                              } as CSSProperties
                            }
                          >
                            <div
                              className="scient-latex-page-zoom-frame"
                              style={{ width: paperWidth * zoom, height: stageHeight * zoom }}
                            >
                              <div
                                ref={pageStage}
                                className="scient-latex-page-stage"
                                style={
                                  {
                                    ...paperStyle,
                                    transform: `scale(${zoom})`,
                                  } as CSSProperties
                                }
                              >
                                <div
                                  className="scient-latex-visual-paper"
                                  dir={documentLanguage.direction}
                                  lang={
                                    documentLanguage.main === "hebrew"
                                      ? "he"
                                      : documentLanguage.main === "english"
                                        ? "en"
                                        : undefined
                                  }
                                  data-indent-after-heading={layout.indentAfterHeading}
                                  data-document-class={layout.documentClass}
                                  data-title-page={titlePage || undefined}
                                  onDragOver={(event) => {
                                    if (!event.dataTransfer.types.includes("Files")) return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "copy";
                                  }}
                                  onDrop={(event) => {
                                    if (
                                      event.defaultPrevented ||
                                      !event.dataTransfer.types.includes("Files")
                                    )
                                      return;
                                    const view = editor?.view;
                                    if (!view || !view.editable) return;
                                    event.preventDefault();
                                    const position =
                                      view.posAtCoords({ left: event.clientX, top: event.clientY })
                                        ?.pos ?? view.state.doc.content.size;
                                    if (!handleImageTransfer(view, event.dataTransfer, position))
                                      setNotice("Drop a PNG or JPEG image into the document.");
                                  }}
                                >
                                  <div className="scient-latex-page-stack" aria-hidden="true">
                                    {Array.from({ length: pageCount }, (_, index) => (
                                      <div
                                        className="scient-latex-page-sheet"
                                        key={index}
                                        style={{ top: index * (pageHeight + pageGap) }}
                                      >
                                        {runningStyle.style === "fancy" && (
                                          <div
                                            className="scient-latex-running-header"
                                            style={{
                                              top: Math.max(
                                                0,
                                                (layout.marginTopIn -
                                                  runningStyle.headSepIn -
                                                  runningStyle.headHeightIn) *
                                                  CSS_PIXELS_PER_INCH,
                                              ),
                                              height:
                                                runningStyle.headHeightIn * CSS_PIXELS_PER_INCH,
                                              borderBottomWidth:
                                                (runningStyle.headRulePt * CSS_PIXELS_PER_INCH) /
                                                TEX_POINTS_PER_INCH,
                                            }}
                                          >
                                            {runningFields(index + 1).head.map((source, slot) => (
                                              <LatexProsePreview key={slot} source={source} />
                                            ))}
                                          </div>
                                        )}
                                        <div
                                          className="scient-latex-running-footer"
                                          style={{
                                            top:
                                              (layout.paperHeightIn -
                                                layout.marginBottomIn +
                                                runningStyle.footSkipIn) *
                                                CSS_PIXELS_PER_INCH -
                                              (layout.fontSizePt * CSS_PIXELS_PER_INCH) /
                                                TEX_POINTS_PER_INCH,
                                            borderTopWidth:
                                              runningStyle.style === "fancy"
                                                ? (runningStyle.footRulePt * CSS_PIXELS_PER_INCH) /
                                                  TEX_POINTS_PER_INCH
                                                : 0,
                                          }}
                                        >
                                          {runningFields(index + 1).foot.map((source, slot) => (
                                            <LatexProsePreview key={slot} source={source} />
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  <LatexDocumentMathContext value={documentMathSetup.macros}>
                                    <LatexLanguageContext value={documentLanguage.main}>
                                      <EditorContent editor={editor} />
                                    </LatexLanguageContext>
                                  </LatexDocumentMathContext>
                                </div>
                              </div>
                            </div>
                          </div>
                          <LatexReferencesPanel
                            open={referencesOpen}
                            request={referencesRequest}
                            onClose={() => setReferencesOpen(false)}
                            documents={bibliographyDocuments}
                            documentPersistence={props.documentPersistence}
                            setupSource={props.rootSource ?? props.source}
                            rootRelativePath={props.rootRelativePath ?? props.relativePath ?? ""}
                            environmentId={props.environmentId}
                            cwd={props.cwd}
                            disabled={textReadOnly}
                            onSetup={insertBibliography}
                            onDraftChange={referenceDraftChanged}
                            onSaved={() =>
                              editor?.view.dispatch(
                                editor.state.tr.setMeta(latexEquationReferencesKey, true),
                              )
                            }
                            loadDetails={!!selectedCitation}
                            onCatalogChange={setReferenceCatalog}
                            draftKey={props.draftKey}
                            fileCallbacks={props.referenceFiles}
                            canOpenFiles={!!props.onOpenFileSource}
                            onOpenSource={(id, path, offset) => {
                              if (id.startsWith("bib:")) props.onOpenFileSource?.(path);
                              else if (id === "root") (props.onOpenRoot ?? props.onOpenSource)();
                              else if (offset !== undefined && props.onOpenSourceAt)
                                props.onOpenSourceAt(offset);
                              else props.onOpenSource();
                            }}
                          />
                        </div>
                        {readerHost ? null : searchBar}
                        {readerHost ? (
                          <DocumentFooter
                            label="Document status"
                            className="scient-latex-reader-footer"
                            dataRecovery={recovery !== null}
                            position={footerPosition}
                            words={footerWords}
                            leading={
                              <>
                                {recovery === null ? null : (
                                  <LatexVisualRecoveryBar
                                    key={recovery.identity}
                                    recovery={recovery}
                                    currentSource={props.source}
                                    applicable={singleFile}
                                    disabled={props.disabled}
                                    onApply={applyRecovery}
                                    onDiscard={discardRecovery}
                                  />
                                )}
                                {mathPicker === "symbols" && !readOnly && (
                                  <LatexMathPalette
                                    picker
                                    sourceOpen={false}
                                    onOpen={() => {}}
                                    onDismiss={() => {
                                      setMathPicker(null);
                                      mathPickerTarget.current = null;
                                      pendingMathInsert.current = null;
                                    }}
                                    onReturnToMath={() => {
                                      setMathPicker(null);
                                      mathPickerClosed(false);
                                    }}
                                    onInsert={(symbol) => {
                                      finishMathPicker(symbol.latex, false, symbol.action);
                                      mathPickerClosed(false);
                                    }}
                                  />
                                )}
                                {hasLocalDraft ? (
                                  <ScientTooltip content="Editing draft: complete the field to update the LaTeX source.">
                                    <span
                                      className="scient-latex-footer-draft"
                                      aria-label="Editing draft"
                                    >
                                      •
                                    </span>
                                  </ScientTooltip>
                                ) : null}
                                {/* Drawn in the surface header; nothing appears here. */}
                                <DocumentReaderControls
                                  // Hosted in the surface header, the bar leaves the footer to the object options.
                                  {...(readerHost ? {} : { contextControls: contextTools })}
                                  label="Document"
                                  ready={Boolean(editor)}
                                  page={Math.min(currentPage, pageCount)}
                                  pageCount={pageCount}
                                  scale={zoom}
                                  sidebarOpen={navigationOpen}
                                  searchOpen={find.open}
                                  onPage={goToPage}
                                  onZoom={changeZoom}
                                  onActualSize={() => changeZoom(1)}
                                  onFitWidth={fitWidth}
                                  onToggleSidebar={() => setNavigationOpen(!navigationOpen)}
                                  onToggleSearch={() => (find.open ? find.close() : find.show())}
                                  onShowSearch={() => setSearchFocus((request) => request + 1)}
                                  search={headerSearch}
                                  shortcutLabel={shortcutLabel}
                                />
                              </>
                            }
                          >
                            {contextTools}
                          </DocumentFooter>
                        ) : (
                          <footer
                            className="scient-latex-reader-footer"
                            data-recovery={recovery === null ? undefined : ""}
                          >
                            {recovery === null ? null : (
                              <LatexVisualRecoveryBar
                                key={recovery.identity}
                                recovery={recovery}
                                currentSource={props.source}
                                applicable={singleFile}
                                disabled={props.disabled}
                                onApply={applyRecovery}
                                onDiscard={discardRecovery}
                              />
                            )}
                            {mathPicker === "symbols" && !readOnly && (
                              <LatexMathPalette
                                picker
                                sourceOpen={false}
                                onOpen={() => {}}
                                onDismiss={() => {
                                  setMathPicker(null);
                                  mathPickerTarget.current = null;
                                  pendingMathInsert.current = null;
                                }}
                                onReturnToMath={() => {
                                  setMathPicker(null);
                                  mathPickerClosed(false);
                                }}
                                onInsert={(symbol) => {
                                  finishMathPicker(symbol.latex, false, symbol.action);
                                  mathPickerClosed(false);
                                }}
                              />
                            )}
                            {hasLocalDraft ? (
                              <ScientTooltip content="Editing draft: complete the field to update the LaTeX source.">
                                <span
                                  className="scient-latex-footer-draft"
                                  aria-label="Editing draft"
                                >
                                  •
                                </span>
                              </ScientTooltip>
                            ) : null}
                            <DocumentReaderControls
                              // Hosted in the surface header, the bar leaves the footer to the object options.
                              {...(readerHost ? {} : { contextControls: contextTools })}
                              label="Document"
                              ready={Boolean(editor)}
                              page={Math.min(currentPage, pageCount)}
                              pageCount={pageCount}
                              scale={zoom}
                              sidebarOpen={navigationOpen}
                              searchOpen={find.open}
                              onPage={goToPage}
                              onZoom={changeZoom}
                              onActualSize={() => changeZoom(1)}
                              onFitWidth={fitWidth}
                              onToggleSidebar={() => setNavigationOpen(!navigationOpen)}
                              onToggleSearch={() => (find.open ? find.close() : find.show())}
                              onShowSearch={() => setSearchFocus((request) => request + 1)}
                              search={headerSearch}
                              shortcutLabel={shortcutLabel}
                            />
                          </footer>
                        )}
                        <span className="sr-only" role="status">
                          {readOnly ? "Read-only" : selectionContext}
                          {hasLocalDraft ? ". Editing draft" : ""}
                          {shortcutHint ? ". " + shortcutHint : ""}
                        </span>
                      </div>
                    </LatexDraftContext>
                  </LatexMathEditingContext>
                </LatexFooterPositionContext>
              </LatexDocumentAuthoring>
            </LatexReferencesContext>
          </LatexWorkspaceContext>
        </LatexRootContext>
      </LatexBlockSourceContext>
    </LatexCommandContext>
  );
}
