import { attachShortcutHost } from "../keyboard/host";
import { getKeyboardPreferences, subscribeKeyboardPreferences } from "../keyboard/preferences";
import { mathCommand } from "../math/input/catalog";
import { MathfieldElement, type MacroDictionary } from "mathlive";
import {
  mathTextFormatActive,
  mathTextFormattingInput,
  mathTextFormattingSource,
  toggleMathTextFormat,
  type MathTextFormat,
} from "./mathTextFormatting";
import {
  forwardRef,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { LatexDraftContext, restoredLatexFieldDraft } from "./LatexTextField";
import { afterEditorPaint } from "./afterEditorPaint";
import "mathlive/fonts.css";
import { installMathEditingGuides } from "./mathEditingGuides";
import { editableMathMacros, installMathMacroEditing } from "./mathMacroEditing";
import { mathSymbolMacros } from "./mathSymbolPresentation";
import { LatexDocumentMathContext } from "./LatexDocumentMathContext";
import { mathLiveFontDeclarations } from "./mathLiveFontDeclarations";
import { installMathCommandCompletion } from "./mathLiveCommandCompletion";
import { installLatexMathViewport } from "./latexMathViewport";
import { installMathSelectionSession } from "./mathSelectionSession";
import { latexSelectionCommand, runLatexSelectionCommand } from "./latexSelectionSession";
import {
  createMathSelectionGeometry,
  mathArrayContext,
  mathStructureCommandReason,
  type MathArrayContext,
  type MathStructureCommand,
  restoreMathFieldValue,
  clearMathRectangle,
  splitMathRow,
  unwrapEmptyMathCell,
  mathFieldIsEmpty,
  firstMathCell,
  mathCellAtCoordinates,
  mathCellRectangle,
  mathLeftCellBoundary,
  mathRightCellBoundary,
  mathSelectionAtOffset,
  mathSelectionPoint,
  mathSelectionEndpoints,
  mathSelectionWrapReason,
  moveMathSlot,
  mathVerticalTarget,
  resolveMathDragSelection,
  selectMathRectangle,
  type MathCellSelection,
  type MathRectangleSelection,
  type MathSelectionGeometry,
  type MathSelectionPoint,
} from "./mathLiveSelection";

// Vite packages fonts alongside the renderer; no CDN or network math service.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

export interface LatexMathFieldHandle {
  readonly focus: () => void;
  readonly flush: () => boolean;
  readonly isEmpty: () => boolean;
  readonly clearSelection: () => void;
  readonly cancelPointerSelection: () => void;
  readonly insert: (latex: string) => void;
  readonly toggleTextFormat: (format: MathTextFormat) => boolean;
  readonly textFormatActive: (format: MathTextFormat) => boolean;
  readonly command: (
    command:
      | "moveToSuperscript"
      | "moveToSubscript"
      | "addRowAfter"
      | "addColumnAfter"
      | "removeRow"
      | "removeColumn"
      | "undo"
      | "redo",
  ) => boolean;
}

export const LatexMathField = forwardRef<
  LatexMathFieldHandle,
  {
    readonly value: string;
    readonly draftKey?: string;
    readonly disabled: boolean;
    readonly display: boolean;
    readonly editing?: boolean;
    readonly onChange: (value: string) => { readonly accepted: boolean; readonly value: string };
    readonly onFocus: () => void;
    readonly onContextChange?: (context: MathArrayContext | null) => void;
    readonly onFormattingChange?: (state: string) => void;
    readonly structureDisabledReason?: string | null | undefined;
    readonly onExit: (direction: -1 | 1) => void;
    readonly onExtendOutside: (direction: -1 | 1) => boolean;
    readonly onUndo: (redo: boolean) => boolean;
    readonly onRemoveEmpty: (direction: -1 | 1) => boolean | void;
    readonly onShortcut: (command: string) => boolean;
    readonly onShortcutHint: (text: string) => void;
    readonly formatCopiedMath: (tex: string) => string;
    readonly parsePastedMath: (source: string) => string | null;
  }
>(function LatexMathField(
  {
    value,
    draftKey,
    disabled,
    display,
    editing,
    onChange,
    onFocus,
    onContextChange,
    onFormattingChange,
    structureDisabledReason,
    onExit,
    onExtendOutside,
    onUndo,
    onRemoveEmpty,
    onShortcut,
    onShortcutHint,
    formatCopiedMath,
    parsePastedMath,
  },
  forwardedRef,
) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const viewport = useRef<ReturnType<typeof installLatexMathViewport> | null>(null);
  const viewportEditing = useRef(editing);
  useLayoutEffect(() => {
    viewportEditing.current = editing;
    viewport.current?.setEditing(Boolean(display && editing && !disabled));
  }, [display, editing, disabled]);
  const documentMacros = useContext(LatexDocumentMathContext);
  const initialMacros = useRef(documentMacros);
  const currentConfiguration = useRef({ value, display, disabled });
  const baseMacros = useRef<MacroDictionary>({});
  const appliedMacroSignature = useRef("");
  const displayMode = useRef(display);
  useLayoutEffect(() => {
    initialMacros.current = documentMacros;
    currentConfiguration.current = { value, display, disabled };
    displayMode.current = display;
  }, [documentMacros, value, display, disabled]);
  const flush = useRef<() => boolean>(() => true);
  const clearSelection = useRef<() => void>(() => {});
  const cancelPointerSelection = useRef<() => void>(() => {});
  const lastAcknowledged = useRef(value);
  const dirty = useRef(false);
  const journalKey = useRef(draftKey);
  const { reportDraft } = useContext(LatexDraftContext);
  const draftId = useId();
  const change = useRef(onChange);
  const focus = useRef(onFocus);
  const contextChange = useRef(onContextChange);
  const formatChange = useRef(onFormattingChange);
  const refreshFormatting = useRef<() => void>(() => {});
  const structureRestriction = useRef(structureDisabledReason);
  const exit = useRef(onExit);
  const extendOutside = useRef(onExtendOutside);
  const undo = useRef(onUndo);
  const removeEmpty = useRef(onRemoveEmpty);
  const shortcut = useRef(onShortcut);
  const shortcutHint = useRef(onShortcutHint);
  const copyFormat = useRef(formatCopiedMath);
  const parseMathClipboard = useRef(parsePastedMath);
  useLayoutEffect(() => {
    change.current = onChange;
    focus.current = onFocus;
    contextChange.current = onContextChange;
    formatChange.current = onFormattingChange;
    structureRestriction.current = structureDisabledReason;
    exit.current = onExit;
    extendOutside.current = onExtendOutside;
    undo.current = onUndo;
    removeEmpty.current = onRemoveEmpty;
    shortcut.current = onShortcut;
    shortcutHint.current = onShortcutHint;
    copyFormat.current = formatCopiedMath;
    parseMathClipboard.current = parsePastedMath;
  }, [
    onChange,
    onFocus,
    onContextChange,
    onFormattingChange,
    structureDisabledReason,
    onExit,
    onExtendOutside,
    onUndo,
    onRemoveEmpty,
    onShortcut,
    onShortcutHint,
    formatCopiedMath,
    parsePastedMath,
  ]);
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => field.current?.focus(),
      flush: () => flush.current(),
      isEmpty: () => Boolean(field.current && mathFieldIsEmpty(field.current)),
      clearSelection: () => clearSelection.current(),
      cancelPointerSelection: () => cancelPointerSelection.current(),
      toggleTextFormat: (format) => {
        const math = field.current;
        if (!math || math.readOnly || math.mode === "latex") return false;
        toggleMathTextFormat(math, format);
        refreshFormatting.current();
        math.focus();
        return flush.current();
      },
      textFormatActive: (format) => {
        const math = field.current;
        return Boolean(math && math.mode !== "latex" && mathTextFormatActive(math, format));
      },
      command: (command) => {
        const math = field.current;
        if (!math || math.readOnly) return false;
        if (["addRowAfter", "removeRow", "addColumnAfter", "removeColumn"].includes(command)) {
          const reason =
            structureRestriction.current ??
            mathStructureCommandReason(mathArrayContext(math), command as MathStructureCommand);
          if (reason) {
            shortcutHint.current(reason);
            return false;
          }
        }
        math.focus();
        if ((command === "undo" || command === "redo") && undo.current(command === "redo"))
          return true;
        return math.executeCommand(command);
      },
      insert: (latex) => {
        const math = field.current;
        if (!math || math.readOnly) return;
        const reason = latex.includes("#0") ? mathSelectionWrapReason(math) : null;
        if (reason) {
          shortcutHint.current(reason);
          return;
        }
        math.insert(
          mathLiveFontDeclarations(mathTextFormattingInput(latex, initialMacros.current)),
          {
            focus: true,
            format: "latex",
            insertionMode: "replaceSelection",
            selectionMode: "placeholder",
          },
        );
      },
    }),
    [],
  );
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let frame = 0;
    let dispose: (() => void) | undefined;
    const initialize = () => {
      const math = new MathfieldElement();
      math.id = `scient-latex-math-${draftId}`;
      host.current?.append(math);
      const mathViewport = installLatexMathViewport(math, container);
      viewport.current = mathViewport;
      mathViewport.setEditing(
        Boolean(
          currentConfiguration.current.display &&
          viewportEditing.current &&
          !currentConfiguration.current.disabled,
        ),
      );
      const commandCompletion = installMathCommandCompletion(math, (command) =>
        Object.hasOwn(initialMacros.current, command.slice(1)),
      );
      const removeEditingGuides = installMathEditingGuides(math);
      const macroEditing = installMathMacroEditing(math);
      // Use native caret placement and command completion inside the formula.
      // Scient supplies the surrounding toolbar instead of a second menu/keyboard.
      // MathLive's option setters require the custom element to be connected.
      math.readOnly = currentConfiguration.current.disabled;
      math.defaultMode = currentConfiguration.current.display ? "math" : "inline-math";
      math.setAttribute(
        "aria-label",
        currentConfiguration.current.display ? "Display equation" : "Inline equation",
      );
      math.mathVirtualKeyboardPolicy = "manual";
      math.popoverPolicy = "auto";
      math.environmentPopoverPolicy = "off";
      math.menuItems = [];
      let formattingState = "";
      refreshFormatting.current = () => {
        const next =
          math.mode === "latex"
            ? "latex"
            : (["bold", "italic", "monospace"] as const)
                .map((format) => Number(mathTextFormatActive(math, format)))
                .join("");
        if (next === formattingState) return;
        formattingState = next;
        formatChange.current?.(next);
      };
      baseMacros.current = { ...math.macros, ...mathSymbolMacros() };
      math.macros = { ...baseMacros.current, ...editableMathMacros(initialMacros.current) };
      appliedMacroSignature.current = JSON.stringify(initialMacros.current);
      lastAcknowledged.current = currentConfiguration.current.value;
      const recovered = restoredLatexFieldDraft(journalKey.current, lastAcknowledged.current);
      math.setValue(
        mathLiveFontDeclarations(mathTextFormattingInput(recovered, initialMacros.current)),
        {
          silenceNotifications: true,
        },
      );
      macroEditing.refresh();
      const firstCell = firstMathCell(math);
      if (firstCell) math.position = firstCell.cell[0];
      dirty.current = recovered !== lastAcknowledged.current;
      reportDraft(draftId, dirty.current);
      math.smartFence = true;
      math.smartSuperscript = true;
      // Plain typing stays literal. Commands start with a backslash; macros
      // come from the document, and keyboard actions from explicit bindings.
      math.inlineShortcuts = {};
      const applyPreferences = () => {
        const preferences = getKeyboardPreferences().preferences;
        math.popoverPolicy = preferences.completion === "off" ? "off" : "auto";
        commandCompletion.refresh();
      };
      applyPreferences();
      const unsubscribe = subscribeKeyboardPreferences(applyPreferences);
      const detachShortcuts = attachShortcutHost(host.current!, ["math", "latex"], {
        capture: true,
        feedback: (text) => shortcutHint.current(text),
        accepts: (_event, id) =>
          !math.readOnly &&
          math.mode !== "latex" &&
          (!id?.startsWith("latex.") ||
            Boolean(id && latexSelectionCommand(id)) ||
            ["latex.bold", "latex.italic", "latex.inlineCode"].includes(id)),
        execute: (id) => {
          const selectionCommand = latexSelectionCommand(id);
          if (selectionCommand) return runLatexSelectionCommand(math, selectionCommand);
          const textFormat =
            id === "latex.bold"
              ? "bold"
              : id === "latex.italic"
                ? "italic"
                : id === "latex.inlineCode"
                  ? "monospace"
                  : null;
          if (textFormat) {
            toggleMathTextFormat(math, textFormat);
            refreshFormatting.current();
            math.focus();
            return flush.current();
          }
          if (id === "math.inline" || id === "math.display" || id === "math.palette")
            return shortcut.current(id);
          if (id === "math.superscript") return math.executeCommand("moveToSuperscript");
          if (id === "math.subscript") return math.executeCommand("moveToSubscript");
          const matrixActions = {
            "math.matrix.addRow": "addRowAfter",
            "math.matrix.deleteRow": "removeRow",
            "math.matrix.addColumn": "addColumnAfter",
            "math.matrix.deleteColumn": "removeColumn",
          } as const;
          const matrixAction = matrixActions[id as keyof typeof matrixActions];
          if (matrixAction) return math.executeCommand(matrixAction);
          const custom = getKeyboardPreferences().preferences.customMath?.find(
            (entry) => entry.id === id,
          );
          if (custom) {
            math.insert(
              custom.latex.replaceAll("${selection}", "#0").replaceAll("${cursor}", "#?"),
              {
                format: "latex",
                insertionMode: "replaceSelection",
                selectionMode: "placeholder",
                focus: true,
              },
            );
            return true;
          }
          const command = mathCommand(id);
          if (!command) return false;
          math.insert(
            command.template
              .replaceAll("@", math.selectionIsCollapsed ? "#?" : "#0")
              .replaceAll("|", "#?"),
            {
              format: "latex",
              insertionMode: "replaceSelection",
              selectionMode: "placeholder",
              focus: true,
            },
          );
          return true;
        },
      });
      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelPublish: (() => void) | undefined;
      const journal = () => {
        if (!journalKey.current) return;
        try {
          const key = `scient.latex.field:${journalKey.current}`;
          if (dirty.current)
            localStorage.setItem(
              key,
              JSON.stringify({ base: lastAcknowledged.current, text: math.getValue("latex") }),
            );
          else localStorage.removeItem(key);
        } catch {
          /* Keep the live draft when recovery storage is unavailable. */
        }
      };
      const publish = () => {
        cancelPublish?.();
        cancelPublish = undefined;
        clearTimeout(publishTimer);
        publishTimer = undefined;
        if (!dirty.current) return true;
        // A command under construction (including its ghost suggestion) is a
        // local draft. Publish only after MathLive turns it into math atoms.
        if (math.mode === "latex" || field.current !== math) {
          journal();
          return false;
        }
        // Editable slots belong to MathLive, not to the compiled LaTeX source.
        // Keep the live field intact when the parent acknowledges this projection.
        const source = mathTextFormattingSource(
          math.getValue("latex-without-placeholders"),
          Boolean(initialMacros.current.mathbfit),
        );
        const previousAcknowledged = lastAcknowledged.current;
        const result = change.current(source);
        lastAcknowledged.current = result.value;
        dirty.current = !result.accepted;
        if (result.accepted && result.value !== previousAcknowledged) math.resetUndo();
        journal();
        reportDraft(draftId, dirty.current);
        // A rejected, unfinished formula stays editable. Replacing the live field
        // here discards keystrokes and sends its caret back to the beginning.
        return result.accepted;
      };
      flush.current = publish;
      const revealCaret = () => mathViewport.revealCaret();
      const input = () => {
        verticalIntent = null;
        refreshFormatting.current();
        revealCaret();
        dirty.current = true;
        reportDraft(draftId, true);
        clearTimeout(publishTimer);
        cancelPublish?.();
        publishTimer = setTimeout(() => {
          cancelPublish = afterEditorPaint(publish);
        }, 180);
      };
      const contextMenu = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      let previousMode = math.mode;
      const modeChange = () => {
        const completedCommand = previousMode === "latex" && math.mode !== "latex";
        previousMode = math.mode;
        // Completion changes mode before inserting its atoms. Moving the caret
        // between math and text slots changes mode without editing the source.
        if (completedCommand) queueMicrotask(input);
      };
      const focused = () => {
        if (!math.readOnly) {
          mathViewport.setEditing(currentConfiguration.current.display);
          revealCaret();
          focus.current();
          refreshFormatting.current();
          contextChange.current?.(mathArrayContext(math));
        }
      };
      const blurred = () => {
        if (viewportEditing.current === undefined) mathViewport.setEditing(false);
        if (math.readOnly) return;
        // Preserve what was actually typed when leaving an unfinished command;
        // never accept a ghost suggestion just because focus moved elsewhere.
        if (math.mode === "latex") {
          if (!commandCompletion.completeTyped()) math.executeCommand("complete");
          publish();
        } else publish();
      };
      let rectangle: MathRectangleSelection | null = null;
      let applyingSelection = false;
      const selectionSession = installMathSelectionSession(math, {
        rectangle: () => rectangle,
        apply: (selection, selectedCells) => {
          applyingSelection = true;
          rectangle = selectedCells;
          if (selectedCells) selectMathRectangle(math, selectedCells);
          else math.selection = selection;
          applyingSelection = false;
        },
        exit: (direction) => {
          if (publish()) exit.current(direction);
        },
      });
      clearSelection.current = () => {
        if (math.selectionIsCollapsed && !rectangle) return;
        rectangle = null;
        applyingSelection = true;
        math.selection = { ranges: [[math.position, math.position]] };
        applyingSelection = false;
      };
      const selectEnvironment = (
        environment: MathCellSelection["environment"],
        direction: "forward" | "backward" = "forward",
      ) => {
        rectangle = null;
        applyingSelection = true;
        math.selection = { ranges: [[...environment]], direction };
        applyingSelection = false;
      };
      const collapseRectangle = () => {
        if (!rectangle) return;
        const focusCell = rectangle.focus.cell;
        rectangle = null;
        applyingSelection = true;
        math.position = focusCell[1];
        applyingSelection = false;
      };
      let pointerSelection: {
        id: number;
        anchor: MathSelectionPoint;
        geometry: MathSelectionGeometry;
        active: boolean;
      } | null = null;
      let pointerResult: MathfieldElement["selection"] | null = null;
      const selectionChanged = () => {
        refreshFormatting.current();
        revealCaret();
        contextChange.current?.(mathArrayContext(math));
        if (applyingSelection || pointerSelection) return;
        const endpoints = mathSelectionEndpoints(math);
        if (!endpoints || math.selectionIsCollapsed) {
          rectangle = null;
          return;
        }
        const anchor = mathSelectionAtOffset(math, endpoints[0]);
        const head = mathSelectionAtOffset(math, endpoints[1]);
        const selection = resolveMathDragSelection(
          math,
          anchor,
          head,
          endpoints[0] <= endpoints[1] ? "forward" : "backward",
        );
        applyingSelection = true;
        if (selection.kind === "rectangle") {
          rectangle = selection.rectangle;
          selectMathRectangle(math, selection.rectangle);
        } else {
          rectangle = null;
          const current = math.selection.ranges[0];
          if (current?.[0] !== selection.range[0] || current?.[1] !== selection.range[1])
            math.selection = { ranges: [[...selection.range]], direction: selection.direction };
        }
        applyingSelection = false;
      };
      let extendingVertically = false;
      let verticalIntent: number | null = null;
      const keydown = (event: KeyboardEvent) => {
        if (math.readOnly || event.isComposing || event.defaultPrevented) return;
        if (commandCompletion.handleKeyDown(event)) return;
        const modifier = event.ctrlKey || event.metaKey;
        if (
          (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
          modifier ||
          event.altKey ||
          event.shiftKey
        )
          verticalIntent = null;
        if (modifier && !event.altKey) {
          const key = event.key.toLowerCase();
          const redo = key === "y" || (key === "z" && event.shiftKey);
          if ((key === "z" || key === "y") && undo.current(redo)) {
            rectangle = null;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        if (event.key === "Enter" && modifier && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          const reason = structureRestriction.current ?? splitMathRow(math);
          if (reason) shortcutHint.current(reason);
          else {
            rectangle = null;
            verticalIntent = null;
            refreshFormatting.current();
            revealCaret();
            contextChange.current?.(mathArrayContext(math));
          }
          return;
        }
        if (math.mode === "latex") {
          if (
            event.key === "Tab" &&
            !event.shiftKey &&
            getKeyboardPreferences().preferences.completion !== "off"
          ) {
            event.preventDefault();
            event.stopPropagation();
            math.executeCommand(["complete", "accept-all"]);
          }
          // Enter accepts a command and arrows select suggestions. They must
          // reach MathLive before any document-level navigation can take over.
          return;
        }
        if (event.key === "Tab" && !modifier && !event.altKey) {
          rectangle = null;
          event.preventDefault();
          event.stopPropagation();
          if (!moveMathSlot(math, event.shiftKey ? -1 : 1) && publish())
            exit.current(event.shiftKey ? -1 : 1);
          return;
        }
        if (
          !modifier &&
          !event.altKey &&
          !event.shiftKey &&
          math.selectionIsCollapsed &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          const target = mathVerticalTarget(math, event.key === "ArrowUp" ? -1 : 1, verticalIntent);
          if (target) {
            verticalIntent = target.intent;
            event.preventDefault();
            event.stopPropagation();
            math.position = target.position;
            return;
          }
        }
        if (!modifier && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
          const selectedCells = rectangle;
          applyingSelection = true;
          const handled = selectedCells
            ? clearMathRectangle(math, selectedCells)
            : unwrapEmptyMathCell(math);
          applyingSelection = false;
          if (handled) {
            rectangle = null;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        if (
          displayMode.current &&
          !event.shiftKey &&
          !modifier &&
          !event.altKey &&
          math.position === math.lastOffset &&
          (event.key === "ArrowRight" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (publish()) exit.current(1);
          return;
        }
        if (
          rectangle &&
          event.shiftKey &&
          !modifier &&
          !event.altKey &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        ) {
          const current = rectangle;
          const row =
            current.focus.row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0);
          const column =
            current.focus.column +
            (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0);
          const nextCell = mathCellAtCoordinates(math, current.anchor, row, column);
          if (nextCell) {
            const next = mathCellRectangle(math, current.anchor, nextCell);
            if (next) {
              rectangle = next;
              applyingSelection = true;
              selectMathRectangle(math, next);
              applyingSelection = false;
            }
          } else if (event.key === "ArrowLeft" && current.focus.column === 0) {
            selectEnvironment(current.anchor.environment, "backward");
          } else if (
            event.key === "ArrowRight" &&
            current.focus.column === (current.focus.array.colCount ?? 0) - 1
          ) {
            selectEnvironment(current.anchor.environment, "forward");
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const horizontalDirection = event.key === "ArrowLeft" ? -1 : 1;
        const cellBoundary =
          !modifier && !event.altKey
            ? event.key === "ArrowLeft"
              ? mathLeftCellBoundary(math, math.position)
              : event.key === "ArrowRight"
                ? mathRightCellBoundary(math, math.position)
                : null
            : null;
        const selectionAnchor = cellBoundary ? mathSelectionEndpoints(math)?.[0] : undefined;
        const anchorInsideBoundary =
          cellBoundary && selectionAnchor !== undefined
            ? mathSelectionAtOffset(math, selectionAnchor).path.some(
                (cell) => cell.array === cellBoundary.array,
              )
            : false;
        if (
          cellBoundary &&
          (math.selectionIsCollapsed || (event.shiftKey && anchorInsideBoundary))
        ) {
          event.preventDefault();
          event.stopPropagation();
          rectangle = null;
          applyingSelection = true;
          if (event.shiftKey)
            math.selection = {
              ranges: [[...cellBoundary.environment]],
              direction: horizontalDirection === -1 ? "backward" : "forward",
            };
          else math.position = cellBoundary.environment[horizontalDirection === -1 ? 0 : 1];
          applyingSelection = false;
          return;
        }
        if (
          rectangle &&
          !event.shiftKey &&
          !modifier &&
          !event.altKey &&
          (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")
        )
          collapseRectangle();
        if (
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          extendingVertically = true;
          queueMicrotask(() => {
            extendingVertically = false;
          });
        }
        if (
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          ((event.key === "ArrowLeft" && math.position === 0) ||
            (event.key === "ArrowRight" && math.position === math.lastOffset)) &&
          extendOutside.current(event.key === "ArrowLeft" ? -1 : 1)
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          event.key === "Enter" &&
          event.shiftKey &&
          getKeyboardPreferences().preferences.matrixEnter
        ) {
          const reason =
            structureRestriction.current ??
            mathStructureCommandReason(mathArrayContext(math), "addRowAfter");
          if (reason) {
            shortcutHint.current(reason);
            event.preventDefault();
            event.stopPropagation();
          } else if (math.executeCommand("addRowAfter")) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        if (
          !modifier &&
          !event.altKey &&
          !event.shiftKey &&
          (event.key === "Backspace" || event.key === "Delete") &&
          mathFieldIsEmpty(math)
        ) {
          event.preventDefault();
          event.stopPropagation();
          // Removing the object is explicit even when its unfinished empty
          // structure cannot be published as a standalone equation.
          publish();
          if (removeEmpty.current(event.key === "Backspace" ? -1 : 1) !== false) {
            cancelPublish?.();
            cancelPublish = undefined;
            clearTimeout(publishTimer);
            dirty.current = false;
            reportDraft(draftId, false);
            journal();
          }
          return;
        }
        if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          if (publish()) exit.current(1);
        }
      };
      const moveOut = (event: HTMLElementEventMap["move-out"]) => {
        if (math.readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        if (extendingVertically) return;
        if (publish())
          exit.current(
            event.detail.direction === "backward" || event.detail.direction === "upward" ? -1 : 1,
          );
      };
      let lastTap: { x: number; y: number; time: number; count: number } | null = null;
      let lastEnvironment: MathCellSelection["environment"] | null = null;
      const pointCell = (x: number, y: number) => {
        const point = mathSelectionPoint(math, x, y);
        return point.path.at(-1) ?? null;
      };
      const pointerMove = (event: PointerEvent) => {
        const drag = pointerSelection;
        if (!drag || drag.id !== event.pointerId || !(event.buttons & 1)) return;
        const fieldBounds = math.getBoundingClientRect();
        if (
          event.clientX < fieldBounds.left ||
          event.clientX > fieldBounds.right ||
          event.clientY < fieldBounds.top ||
          event.clientY > fieldBounds.bottom
        )
          return;
        if (
          !drag.active &&
          Math.hypot(event.clientX - drag.anchor.x, event.clientY - drag.anchor.y) < 2
        )
          return;
        const head = mathSelectionPoint(
          math,
          event.clientX,
          event.clientY,
          undefined,
          drag.geometry,
        );
        const selection = resolveMathDragSelection(
          math,
          drag.anchor,
          head,
          undefined,
          drag.geometry,
        );
        applyingSelection = true;
        if (selection.kind === "rectangle") {
          rectangle = selection.rectangle;
          selectMathRectangle(math, selection.rectangle);
        } else {
          rectangle = null;
          math.selection = { ranges: [[...selection.range]], direction: selection.direction };
        }
        applyingSelection = false;
        drag.active = true;
        pointerResult = {
          ranges: math.selection.ranges.map(([from, to]): [number, number] => [from, to]),
          ...(math.selection.direction === undefined
            ? {}
            : { direction: math.selection.direction }),
        };
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const stopPointerSelection = (event?: PointerEvent) => {
        if (event && pointerSelection?.id !== event.pointerId) return;
        const completed = event?.type === "pointerup" && pointerSelection?.active;
        const result = pointerResult;
        const cells = rectangle;
        pointerSelection = null;
        pointerResult = null;
        document.removeEventListener("pointermove", pointerMove, true);
        document.removeEventListener("pointerup", stopPointerSelection, true);
        document.removeEventListener("pointercancel", stopPointerSelection, true);
        if (completed && result)
          queueMicrotask(() => {
            if (!math.isConnected || !math.matches(":focus-within")) return;
            applyingSelection = true;
            if (cells) selectMathRectangle(math, cells);
            else math.selection = result;
            applyingSelection = false;
          });
      };
      cancelPointerSelection.current = () => stopPointerSelection();
      const pointerDown = (event: PointerEvent) => {
        verticalIntent = null;
        if (math.readOnly || event.button !== 0) return;
        stopPointerSelection();
        const now = performance.now();
        const previousTap = lastTap;
        const repeated =
          previousTap !== null &&
          now - previousTap.time < 500 &&
          Math.abs(event.clientX - previousTap.x) < 5 &&
          Math.abs(event.clientY - previousTap.y) < 5;
        const tapCount = Math.max(
          event.detail,
          repeated && previousTap ? previousTap.count + 1 : 1,
        );
        lastTap = { x: event.clientX, y: event.clientY, time: now, count: tapCount };
        if (!repeated && tapCount < 2) lastEnvironment = null;
        if (tapCount < 2) {
          const geometry = createMathSelectionGeometry(math);
          const anchor = mathSelectionPoint(
            math,
            event.clientX,
            event.clientY,
            undefined,
            geometry,
          );
          rectangle = null;
          applyingSelection = true;
          math.position = anchor.offset;
          applyingSelection = false;
          pointerSelection = {
            id: event.pointerId,
            anchor,
            geometry,
            active: false,
          };
          document.addEventListener("pointermove", pointerMove, true);
          document.addEventListener("pointerup", stopPointerSelection, true);
          document.addEventListener("pointercancel", stopPointerSelection, true);
          return;
        }
        const cell = pointCell(event.clientX, event.clientY);
        const environment = repeated ? (lastEnvironment ?? cell?.environment) : cell?.environment;
        if (tapCount >= 3 && environment) {
          event.preventDefault();
          event.stopImmediatePropagation();
          selectEnvironment(environment);
        } else if (tapCount === 2 && cell) {
          event.preventDefault();
          event.stopImmediatePropagation();
          lastEnvironment = cell.environment;
          rectangle = null;
          math.focus();
          math.selection = { ranges: [[...cell.cell]] };
        }
      };
      const copied = (event: ClipboardEvent) => {
        if (!event.clipboardData) return;
        const tex =
          rectangle?.source ??
          (math.selectionIsCollapsed
            ? math.getValue("latex-without-placeholders")
            : math.getValue(math.selection, "latex-without-placeholders"));
        const source = copyFormat.current(
          mathTextFormattingSource(tex, Boolean(initialMacros.current.mathbfit)),
        );
        event.clipboardData.setData("text/plain", source);
        event.clipboardData.setData("application/x-latex", source);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const cut = (event: ClipboardEvent) => {
        if (!rectangle || math.readOnly || !event.clipboardData) return;
        copied(event);
        applyingSelection = true;
        if (clearMathRectangle(math, rectangle)) rectangle = null;
        applyingSelection = false;
      };
      const pasted = (event: ClipboardEvent) => {
        collapseRectangle();
        const source = (
          event.clipboardData?.getData("text/plain") ||
          event.clipboardData?.getData("application/x-latex")
        )?.trim();
        if (!source || math.readOnly) return;
        // The editor supplies the parser for its own math wrappers. Regular
        // unwrapped input remains MathLive's native paste behavior.
        const parsed = parseMathClipboard.current(source);
        if (parsed === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        math.insert(
          mathLiveFontDeclarations(mathTextFormattingInput(parsed, initialMacros.current)),
          {
            format: "latex",
            insertionMode: "replaceSelection",
            selectionMode: "after",
            focus: true,
          },
        );
      };
      math.addEventListener("input", input);
      math.addEventListener("contextmenu", contextMenu, true);
      math.addEventListener("mode-change", modeChange);
      math.addEventListener("focus", focused);
      math.addEventListener("blur", blurred);
      math.addEventListener("keydown", keydown, true);
      math.addEventListener("move-out", moveOut);
      math.addEventListener("selection-change", selectionChanged);
      math.addEventListener("pointerdown", pointerDown, true);
      math.addEventListener("copy", copied, true);
      math.addEventListener("cut", cut, true);
      math.addEventListener("paste", pasted, true);
      const resetVerticalIntent = () => {
        verticalIntent = null;
      };
      document.addEventListener("pointerdown", resetVerticalIntent, true);
      window.addEventListener("resize", resetVerticalIntent);
      window.addEventListener("pagehide", publish);
      field.current = math;
      return () => {
        selectionSession.dispose();
        document.removeEventListener("pointerdown", resetVerticalIntent, true);
        window.removeEventListener("resize", resetVerticalIntent);
        commandCompletion.dispose();
        removeEditingGuides();
        stopPointerSelection();
        cancelPointerSelection.current = () => {};
        clearTimeout(publishTimer);
        cancelPublish?.();
        mathViewport.dispose();
        viewport.current = null;
        journal();
        macroEditing.dispose();
        reportDraft(draftId, false);
        flush.current = () => true;
        clearSelection.current = () => {};
        refreshFormatting.current = () => {};
        detachShortcuts();
        unsubscribe();
        math.removeEventListener("input", input);
        math.removeEventListener("contextmenu", contextMenu, true);
        math.removeEventListener("mode-change", modeChange);
        math.removeEventListener("focus", focused);
        math.removeEventListener("blur", blurred);
        math.removeEventListener("keydown", keydown, true);
        math.removeEventListener("move-out", moveOut);
        math.removeEventListener("selection-change", selectionChanged);
        math.removeEventListener("pointerdown", pointerDown, true);
        math.removeEventListener("copy", copied, true);
        math.removeEventListener("cut", cut, true);
        math.removeEventListener("paste", pasted, true);
        window.removeEventListener("pagehide", publish);
        math.remove();
        field.current = null;
      };
    };
    const connect = () => {
      // React node-view portals can reconnect before their DOM is attached.
      // MathLive initializes its model in connectedCallback; its getters throw earlier.
      if (!container.isConnected) {
        frame = requestAnimationFrame(connect);
        return;
      }
      dispose = initialize();
    };
    connect();
    return () => {
      cancelAnimationFrame(frame);
      dispose?.();
    };
  }, [draftId, reportDraft]);
  useEffect(() => {
    const math = field.current;
    if (!math) return;
    const signature = JSON.stringify(documentMacros);
    const apply = () => {
      if (math.mode === "latex" || signature === appliedMacroSignature.current) return;
      // MathLive reparses silently and preserves the command spelling and selection.
      // Start from built-ins each time so removed document definitions do not linger.
      math.macros = { ...baseMacros.current, ...editableMathMacros(documentMacros) };
      appliedMacroSignature.current = signature;
    };
    apply();
    math.addEventListener("mode-change", apply);
    return () => math.removeEventListener("mode-change", apply);
  }, [documentMacros, draftId, reportDraft]);
  useEffect(() => {
    if (!field.current) return;
    field.current.setAttribute("aria-label", display ? "Display equation" : "Inline equation");
    field.current.defaultMode = display ? "math" : "inline-math";
  }, [display]);
  useEffect(() => {
    if (!field.current) return;
    if (field.current.readOnly !== disabled) field.current.readOnly = disabled;
    if (
      lastAcknowledged.current !== value &&
      field.current.getValue("latex-without-placeholders") !== value
    ) {
      const selection = field.current.selection;
      cancelPointerSelection.current();
      clearSelection.current();
      restoreMathFieldValue(
        field.current,
        mathLiveFontDeclarations(mathTextFormattingInput(value, initialMacros.current)),
      );
      field.current.resetUndo();
      const end = field.current.lastOffset;
      field.current.selection = {
        ...selection,
        ranges: selection.ranges.map(([from, to]) => [Math.min(from, end), Math.min(to, end)]),
      };
      dirty.current = false;
      reportDraft(draftId, false);
    }
    lastAcknowledged.current = value;
  }, [disabled, value, reportDraft, draftId]);
  return <span ref={host} className="scient-latex-mathfield" contentEditable={false} />;
});
