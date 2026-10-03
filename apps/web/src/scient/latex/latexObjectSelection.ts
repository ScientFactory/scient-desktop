import type { Node as DocumentNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type ObjectBounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type PointerPoint = Pick<PointerEvent, "clientX" | "clientY">;

export const LATEX_SELECTION_OBJECT_SELECTOR =
  '.scient-latex-visual-inline-math, .scient-latex-visual-display-math, .scient-latex-rich-preview[data-kind="table"]';

export function isLatexSelectionObject(node: DocumentNode | null): boolean {
  return Boolean(
    node &&
    (node.type.name === "latexInlineMath" ||
      node.type.name === "latexDisplayMath" ||
      (node.type.name === "latexRichPreview" && node.attrs.kind === "table")),
  );
}

/** A drag ending inside an embedded editor includes that editor's whole object. */
export function latexDocumentSelectionAtPointer(
  view: EditorView,
  anchor: number,
  point: PointerPoint,
): Selection | null {
  const { doc } = view.state;
  const hit = view.posAtCoords({ left: point.clientX, top: point.clientY });
  if (!hit) return null;
  let head = hit.pos;
  const target = view.dom.ownerDocument
    .elementFromPoint(point.clientX, point.clientY)
    ?.closest(LATEX_SELECTION_OBJECT_SELECTOR);
  if (target && view.dom.contains(target)) {
    const position =
      hit.inside >= 0 && isLatexSelectionObject(doc.nodeAt(hit.inside))
        ? hit.inside
        : view.posAtDOM(target, 0);
    const node = doc.nodeAt(position);
    if (isLatexSelectionObject(node)) {
      const end = position + node!.nodeSize;
      head = anchor <= position ? end : anchor >= end ? position : head;
    }
  }
  const direction = head >= anchor ? 1 : -1;
  const nearby = TextSelection.between(doc.resolve(anchor), doc.resolve(head), direction);
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  let missesObject = false;
  doc.nodesBetween(from, to, (node, position) => {
    if (!isLatexSelectionObject(node)) return;
    if (
      from <= position &&
      to >= position + node.nodeSize &&
      (nearby.from > position || nearby.to < position + node.nodeSize)
    )
      missesObject = true;
    return false;
  });
  return missesObject ? TextSelection.create(doc, anchor, head) : nearby;
}

export function pointerInsideLatexObject(point: PointerPoint, bounds: ObjectBounds): boolean {
  return (
    point.clientX >= bounds.left &&
    point.clientX <= bounds.right &&
    point.clientY >= bounds.top &&
    point.clientY <= bounds.bottom
  );
}

/** Text endpoints may snap around a block; crossing an object must still include it. */
export function selectionIncludingLatexObject(
  doc: DocumentNode,
  position: number,
  anchor: number,
  head: number,
  direction: -1 | 1,
): Selection {
  const end = position + doc.nodeAt(position)!.nodeSize;
  const coversObject = (selection: Selection) => selection.from <= position && selection.to >= end;
  const nearby = TextSelection.between(doc.resolve(anchor), doc.resolve(head), direction);
  if (coversObject(nearby)) return nearby;
  const exact = TextSelection.create(doc, anchor, head);
  return coversObject(exact) ? exact : NodeSelection.create(doc, position);
}

/** Leaving a nested editor selects its object and extends into the surrounding document. */
export function latexObjectSelectionAtPointer(
  view: EditorView,
  position: number,
  point: PointerPoint,
  bounds: ObjectBounds,
): Selection | null {
  const doc = view.state.doc;
  const node = doc.nodeAt(position);
  if (!node) return null;
  const end = position + node.nodeSize;
  const hit = view.posAtCoords({ left: point.clientX, top: point.clientY });
  const before = hit && hit.pos < position;
  const after = hit && hit.pos > end;
  const direction = before
    ? -1
    : after
      ? 1
      : point.clientY < bounds.top ||
          (point.clientY <= bounds.bottom && point.clientX < bounds.left)
        ? -1
        : 1;
  const anchor = direction > 0 ? position : end;
  const documentSelection = latexDocumentSelectionAtPointer(view, anchor, point);
  if (documentSelection && documentSelection.from <= position && documentSelection.to >= end)
    return documentSelection;
  const head =
    direction > 0 ? Math.max(hit?.pos ?? end, end) : Math.min(hit?.pos ?? position, position);
  return selectionIncludingLatexObject(doc, position, anchor, head, direction);
}

/** Capture before nested editors repaint their selection; release only the owning pointer. */
export function captureLatexObjectDrag(
  pointerId: number,
  onMove: (event: PointerEvent) => void,
  onFinish: (event: PointerEvent) => void,
): () => void {
  const move = (event: PointerEvent) => {
    if (event.pointerId === pointerId && event.buttons & 1) onMove(event);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", finish, true);
  };
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    cleanup();
    onFinish(event);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);
  return cleanup;
}
