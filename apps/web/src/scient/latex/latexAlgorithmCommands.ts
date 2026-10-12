import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  algorithmStepSelection,
  editAlgorithmSteps,
  type AlgorithmStepOperation,
} from "./latexAlgorithmEditing";

/** Menu and keyboard edits share one balanced transaction and source acceptance check. */
export function applyAlgorithmStepEdit(
  editor: Editor,
  at: number,
  operation: AlgorithmStepOperation,
  kind?: string,
): string | null {
  if (!editor.isEditable || editor.isDestroyed) return "The algorithm is not editable.";
  const current = editor.state.doc.nodeAt(at);
  const selected = current && algorithmStepSelection(current, at, editor.state.selection);
  if (!current || !selected) return "The algorithm editing position is no longer available.";
  const changed = editAlgorithmSteps(current, selected, operation, kind);
  if (!changed) return "This action cannot preserve the selected algorithm structure.";
  const replacement = current.type.create(
    current.attrs,
    changed.rows.map((row) => editor.schema.nodeFromJSON(row)),
  );
  let offset = at + 1;
  replacement.forEach((row, rowOffset, index) => {
    if (index !== changed.index) return;
    offset += rowOffset + 1;
    if (changed.focusComment)
      row.forEach((child, childOffset) => {
        if (child.type.name === "latexAlgorithmComment") offset += childOffset + 1;
      });
  });
  const tr = editor.state.tr.replaceWith(at, at + current.nodeSize, replacement);
  tr.setSelection(TextSelection.create(tr.doc, offset));
  editor.view.dispatch(tr.scrollIntoView());
  if (!editor.state.doc.nodeAt(at)?.eq(replacement))
    return "The algorithm source could not preserve this change. Your content was kept.";
  editor.view.focus();
  return null;
}

/** An extra delete on an empty structural line removes its pair, keeping enclosed content. */
export function deleteEmptyAlgorithmStructure(editor: Editor): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false;
  const { selection } = editor.state;
  if (!selection.empty || selection.$from.parent.type.name !== "latexAlgorithmLine") return false;
  const line = selection.$from.parent;
  if (line.content.size !== 0) return false;
  let depth = selection.$from.depth - 1;
  while (depth > 0 && selection.$from.node(depth).attrs.layout?.kind !== "algorithm") depth--;
  if (!depth) return false;
  const node = selection.$from.node(depth);
  const at = selection.$from.before(depth);
  const selected = algorithmStepSelection(node, at, selection);
  if (!selected || !selected.pairs.has(selected.first)) return false;
  applyAlgorithmStepEdit(editor, at, "unwrap");
  // Never let the generic paragraph join separate a paired algorithm boundary.
  return true;
}
