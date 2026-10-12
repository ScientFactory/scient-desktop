import type {
  LatexVisualPaginationBlock,
  LatexVisualPaginationOptions,
} from "./latexVisualPagination";

export interface LatexSourceColumnPart extends Pick<LatexVisualPaginationBlock, "stretch"> {
  readonly position: number;
  readonly size: number;
  readonly height: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly keepWithNext: boolean;
  readonly lineHeight?: number;
}

export interface LatexSourceColumnLayout {
  readonly position: number;
  readonly size: number;
  readonly height: number;
  readonly parts: readonly (LatexSourceColumnPart & {
    readonly top: number;
    readonly column: number;
    readonly page: number;
    readonly spanHeight?: number;
    readonly leadingSpace?: number;
  })[];
}

/** Standard twocolumn fills each printable column before advancing. The page
 * origin may follow a full-width title; subsequent sheets regain full height.
 * Positions describe the existing editable nodes, never generated source breaks.
 */
export function planLatexSourceColumns(
  parts: readonly LatexSourceColumnPart[],
  start: number,
  dimensions: LatexVisualPaginationOptions,
) {
  const stride = dimensions.pageHeight + dimensions.pageGap;
  const contentHeight = Math.max(
    1,
    dimensions.pageHeight - dimensions.marginTop - dimensions.marginBottom,
  );
  let page = Math.max(0, Math.floor(start / stride));
  let column = 0;
  let origin = Math.max(start, page * stride + dimensions.marginTop);
  let cursor = origin;
  let previousMargin = 0;
  let height = 0;
  const placements: LatexSourceColumnLayout["parts"][number][] = [];
  for (const [index, part] of parts.entries()) {
    // An indivisible imported object can exceed a sheet. Keep later content
    // after its full extent rather than overlapping it in a reused column.
    if (cursor > page * stride + dimensions.pageHeight - dimensions.marginBottom + 0.5) {
      page = Math.max(page + 1, Math.floor(cursor / stride));
      column = 0;
      origin = page * stride + dimensions.marginTop;
      cursor = Math.max(cursor, origin);
      while (cursor > page * stride + dimensions.pageHeight - dimensions.marginBottom) {
        page++;
        origin = page * stride + dimensions.marginTop;
        cursor = Math.max(cursor, origin);
      }
    }
    const gap = Math.max(previousMargin, part.marginTop);
    let fittingHeight = gap + part.height;
    let end = index;
    while (parts[end]?.keepWithNext && parts[end + 1]) {
      const next = parts[end + 1]!;
      fittingHeight +=
        Math.max(parts[end]!.marginBottom, next.marginTop) +
        (column === 0 && next.lineHeight
          ? Math.min(next.height, next.lineHeight * 2)
          : next.height);
      end++;
    }
    // An oversized keep group must still make progress, preserving its contents.
    if (fittingHeight > contentHeight) fittingHeight = gap + part.height;
    const bottom = page * stride + dimensions.pageHeight - dimensions.marginBottom;
    const textStart = cursor + gap;
    const capacity = bottom - origin;
    if (
      column === 0 &&
      part.lineHeight &&
      part.height >= part.lineHeight * 4 - 0.1 &&
      textStart + part.height > bottom + 0.5 &&
      bottom - textStart >= part.lineHeight * 2 &&
      part.height - (bottom - textStart) <= capacity - part.lineHeight * 2
    ) {
      const firstLines = Math.min(
        Math.floor((bottom - textStart + 0.01) / part.lineHeight),
        Math.ceil(part.height / part.lineHeight) - 2,
      );
      const continuation = part.height - firstLines * part.lineHeight;
      placements.push({
        ...part,
        top: origin - start,
        column,
        page,
        spanHeight: capacity,
        leadingSpace: Math.max(textStart - origin, capacity - firstLines * part.lineHeight),
      });
      column = 1;
      cursor = origin + continuation;
      previousMargin = part.marginBottom;
      height = Math.max(height, bottom - start);
      continue;
    }
    if (cursor + fittingHeight > bottom + 0.5 && cursor > origin + 0.5) {
      column++;
      if (column === 2) {
        column = 0;
        page++;
        origin = page * stride + dimensions.marginTop;
      }
      cursor = origin;
      previousMargin = 0;
    }
    const margin = Math.max(previousMargin, part.marginTop);
    let stretch = 0;
    if (part.stretch) {
      const tail = parts.slice(index);
      let tailHeight = 0;
      let tailMargin = previousMargin;
      for (const item of tail) {
        tailHeight += Math.max(tailMargin, item.marginTop) + item.height;
        tailMargin = item.marginBottom;
      }
      tailHeight += tailMargin;
      const fills = tail.filter((item) => item.stretch).length;
      stretch = Math.max(0, bottom - cursor - tailHeight) / Math.max(1, fills);
    }
    placements.push({
      ...part,
      height: part.height + stretch,
      top: cursor + margin - start,
      column,
      page,
    });
    cursor += margin + part.height + stretch;
    previousMargin = part.marginBottom;
    height = Math.max(height, cursor + part.marginBottom - start);
  }
  return { parts: placements, height };
}
