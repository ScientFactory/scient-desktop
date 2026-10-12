import { GapCursor } from "@tiptap/pm/gapcursor";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Object activation belongs to the footer; it must not select document content. */
export function preserveLatexCaret(view: EditorView) {
  const { selection, doc } = view.state;
  if (selection.empty) return;
  const caret =
    Selection.findFrom(selection.$head, 1, true) ?? Selection.findFrom(selection.$head, -1, true);
  // A document containing only atomic blocks has no text position. Leave an
  // insertion caret before those blocks rather than selecting one of them.
  const next = caret ?? new GapCursor(doc.resolve(0));
  view.dispatch(view.state.tr.setSelection(next).setMeta("addToHistory", false));
}

/** A generated statement heading leads into its first editable paragraph. */
export function enterLatexObjectBody(view: EditorView, position: number) {
  const node = view.state.doc.nodeAt(position);
  if (!node || node.isLeaf) return;
  const caret = Selection.findFrom(view.state.doc.resolve(position + 1), 1, true);
  if (!(caret instanceof TextSelection) || caret.from >= position + node.nodeSize - 1) return;
  view.dispatch(view.state.tr.setSelection(caret).setMeta("addToHistory", false));
  view.focus();
}

/** Suppress ProseMirror's implicit atom selection on a plain click only.
 * Drag ranges, modifier clicks and explicit Select object actions stay available.
 */
export const handleLatexObjectClick: NonNullable<
  import("@tiptap/pm/view").EditorProps["handleClickOn"]
> = (view, _position, node, _nodePosition, event, direct) => {
  if (
    !direct ||
    node.type.name !== "latexRichPreview" ||
    event.button !== 0 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return false;
  preserveLatexCaret(view);
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest(
    'input, textarea, select, button, a, math-field, [contenteditable="true"]',
  );
  // Native fields and navigation buttons keep their own focus/caret.
  if (!control || control === view.dom) view.focus();
  target
    ?.closest("[data-node-view-wrapper]")
    ?.dispatchEvent(new Event("scient-latex-object-activate"));
  return true;
};
