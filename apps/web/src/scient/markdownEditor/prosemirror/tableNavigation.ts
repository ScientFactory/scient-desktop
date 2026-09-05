import { Selection, TextSelection, type Command } from "prosemirror-state";
import { CellSelection, cellAround, inSameTable, nextCell } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

import { runScientMarkdownCommand } from "./commands";

type ArrowDirection = "left" | "right" | "up" | "down";

/** Inline-only GFM cells use a line break instead of splitting into paragraphs. */
export const inlineTableEnter: Command = (state, dispatch, view) => {
  const { selection } = state;
  if (!view?.editable || !(selection instanceof TextSelection)) return false;
  if (!selection.$from.sameParent(selection.$to)) return false;
  const role = selection.$from.parent.type.spec.tableRole;
  if (role !== "cell" && role !== "header_cell") return false;
  return runScientMarkdownCommand("hard-break", state, dispatch);
};

/**
 * GFM cells are textblocks themselves (inline*), not paragraph containers.
 * prosemirror-tables' edge handler starts above the textblock, so it skips
 * these cells. Adapt only that boundary; native caret movement within a cell
 * and the upstream table map, selections, Tab, and structural commands stay
 * in charge. No navigation transaction changes the document.
 */
export function inlineTableArrow(direction: ArrowDirection, extend = false): Command {
  return (state, dispatch, view) => {
    const selectedCells = state.selection instanceof CellSelection ? state.selection : null;
    if (!view?.editable || !(state.selection instanceof TextSelection || selectedCells)) {
      return false;
    }
    if (!selectedCells) {
      if (!extend && !state.selection.empty) return false;
      const role = state.selection.$head.parent.type.spec.tableRole;
      if (role !== "cell" && role !== "header_cell") return false;
      if (!view.endOfTextblock(direction)) return false;
    }

    const $cell = selectedCells?.$headCell ?? cellAround(state.selection.$head);
    if (!$cell?.nodeAfter?.inlineContent) return false;
    const vertical = direction === "up" || direction === "down";
    let step = direction === "left" || direction === "up" ? -1 : 1;
    const cellDOM = view.nodeDOM($cell.pos);
    const tableDOM = cellDOM instanceof HTMLElement ? cellDOM.closest("table") : null;
    // Column order follows the table, not the bidi text inside this cell.
    if (!vertical && tableDOM && getComputedStyle(tableDOM).direction === "rtl") step *= -1;
    if (selectedCells && !extend) {
      const position = $cell.pos + 1 + (step < 0 ? 0 : $cell.nodeAfter.content.size);
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, position)).scrollIntoView());
      return true;
    }
    const $next = nextCell($cell, vertical ? "vert" : "horiz", step);

    if (extend) {
      if (!$next) return selectedCells !== null;
      const $anchor = selectedCells?.$anchorCell ?? cellAround(state.selection.$anchor);
      if (!$anchor || !inSameTable($anchor, $cell)) return false;
      dispatch?.(state.tr.setSelection(new CellSelection($anchor, $next)).scrollIntoView());
      return true;
    }

    let selection: Selection | null;
    if ($next) {
      const nextNode = $next.nodeAfter!;
      const start = $next.pos + 1;
      const end = start + nextNode.content.size;
      selection = TextSelection.create(state.doc, step > 0 ? start : end);
      // Hit-test the entering edge: Up/Down retain visual x and Left/Right
      // enter from the correct side even when neighboring text is bidi.
      const position = cellEntryPosition(view, $next.pos, direction, start, end);
      if (position !== null) selection = TextSelection.create(state.doc, position);
    } else {
      const edge = vertical
        ? step < 0
          ? $cell.before(-1)
          : $cell.after(-1)
        : step < 0
          ? $cell.pos
          : $cell.pos + $cell.nodeAfter!.nodeSize;
      const $edge = state.doc.resolve(edge);
      // Preserve an adjacent gap/atomic block instead of searching past it
      // for text farther away. Use the existing selection plugin contract.
      selection =
        view.someProp("createSelectionBetween", (create) => create(view, $edge, $edge)) ??
        Selection.findFrom($edge, step);
    }

    // If there is no adjacent text, let the existing gap-cursor plugin own
    // the position outside the table (row-internal gaps are disabled).
    if (!selection) return false;
    if (!selection.eq(state.selection)) {
      dispatch?.(state.tr.setSelection(selection).scrollIntoView());
    }
    return true;
  };
}

function cellEntryPosition(
  view: EditorView,
  cellPosition: number,
  direction: ArrowDirection,
  start: number,
  end: number,
): number | null {
  const dom = view.nodeDOM(cellPosition);
  if (!(dom instanceof HTMLElement)) return null;
  const box = dom.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const current = view.coordsAtPos(view.state.selection.head);
  const vertical = direction === "up" || direction === "down";
  const firstLine = view.coordsAtPos(start);
  const lastLine = view.coordsAtPos(end);
  const line = direction === "down" ? firstLine : lastLine;
  const hit = view.posAtCoords({
    left: vertical
      ? Math.max(box.left + 1, Math.min(current.left, box.right - 1))
      : direction === "right"
        ? box.left + 1
        : box.right - 1,
    top: vertical
      ? (line.top + line.bottom) / 2
      : Math.max(
          firstLine.top + 1,
          Math.min((current.top + current.bottom) / 2, lastLine.bottom - 1),
        ),
  });
  // Hit testing can resolve to another cell or an outside block, particularly
  // offscreen. Never let that turn a directional move into a table jump.
  return hit && hit.pos >= start && hit.pos <= end ? hit.pos : null;
}
