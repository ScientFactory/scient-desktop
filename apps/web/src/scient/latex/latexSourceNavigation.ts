import type { MouseEvent } from "react";
import { sourceOffset } from "../math/input/sourceAdapter";
import type { VisualProjectDocument, VisualProjectFile } from "./latexProjectVisual";

export interface LatexSourceNavigation {
  readonly requestId: number;
  readonly path: string;
  readonly source: string;
  readonly line: number;
}

export interface LatexVisualNavigation {
  readonly requestId: number;
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

export function sourcePositionFromPointerEvent(event: MouseEvent<HTMLElement>) {
  for (const candidate of event.nativeEvent.composedPath()) {
    if (!(candidate instanceof HTMLElement)) continue;
    if (candidate.closest("input,textarea,select,[data-line-annotation]")) return null;
    const raw = candidate.dataset.line;
    if (raw === undefined) continue;
    const line = Number(raw);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    return { line, column: 0 };
  }
  return null;
}

/** Reverse the include mapping only for the exact draft the source pane displayed. */
export function projectVisualNavigation(
  document: VisualProjectDocument,
  files: ReadonlyMap<string, VisualProjectFile>,
  target: LatexSourceNavigation,
): LatexVisualNavigation | null {
  if (files.get(target.path)?.contents !== target.source) return null;
  const line = target.source.split(/\r\n|[\r\n]/u)[target.line - 1];
  if (line === undefined) return null;
  const start = sourceOffset(target.source, { line: target.line - 1, character: 0 });
  const end = start + Math.max(1, line.length);
  const span = document.spans.find(
    (item) =>
      item.path === target.path &&
      item.sourceFrom < end &&
      item.sourceFrom + item.to - item.from > start,
  );
  if (!span) return null;
  return {
    requestId: target.requestId,
    source: document.source,
    from: span.from + Math.max(0, start - span.sourceFrom),
    to: span.from + Math.min(span.to - span.from, end - span.sourceFrom),
  };
}
