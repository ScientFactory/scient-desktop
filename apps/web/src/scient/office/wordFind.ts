import type { DisplayPage } from "@betteroffice/docx/layout/render";

/** A page with matches, in reading order. */
export type OfficeFindHit = { readonly index: number; readonly count: number };

/** The first body position a page holds: from its layout while unbuilt, from its text once built. */
function firstPosition(page: DisplayPage): number | undefined {
  if (page.unbuilt) return page.positionSpan?.[0];
  let first: number | undefined;
  for (const primitive of page.primitives.slice(page.watermarkPrimitiveCount ?? 0)) {
    const start =
      primitive.kind === "glyphRun" || primitive.kind === "text" ? primitive.docStart : undefined;
    if (start !== undefined && (first === undefined || start < first)) first = start;
  }
  return first;
}

/**
 * Counts body matches, given as document positions, on the page that holds each: the last page
 * whose first position is at or before it, or the first page. Pages without body text hold none.
 */
export function wordFindHits(
  pages: readonly DisplayPage[],
  positions: readonly number[],
): OfficeFindHit[] {
  const starts = pages.flatMap((page, index) => {
    const first = firstPosition(page);
    return first === undefined ? [] : [{ index, first }];
  });
  const hits: OfficeFindHit[] = [];
  let page = -1;
  for (const position of positions.toSorted((left, right) => left - right)) {
    while (page + 1 < starts.length && starts[page + 1]!.first <= position) page++;
    // Before the first text a page's layout placed, such as in a heading's numbering.
    const index = starts[Math.max(page, 0)]?.index;
    if (index === undefined) continue;
    const last = hits.at(-1);
    if (last?.index === index) hits[hits.length - 1] = { index, count: last.count + 1 };
    else hits.push({ index, count: 1 });
  }
  return hits;
}
