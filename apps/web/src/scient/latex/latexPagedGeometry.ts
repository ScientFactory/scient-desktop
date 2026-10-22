import { PluginKey, type EditorState } from "@tiptap/pm/state";
import { DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { PagedPlan } from "./latexPagedFlow";

export interface PageGeometry {
  readonly page: number;
  readonly from: number;
  readonly to: number;
  readonly top: number;
  readonly column: number;
}
export interface Presentation {
  readonly decorations: DecorationSet;
  readonly plan: PagedPlan | null;
  readonly geometry: readonly PageGeometry[];
  readonly revision: number;
}
export interface PagedTableLayout {
  readonly breaks: readonly { row: number; height: number }[];
  readonly offsets: readonly { row: number; left: number }[];
}
export const latexPagedKey = new PluginKey<Presentation>("scientPagedPresentation");
export const pagedLayoutProgress = new WeakMap<EditorView, { pending: boolean }>();
export function pagedLayoutSettled(view: EditorView): boolean {
  return pagedLayoutProgress.get(view)?.pending === false;
}
export function visualPageAt(state: EditorState, position: number): number | null {
  const geometry = latexPagedKey.getState(state)?.geometry;
  if (!geometry?.length) return null;
  const hit = geometry.find((part) => part.from <= position && part.to > position);
  return (hit ?? geometry.findLast((part) => part.from <= position) ?? geometry[0])!.page + 1;
}

/** Browser text hit testing sees translated column fragments that lie outside a paragraph's box. */
export function pagedPositionAtPoint(view: EditorView, left: number, top: number): number | null {
  if (!latexPagedKey.getState(view.state)?.plan)
    return view.posAtCoords({ left, top })?.pos ?? null;
  const range = view.dom.ownerDocument.caretRangeFromPoint?.(left, top);
  const caret = range ? { node: range.startContainer, offset: range.startOffset } : null;
  const position = caret ? null : view.dom.ownerDocument.caretPositionFromPoint?.(left, top);
  const point = caret ?? (position && { node: position.offsetNode, offset: position.offset });
  if (point && view.dom.contains(point.node))
    try {
      return view.posAtDOM(point.node, point.offset);
    } catch {
      /* A nested editor owns its own positions. */
    }
  const hit = view.posAtCoords({ left, top });
  if (hit) return hit.pos;
  const geometry = latexPagedKey.getState(view.state)?.geometry ?? [];
  const box = view.dom.getBoundingClientRect();
  const scale = box.width / (view.dom.offsetWidth || 1);
  const y = (top - box.top) / scale;
  let closest: PageGeometry | undefined;
  for (const part of geometry)
    if (!closest || Math.abs(part.top - y) < Math.abs(closest.top - y)) closest = part;
  return closest?.from ?? null;
}

/** The innermost block the reader sees at the top of the reading area. */
const ANCHOR_BLOCK =
  "p, li, h1, h2, h3, h4, h5, h6, .node-latexDisplayMath, .node-latexRichPreview, .node-latexRawBlock, .scient-latex-footnotes";

/** Page margins and column gutters must not hide the first visible reading line. */
export function readLatexVisibleReadingTarget(view: EditorView, box: DOMRect, paper: DOMRect) {
  let left = paper.left + paper.width / 2;
  let y = Math.max(box.top, paper.top) + 1;
  const usable = (element: Element | null) =>
    element &&
    element !== view.dom &&
    view.dom.contains(element) &&
    (!element.closest('[data-layout="sourceColumns"]') || element.closest(ANCHOR_BLOCK));
  // Text at the top edge is the reading line itself: anchoring a
  // later line would let rewrapping above it move the top line.
  const readsText = () => {
    if (!usable(view.dom.ownerDocument.elementFromPoint(left, y))) return false;
    try {
      const position = pagedPositionAtPoint(view, left, y);
      if (position === null) return false;
      const line = view.coordsAtPos(position);
      const tolerance = Math.max(4, (line.bottom - line.top) / 2);
      return y >= line.top - tolerance && y <= line.bottom + tolerance;
    } catch {
      return false;
    }
  };
  // The planner already knows the visible line origins. Page margins
  // and column gutters must not make hit testing reveal dozens of
  // otherwise skipped blocks while searching for the first line.
  const geometry = latexPagedKey.getState(view.state)?.geometry;
  const zoom = paper.width / (view.dom.offsetWidth || 1);
  if (geometry?.length && !readsText()) {
    const top = (y - paper.top) / zoom;
    const bottom = (box.bottom - paper.top) / zoom;
    let first: (typeof geometry)[number] | undefined;
    for (const part of geometry)
      if (part.top >= top && part.top < bottom && (!first || part.top < first.top)) first = part;
    if (first) {
      try {
        const line = view.coordsAtPos(first.from);
        if (line.bottom > box.top && line.top < box.bottom) {
          left = (line.left + line.right) / 2;
          y = Math.max(box.top + 1, (line.top + line.bottom) / 2);
        }
      } catch {
        // Replaced atom views retain the ordinary hit-test fallback.
      }
    }
  }
  let hit = view.dom.ownerDocument.elementFromPoint(left, y);
  // A page margin or column gutter has no text at the viewport edge.
  // Anchor the first visible content below it rather than dropping the anchor.
  if (!usable(hit)) {
    hit = null;
    search: for (let top = y; top < box.bottom; top += 12) {
      for (const x of [left, paper.left + paper.width / 4, paper.left + (paper.width * 3) / 4]) {
        const candidate = view.dom.ownerDocument.elementFromPoint(x, top);
        if (usable(candidate)) {
          hit = candidate;
          left = x;
          y = top;
          break search;
        }
      }
    }
  }
  if (!hit) return null;
  // A block the browser has not rendered yet is hit as a whole.
  let block: Element = hit;
  while (block.parentElement !== view.dom) block = block.parentElement!;
  const inner = hit.closest(ANCHOR_BLOCK);
  const element = inner && block.contains(inner) ? inner : block;
  return { block, element, left, top: y };
}
