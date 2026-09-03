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
  return (
    selectionBesideNode(document, position, nodeSize, "after") ??
    selectionBesideNode(document, position, nodeSize, "before")
  );
}

export type AtomBoundarySide = "after" | "before";

/** Find a writable selection on one requested side of an atom. */
export function selectionBesideNode(
  document: ProseMirrorNode,
  position: number,
  nodeSize: number,
  side: AtomBoundarySide,
): Selection | null {
  const boundary = document.resolve(
    side === "after" ? Math.min(position + nodeSize, document.content.size) : Math.max(0, position),
  );
  const direction = side === "after" ? 1 : -1;
  const textSelection = Selection.findFrom(boundary, direction, true);
  if (textSelection) return textSelection;
  // At a block boundary the installed gap-cursor plugin can create a paragraph
  // on composition without replacing the atom. Inline parents normally expose
  // a TextSelection in the requested direction.
  return boundary.parent.inlineContent ? null : new GapCursor(boundary);
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

/** Move the outer editor caret to one physical side of an inline atom. */
export function moveSelectionBesideAtom(
  view: EditorView,
  getPos: () => number | undefined,
  node: ProseMirrorNode,
  side: AtomBoundarySide,
): boolean {
  const position = getPos();
  if (position === undefined) return false;
  const selection = selectionBesideNode(view.state.doc, position, node.nodeSize, side);
  if (!selection) return false;
  if (!view.state.selection.eq(selection)) {
    view.dispatch(view.state.tr.setSelection(selection));
  }
  view.focus();
  return true;
}

/** Remove an empty inline atom through its nested field without trapping focus. */
export function deleteAtomFromEditor(
  view: EditorView,
  getPos: () => number | undefined,
  node: ProseMirrorNode,
): boolean {
  const position = getPos();
  if (position === undefined) return false;
  view.dispatch(view.state.tr.delete(position, position + node.nodeSize));
  view.focus();
  return true;
}

/**
 * Handle the native-looking exit keys shared by one-line atom fields.
 * Physical arrows mirror in RTL while logical before/after document positions
 * remain stable.
 */
export function handleInlineAtomEditorKeyDown(input: {
  readonly direction: "ltr" | "rtl";
  readonly editor: HTMLInputElement;
  readonly event: KeyboardEvent;
  readonly getPos: () => number | undefined;
  readonly node: ProseMirrorNode;
  readonly view: EditorView;
}): boolean {
  const { direction, editor, event, getPos, node, view } = input;
  if (event.isComposing) return false;

  if (event.key === "Escape" || event.key === "Enter") {
    if (!leaveAtomEditor(view, getPos, node)) return false;
    event.preventDefault();
    return true;
  }

  const { selectionEnd, selectionStart, value } = editor;
  if (event.key === "Backspace" && value.length === 0) {
    if (!deleteAtomFromEditor(view, getPos, node)) return false;
    event.preventDefault();
    return true;
  }
  if (selectionStart !== selectionEnd) return false;

  const side =
    event.key === "ArrowLeft"
      ? direction === "rtl"
        ? "after"
        : "before"
      : event.key === "ArrowRight"
        ? direction === "rtl"
          ? "before"
          : "after"
        : null;
  if (side === null) return false;
  const atBoundary = side === "before" ? selectionStart === 0 : selectionEnd === value.length;
  if (!atBoundary || !moveSelectionBesideAtom(view, getPos, node, side)) return false;
  event.preventDefault();
  return true;
}
