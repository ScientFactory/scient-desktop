// The value of one mark attribute (a font size or family) over the selection, shown in the font panel.
import type { EditorState } from "prosemirror-state";
import { scientMarkdownSchema } from "./schema";

/**
 * The shared value over the selection; `mixed` when it holds more than one (a null value then
 * means "none"). Inline code and whitespace-only text are ignored: the file holds no font there.
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
    if (node.marks.some((m) => m.type.name === "code")) return;
    const value = node.marks.find((m) => m.type === type)?.attrs[attribute];
    values.add(valid(value) ? value : null);
  });
  return values.size === 1
    ? { value: [...values][0] ?? null, mixed: false }
    : { value: null, mixed: values.size > 1 };
}
