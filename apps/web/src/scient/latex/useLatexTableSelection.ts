import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { latexSelectEventOwner } from "./latexContextEvents";
import { captureLatexObjectDrag, latexObjectSelectionAtPointer } from "./latexObjectSelection";
import { clearLatexEditingTarget } from "./latexEditingTarget";

export interface LatexTableCell {
  readonly row: number;
  readonly column: number;
}

export interface LatexTableSelection {
  readonly anchor: LatexTableCell;
  readonly head: LatexTableCell;
  readonly whole: boolean;
}

export function tableSelectionContains(
  selection: LatexTableSelection | null,
  row: number,
  column: number,
) {
  return Boolean(
    selection &&
    row >= Math.min(selection.anchor.row, selection.head.row) &&
    row <= Math.max(selection.anchor.row, selection.head.row) &&
    column >= Math.min(selection.anchor.column, selection.head.column) &&
    column <= Math.max(selection.anchor.column, selection.head.column),
  );
}

/** Native text selection stays inside one cell; crossing cells selects a rectangle. */
export function useLatexTableSelection(props: {
  root: RefObject<HTMLElement | null>;
  editor: Editor;
  getPos: () => number | undefined;
  enabled: boolean;
  rowCount: number;
  columnCount: number;
  activeCell: LatexTableCell;
  canClear: boolean;
  normalizeSelection?: (selection: LatexTableSelection) => LatexTableSelection;
  resolveCell?: (cell: LatexTableCell) => LatexTableCell;
  onClear: (selection: LatexTableSelection) => void;
  onDelete: () => void;
  onClipboard: (selection: LatexTableSelection) => string | null;
}) {
  const [selection, setSelection] = useState<LatexTableSelection | null>(null);
  const current = useRef(props);
  const selected = useRef(selection);
  useLayoutEffect(() => {
    current.current = props;
  });
  const store = (next: LatexTableSelection | null) => {
    if (next && current.current.normalizeSelection) next = current.current.normalizeSelection(next);
    selected.current = next;
    const root = props.root.current;
    if (next) root?.setAttribute("data-table-selection", next.whole ? "whole" : "cells");
    else root?.removeAttribute("data-table-selection");
    setSelection(next);
  };
  const storeRef = useRef(store);
  storeRef.current = store;
  const select = (next: LatexTableSelection) => {
    clearLatexEditingTarget(current.current.editor);
    storeRef.current(next);
    const field = document.activeElement;
    if (field instanceof HTMLTextAreaElement && current.current.root.current?.contains(field))
      field.setSelectionRange(field.selectionEnd, field.selectionEnd);
    current.current.root.current?.focus({ preventScroll: true });
    const { editor, getPos } = current.current;
    const position = getPos();
    if (
      typeof position === "number" &&
      (!(editor.state.selection instanceof NodeSelection) ||
        editor.state.selection.from !== position)
    )
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
      );
    document.getSelection()?.removeAllRanges();
  };
  const selectTable = () =>
    select({
      anchor: { row: 0, column: 0 },
      head: { row: props.rowCount - 1, column: props.columnCount - 1 },
      whole: true,
    });
  const selectRow = () =>
    select({
      anchor: { row: props.activeCell.row, column: 0 },
      head: { row: props.activeCell.row, column: props.columnCount - 1 },
      whole: false,
    });
  const selectColumn = () =>
    select({
      anchor: { row: 0, column: props.activeCell.column },
      head: { row: props.rowCount - 1, column: props.activeCell.column },
      whole: false,
    });
  useEffect(() => {
    const range = selected.current;
    if (
      range &&
      (range.anchor.row >= props.rowCount ||
        range.head.row >= props.rowCount ||
        range.anchor.column >= props.columnCount ||
        range.head.column >= props.columnCount)
    )
      storeRef.current(null);
  }, [props.rowCount, props.columnCount]);
  useEffect(() => {
    if (!props.enabled) return;
    const root = props.root.current;
    if (!root) return;
    let drag: { anchor: LatexTableCell; active: boolean; outside: boolean } | null = null;
    let releaseDrag: (() => void) | null = null;
    const wholeTable = (): LatexTableSelection => ({
      anchor: { row: 0, column: 0 },
      head: { row: current.current.rowCount - 1, column: current.current.columnCount - 1 },
      whole: true,
    });
    const synchronize = () => {
      const { editor, getPos } = current.current;
      const range = editor.state.selection;
      const position = getPos();
      if (!(range instanceof NodeSelection) || range.from !== position) {
        if (selected.current) storeRef.current(null);
        return;
      }
      // A cell editor uses the atom selection as its source-edit anchor.
      // It is only a whole-table selection when focus belongs to the document.
      if (root.contains(document.activeElement) || !editor.view.hasFocus()) return;
      storeRef.current(wholeTable());
    };
    const cellAt = (target: EventTarget | null): LatexTableCell | null => {
      if (!(target instanceof Element) || !root.contains(target)) return null;
      const field = target.closest("td,th")?.querySelector("[data-table-cell]");
      const match = /^(\d+)-(\d+)$/u.exec(field?.getAttribute("data-table-cell") ?? "");
      return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
    };
    const focusCell = (cell: LatexTableCell) => {
      cell = current.current.resolveCell?.(cell) ?? cell;
      storeRef.current(null);
      const field = root.querySelector<HTMLElement>(
        `[data-table-cell="${cell.row}-${cell.column}"]`,
      );
      const inline = (field as (HTMLElement & { editor?: Editor }) | null)?.editor;
      if (inline) inline.commands.focus("end");
      else field?.focus({ preventScroll: true });
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const cell = cellAt(document.elementFromPoint(event.clientX, event.clientY));
      if (!cell) {
        const { editor, getPos } = current.current;
        if (editor.isDestroyed) return;
        if (!drag.outside) {
          drag.outside = true;
          storeRef.current(null);
          editor.view.focus();
        }
        const position = getPos();
        if (typeof position !== "number") return;
        const bounds = (root.querySelector("table") ?? root).getBoundingClientRect();
        const range = latexObjectSelectionAtPointer(editor.view, position, event, bounds);
        if (!range) return;
        storeRef.current(range instanceof NodeSelection ? wholeTable() : null);
        editor.view.dispatch(editor.state.tr.setSelection(range));
        drag.active = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const returning = drag.outside;
      drag.outside = false;
      if (!drag.active && cell.row === drag.anchor.row && cell.column === drag.anchor.column)
        return;
      if (
        selected.current?.head.row !== cell.row ||
        selected.current?.head.column !== cell.column ||
        selected.current?.whole ||
        returning ||
        !drag.active
      )
        select({ anchor: drag.anchor, head: cell, whole: false });
      drag.active = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stopDrag = () => {
      drag = null;
      releaseDrag?.();
      releaseDrag = null;
    };
    const finishDrag = () => {
      const endedOutside = drag?.outside;
      stopDrag();
      if (endedOutside && !current.current.editor.isDestroyed) current.current.editor.view.focus();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      stopDrag();
      const cell = cellAt(event.target);
      if (!cell) {
        if (
          event.target !== root &&
          event.target instanceof Element &&
          event.target.closest("textarea, input, button")
        )
          return;
        // A plain border/background click enters the active cell. Whole-table
        // selection is an explicit toolbar/keyboard action, not caret placement.
        focusCell(current.current.activeCell);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.shiftKey) {
        select({
          anchor: selected.current?.anchor ?? current.current.activeCell,
          head: cell,
          whole: false,
        });
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      storeRef.current(null);
      drag = { anchor: cell, active: false, outside: false };
      releaseDrag = captureLatexObjectDrag(event.pointerId, pointerMove, finishDrag);
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !root.contains(event.target) &&
        !event.target.closest(".scient-latex-context-tools") &&
        !latexSelectEventOwner(event)?.closest(".scient-latex-context-tools")
      )
        storeRef.current(null);
    };
    const focused = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-table-cell]") &&
        selected.current
      )
        storeRef.current(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const state = current.current;
      const modifier = event.ctrlKey || event.metaKey;
      if (
        !selected.current &&
        event.target instanceof Element &&
        event.target.closest(".scient-latex-object-math, .scient-latex-visual-inline-math")
      )
        return;
      const field =
        event.target instanceof HTMLTextAreaElement && event.target.hasAttribute("data-table-cell")
          ? event.target
          : null;
      const inline =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-table-cell][contenteditable]")
          : null;
      const inlineEditor = (inline as (HTMLElement & { editor?: Editor }) | null)?.editor;
      const selectedText = field
        ? field.selectionStart === 0 && field.selectionEnd === field.value.length
        : inlineEditor
          ? inlineEditor.state.selection.from <= 1 &&
            inlineEditor.state.selection.to >= inlineEditor.state.doc.content.size - 1
          : false;
      if (
        modifier &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        (selected.current || (!field && !inlineEditor) || selectedText)
      ) {
        select({
          anchor: { row: 0, column: 0 },
          head: { row: state.rowCount - 1, column: state.columnCount - 1 },
          whole: true,
        });
      } else if (
        !modifier &&
        !event.altKey &&
        (event.key === "Delete" || event.key === "Backspace") &&
        selected.current
      ) {
        if (selected.current.whole) state.onDelete();
        else if (state.canClear) state.onClear(selected.current);
      } else if (!modifier && !event.altKey && event.shiftKey && event.key.startsWith("Arrow")) {
        const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const atEdge = field
          ? direction < 0
            ? field.selectionStart === 0
            : field.selectionEnd === field.value.length
          : inlineEditor
            ? direction < 0
              ? inlineEditor.state.selection.from === 1
              : inlineEditor.state.selection.to === inlineEditor.state.doc.content.size - 1
            : false;
        if (!selected.current && !atEdge) return;
        const anchor = selected.current?.anchor ?? state.activeCell;
        const head = selected.current?.head ?? state.activeCell;
        select({
          anchor,
          head: {
            row: Math.max(
              0,
              Math.min(
                state.rowCount - 1,
                head.row + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0),
              ),
            ),
            column: Math.max(
              0,
              Math.min(
                state.columnCount - 1,
                head.column + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0),
              ),
            ),
          },
          whole: false,
        });
      } else if (
        selected.current &&
        (event.key === "Escape" || event.key === "Tab" || event.key.startsWith("Arrow"))
      ) {
        focusCell(selected.current.head);
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const clipboard = (event: ClipboardEvent) => {
      const range = selected.current;
      if (!range || !event.clipboardData) return;
      const source = current.current.onClipboard(range);
      if (source === null) return;
      event.clipboardData.setData("text/plain", source);
      event.clipboardData.setData("application/x-latex", source);
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "cut") {
        if (range.whole) current.current.onDelete();
        else if (current.current.canClear) current.current.onClear(range);
      }
    };
    root.addEventListener("pointerdown", pointerDown, true);
    root.addEventListener("focusin", focused);
    root.addEventListener("keydown", keydown, true);
    root.addEventListener("copy", clipboard, true);
    root.addEventListener("cut", clipboard, true);
    document.addEventListener("pointerdown", outside, true);
    props.editor.on("selectionUpdate", synchronize);
    props.editor.on("focus", synchronize);
    synchronize();
    return () => {
      stopDrag();
      root.removeEventListener("pointerdown", pointerDown, true);
      root.removeEventListener("focusin", focused);
      root.removeEventListener("keydown", keydown, true);
      root.removeEventListener("copy", clipboard, true);
      root.removeEventListener("cut", clipboard, true);
      document.removeEventListener("pointerdown", outside, true);
      props.editor.off("selectionUpdate", synchronize);
      props.editor.off("focus", synchronize);
    };
  }, [props.enabled, props.root, props.editor]);
  return {
    selection,
    selectTable,
    selectRow,
    selectColumn,
    clear: () => {
      if (selection && props.canClear) props.onClear(selection);
    },
  };
}
