import { GapCursor } from "prosemirror-gapcursor";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Find a writable text position or legal block gap without selecting the node
 * itself. This keeps leaving an atom editor from making the next printable key
 * replace the entire source island.
 */
export function selectionOutsideNode(
  document: ProseMirrorNode,
  position: number,
  nodeSize: number,
): Selection | null {
  const after = document.resolve(Math.min(position + nodeSize, document.content.size));
  const afterText = Selection.findFrom(after, 1, true);
  if (afterText) return afterText;
  // This helper is called for an atom node. If no text position exists after
  // it, the resolved position is a block boundary where the installed gap
  // cursor plugin can create a paragraph on composition without deleting the
  // atom. Inline parents always expose a TextSelection above.
  if (!after.parent.inlineContent) return new GapCursor(after);

  const before = document.resolve(Math.max(0, position));
  const beforeText = Selection.findFrom(before, -1, true);
  if (beforeText) return beforeText;
  return before.parent.inlineContent ? null : new GapCursor(before);
}

/** Move focus out of one nested atom editor without mutating document bytes. */
export function leaveAtomEditor(
  view: EditorView,
  getPos: () => number | undefined,
  node: ProseMirrorNode,
): boolean {
  const position = getPos();
  if (position === undefined) return false;
  const selection = selectionOutsideNode(view.state.doc, position, node.nodeSize);
  if (!selection) return false;
  if (!view.state.selection.eq(selection)) {
    view.dispatch(view.state.tr.setSelection(selection));
  }
  view.focus();
  return true;
}
