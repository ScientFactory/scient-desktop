import type { EditorState } from "prosemirror-state";

import { countWords } from "./documentCounts";

/** "Table · row 3, column 2" while the caret is in a table cell, otherwise null. */
export function tableCaretPosition(state: EditorState): string | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec.tableRole === "row")
      return `Table · row ${$from.index(depth - 1) + 1}, column ${$from.index(depth) + 1}`;
  }
  return null;
}

/**
 * Words in the selection, or null when nothing is selected. A selection of
 * table cells is several ranges, not one, and every one of them is counted.
 */
export function countSelectedWords(state: EditorState): number | null {
  if (state.selection.empty) return null;
  return state.selection.ranges.reduce(
    (count, range) =>
      count + countWords(state.doc.textBetween(range.$from.pos, range.$to.pos, " ", " ")),
    0,
  );
}
