// The value of one mark attribute (a font size or family) over the selection, shown in the font panel.
import type { EditorState } from "prosemirror-state";
import { scientMarkdownSchema } from "./schema";

/**
 * The shared value over the selection; `mixed` when the selection holds more than one value
 * (a null value then means "none", not "several"). Text made only of spaces is ignored: the
 * file never stores a style on a space at the edge of a run, so counting it would turn words
 * that were sized one by one into a mixed selection.
 */
export function selectionMarkValue<T extends string | number>(
  state: EditorState,
  markName: string,
  attribute: string,
  kind: "string" | "number",
): { readonly value: T | null; readonly mixed: boolean } {
  const { selection } = state;
  const type = scientMarkdownSchema.marks[markName]!;
  const valid = (value: unknown): value is T => typeof value === kind;
  if (selection.empty) {
    const mark = (state.storedMarks ?? selection.$from.marks()).find((m) => m.type === type);
    const value = mark?.attrs[attribute];
    return { value: valid(value) ? value : null, mixed: false };
  }
  const values = new Set<T | null>();
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText || /^\s*$/u.test(node.text ?? "")) return;
    const value = node.marks.find((m) => m.type === type)?.attrs[attribute];
    values.add(valid(value) ? value : null);
  });
  return values.size === 1
    ? { value: [...values][0] ?? null, mixed: false }
    : { value: null, mixed: values.size > 1 };
}
