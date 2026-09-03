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
export type PhysicalTextDirection = "ltr" | "rtl";

/** Read the direction that the browser actually uses to lay out an element. */
export function computedTextDirection(
  element: HTMLElement,
  fallback: PhysicalTextDirection,
): PhysicalTextDirection {
  const direction = getComputedStyle(element).direction;
  return direction === "ltr" || direction === "rtl" ? direction : fallback;
}

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

/** Move the outer editor caret to one requested document side of an inline atom. */
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
 * The field direction locates its physical edge; the surrounding direction
 * maps that edge to the atom's logical before/after document position.
 */
export function handleInlineAtomEditorKeyDown(input: {
  readonly editor: HTMLInputElement;
  readonly event: KeyboardEvent;
  readonly fieldDirection: PhysicalTextDirection;
  readonly getPos: () => number | undefined;
  readonly node: ProseMirrorNode;
  readonly surroundingDirection: PhysicalTextDirection;
  readonly view: EditorView;
}): boolean {
  const { editor, event, fieldDirection, getPos, node, surroundingDirection, view } = input;
  if (event.isComposing) return false;

  if (event.key === "Escape") {
    if (!leaveAtomEditor(view, getPos, node)) return false;
    event.preventDefault();
    return true;
  }

  // Modified keys retain their native field or application semantics. In
  // particular, Shift+Arrow must not collapse into an ordinary atom exit.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

  if (event.key === "Enter") {
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

  const physicalSide =
    event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : null;
  if (physicalSide === null) return false;
  const atBoundary =
    (fieldDirection === "ltr") === (physicalSide === "left")
      ? selectionStart === 0
      : selectionEnd === value.length;
  const side: AtomBoundarySide =
    (surroundingDirection === "ltr") === (physicalSide === "left") ? "before" : "after";
  if (!atBoundary || !moveSelectionBesideAtom(view, getPos, node, side)) return false;
  event.preventDefault();
  return true;
}
