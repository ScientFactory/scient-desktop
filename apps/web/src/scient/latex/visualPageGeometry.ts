import type { VisualRun } from "@t3tools/shared/latexVisual";
import type { VisualEditManifest, VisualEditManifestEntry } from "./visualEditManifest";

export interface VisualTextHit {
  readonly node: Text;
  readonly offset: number;
  readonly span: HTMLElement;
  readonly entry: VisualEditManifestEntry;
}

export interface DraftGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontStyle: string;
  readonly fontWeight: string;
  readonly letterSpacing: string;
  readonly lineHeight: string;
}

export interface DraftAnchor {
  readonly span: HTMLElement;
  readonly page: HTMLElement;
  readonly run: VisualRun;
}

function offsetInText(node: Text, clientX: number): number {
  const range = document.createRange();
  for (let i = 0; i < node.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rect = range.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return node.length;
}

function textNode(span: HTMLElement): Text | null {
  const node = span.firstChild;
  return node instanceof Text && span.childNodes.length === 1 && span.dir !== "rtl" ? node : null;
}

function textRect(node: Text): DOMRect {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.length);
  return range.getBoundingClientRect();
}

/** Resolve page whitespace to the nearest unambiguous insertion-bearing text line. */
export function visualTextHit(
  event: MouseEvent,
  container: HTMLElement,
  manifest: VisualEditManifest,
): VisualTextHit | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const span = target.closest<HTMLElement>(".textLayer span");
  const direct = span ? textNode(span) : null;
  const directEntry = span ? manifest.entryFor(span) : null;
  if (span && direct && directEntry && /\S/u.test(direct.data)) {
    return { node: direct, offset: offsetInText(direct, event.clientX), span, entry: directEntry };
  }
  // Text that failed semantic qualification is read-only. The whitespace
  // affordance must never redirect a deliberate click on it to nearby prose.
  if (span && direct && /\S/u.test(direct.data)) return null;

  const page = target.closest<HTMLElement>(".page[data-page-number]");
  if (!page || !container.contains(page)) return null;
  const candidates: Array<{
    node: Text;
    span: HTMLElement;
    rect: DOMRect;
    score: number;
  }> = [];
  for (const entry of manifest.entries) {
    const candidate = entry.span;
    if (candidate.closest(".page[data-page-number]") !== page) continue;
    const node = entry.node;
    if (!node.isConnected || !/\S/u.test(node.data)) continue;
    const rect = textRect(node);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dx =
      event.clientX < rect.left
        ? rect.left - event.clientX
        : event.clientX > rect.right
          ? event.clientX - rect.right
          : 0;
    const dy =
      event.clientY < rect.top
        ? rect.top - event.clientY
        : event.clientY > rect.bottom
          ? event.clientY - rect.bottom
          : 0;
    if (dy > Math.max(32, rect.height * 2.5)) continue;
    candidates.push({ node, span: candidate, rect, score: dy * 4 + dx });
  }
  candidates.sort((a, b) => a.score - b.score);
  const nearest = candidates[0];
  if (!nearest) return null;
  const second = candidates[1];
  if (
    second &&
    Math.abs(second.score - nearest.score) < 2 &&
    Math.abs(second.rect.left - nearest.rect.left) > Math.max(nearest.rect.width, second.rect.width)
  )
    return null;
  return {
    node: nearest.node,
    offset: offsetInText(nearest.node, event.clientX),
    span: nearest.span,
    entry: manifest.entryFor(nearest.span)!,
  };
}

export function measureDraftGeometry(
  container: HTMLElement,
  anchor: DraftAnchor,
  manifest: VisualEditManifest,
): DraftGeometry | null {
  const host = container.parentElement;
  if (!host || !anchor.span.isConnected || !anchor.page.isConnected) return null;
  const rects: DOMRect[] = [];
  for (const entry of manifest.entries) {
    if (entry.span.closest(".page[data-page-number]") !== anchor.page) continue;
    // Manifest rebuilds create fresh VisualRun objects, so source coordinates
    // are the stable identity. Raw text containment is not: an unrelated
    // paragraph, table, or generated label can repeat a substring and must not
    // enlarge the active editor's mask.
    if (
      entry.run.from !== anchor.run.from ||
      entry.run.to !== anchor.run.to ||
      entry.run.text !== anchor.run.text
    )
      continue;
    const rect = textRect(entry.node);
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  if (rects.length === 0) return null;
  const hostRect = host.getBoundingClientRect();
  let left = rects[0]!.left;
  let top = rects[0]!.top;
  let right = rects[0]!.right;
  let bottom = rects[0]!.bottom;
  let lineHeight = rects[0]!.height;
  for (const rect of rects.slice(1)) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    lineHeight = Math.max(lineHeight, rect.height);
  }
  const style = getComputedStyle(anchor.span);
  return {
    left: left - hostRect.left,
    top: top - hostRect.top,
    width: Math.max(1, right - left),
    height: Math.max(lineHeight, bottom - top),
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    lineHeight: `${lineHeight}px`,
  };
}
