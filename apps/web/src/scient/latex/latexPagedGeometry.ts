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
