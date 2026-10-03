import { attachShortcutHost } from "../keyboard/host";
import { getKeyboardPreferences, subscribeKeyboardPreferences } from "../keyboard/preferences";
import { mathCommand } from "../math/input/catalog";
import { MathfieldElement, type MacroDictionary } from "mathlive";
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
import { mathSymbolMacros } from "./mathSymbolPresentation";
import { LatexDocumentMathContext } from "./LatexDocumentMathContext";
import { mathLiveFontDeclarations } from "./mathLiveFontDeclarations";
import {
  createMathSelectionGeometry,
  restoreMathFieldValue,
  clearMathRectangle,
  unwrapEmptyMathCell,
  firstMathCell,
  mathCellAtCoordinates,
  mathCellRectangle,
  mathLeftCellBoundary,
  mathRightCellBoundary,
  mathSelectionAtOffset,
  mathSelectionPoint,
  mathSelectionEndpoints,
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
  readonly clearSelection: () => void;
  readonly cancelPointerSelection: () => void;
  readonly insert: (latex: string) => void;
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

const INLINE_SHORTCUTS = {
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  theta: "\\theta",
  lambda: "\\lambda",
  mu: "\\mu",
  pi: "\\pi",
  sigma: "\\sigma",
  phi: "\\phi",
  omega: "\\omega",
  inf: "\\infty",
  sqrt: "\\sqrt{#0}",
  sum: "\\sum_{#0}^{#1}",
  prod: "\\prod_{#0}^{#1}",
  int: "\\int_{#0}^{#1}",
  lim: "\\lim_{#0 \\to #1}",
  "->": "\\to",
  "<=": "\\le",
  ">=": "\\ge",
  "!=": "\\ne",
} as const;

export const LatexMathField = forwardRef<
  LatexMathFieldHandle,
  {
    readonly value: string;
    readonly draftKey?: string;
    readonly disabled: boolean;
    readonly display: boolean;
    readonly onChange: (value: string) => { readonly accepted: boolean; readonly value: string };
    readonly onFocus: () => void;
    readonly onExit: (direction: -1 | 1) => void;
    readonly onExtendOutside: (direction: -1 | 1) => boolean;
    readonly onUndo: (redo: boolean) => boolean;
    readonly onRemoveEmpty: () => void;
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
    onChange,
    onFocus,
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
      clearSelection: () => clearSelection.current(),
      cancelPointerSelection: () => cancelPointerSelection.current(),
      command: (command) => {
        const math = field.current;
        if (!math || math.readOnly) return false;
        if (["addRowAfter", "removeRow", "addColumnAfter", "removeColumn"].includes(command)) {
          const cell = mathSelectionAtOffset(math, math.position).path.at(-1);
          if (!cell) return false;
          const column = command.includes("Column");
          if (column && ["cases", "aligned", "gathered"].includes(cell.array.environmentName ?? ""))
            return false;
          if (command === "removeRow" && (cell.array.rowCount ?? 0) <= 1) return false;
          if (command === "removeColumn" && (cell.array.colCount ?? 0) <= 1) return false;
          if (command === "addRowAfter" && (cell.array.rowCount ?? 0) >= 20) return false;
          if (command === "addColumnAfter" && (cell.array.colCount ?? 0) >= 20) return false;
        }
        math.focus();
        if ((command === "undo" || command === "redo") && undo.current(command === "redo"))
          return true;
        return math.executeCommand(command);
      },
      insert: (latex) => {
        const math = field.current;
        if (!math || math.readOnly) return;
        math.insert(mathLiveFontDeclarations(latex), {
          focus: true,
          format: "latex",
          insertionMode: "replaceSelection",
          selectionMode: "placeholder",
        });
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
      host.current?.append(math);
      const removeEditingGuides = installMathEditingGuides(math);
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
      baseMacros.current = { ...math.macros, ...mathSymbolMacros() };
      math.macros = { ...baseMacros.current, ...initialMacros.current };
      appliedMacroSignature.current = JSON.stringify(initialMacros.current);
      lastAcknowledged.current = currentConfiguration.current.value;
      const recovered = restoredLatexFieldDraft(journalKey.current, lastAcknowledged.current);
      math.setValue(mathLiveFontDeclarations(recovered), { silenceNotifications: true });
      const firstCell = firstMathCell(math);
      if (firstCell) math.position = firstCell.cell[0];
      dirty.current = recovered !== lastAcknowledged.current;
      reportDraft(draftId, dirty.current);
      math.smartFence = true;
      math.smartSuperscript = true;
      // Slots are caret targets, never sample content in the document.
      math.placeholderSymbol = "\u25A2";
      const applyPreferences = () => {
        const preferences = getKeyboardPreferences().preferences;
        math.inlineShortcuts = preferences.automaticOperators ? INLINE_SHORTCUTS : {};
        math.popoverPolicy = preferences.completion === "off" ? "off" : "auto";
      };
      applyPreferences();
      const unsubscribe = subscribeKeyboardPreferences(applyPreferences);
      const detachShortcuts = attachShortcutHost(host.current!, "math", {
        capture: true,
        feedback: (text) => shortcutHint.current(text),
        accepts: () => !math.readOnly && math.mode !== "latex",
        execute: (id) => {
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
        const source = math.getValue("latex-without-placeholders");
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
      const input = () => {
        dirty.current = true;
        reportDraft(draftId, true);
        clearTimeout(publishTimer);
        cancelPublish?.();
        publishTimer = setTimeout(() => {
          cancelPublish = afterEditorPaint(publish);
        }, 180);
      };
      const modeChange = () => {
        // MathLive changes mode before inserting the completed command.
        queueMicrotask(input);
      };
      const focused = () => {
        if (!math.readOnly) focus.current();
      };
      const blurred = () => {
        if (math.readOnly) return;
        // Preserve what was actually typed when leaving an unfinished command;
        // never accept a ghost suggestion just because focus moved elsewhere.
        if (math.mode === "latex") {
          math.executeCommand("complete");
          publish();
        } else publish();
      };
      let rectangle: MathRectangleSelection | null = null;
      let applyingSelection = false;
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
        if (applyingSelection || pointerSelection) return;
        const endpoints = mathSelectionEndpoints(math);
        if (!endpoints || math.selectionIsCollapsed) {
          rectangle = null;
          return;
        }
        const anchor = mathSelectionAtOffset(math, endpoints[0]);
        const head = mathSelectionAtOffset(math, endpoints[1]);
        if (anchor.path.length === 0 && head.path.length === 0) {
          rectangle = null;
          return;
        }
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
      const keydown = (event: KeyboardEvent) => {
        if (math.readOnly || event.isComposing || event.defaultPrevented) return;
        const modifier = event.ctrlKey || event.metaKey;
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
          if (math.executeCommand("addRowAfter")) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        if ((event.key === "Backspace" || event.key === "Delete") && math.value === "") {
          event.preventDefault();
          event.stopPropagation();
          removeEmpty.current();
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
        const source = copyFormat.current(tex);
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
        math.insert(mathLiveFontDeclarations(parsed), {
          format: "latex",
          insertionMode: "replaceSelection",
          selectionMode: "after",
          focus: true,
        });
      };
      math.addEventListener("input", input);
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
      window.addEventListener("pagehide", publish);
      field.current = math;
      return () => {
        removeEditingGuides();
        stopPointerSelection();
        cancelPointerSelection.current = () => {};
        clearTimeout(publishTimer);
        cancelPublish?.();
        journal();
        reportDraft(draftId, false);
        flush.current = () => true;
        clearSelection.current = () => {};
        detachShortcuts();
        unsubscribe();
        math.removeEventListener("input", input);
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
      math.macros = { ...baseMacros.current, ...documentMacros };
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
      restoreMathFieldValue(field.current, mathLiveFontDeclarations(value));
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
