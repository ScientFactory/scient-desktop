export interface LatexVisualPaginationBlock {
  readonly top: number;
  readonly bottom: number;
  readonly explicitBreak?: boolean;
  /** Headings and the first/last two lines of a paragraph travel together. */
  readonly keepWithNext?: boolean;
}

export interface LatexVisualPaginationOptions {
  readonly pageHeight: number;
  readonly pageGap: number;
  readonly marginTop: number;
  readonly marginBottom: number;
}

export interface LatexVisualPaginationPlacement {
  readonly page: number;
  readonly offset: number;
  readonly markerOffset: number | null;
}

export interface LatexVisualPaginationPlan {
  readonly pageCount: number;
  readonly placements: readonly LatexVisualPaginationPlacement[];
}

/**
 * Plan pagination over measured lines and indivisible objects. Offsets are
 * presentation only; the source document contains no generated page breaks.
 */
export function planLatexVisualPagination(
  blocks: readonly LatexVisualPaginationBlock[],
  options: LatexVisualPaginationOptions,
): LatexVisualPaginationPlan {
  const contentHeight = Math.max(1, options.pageHeight - options.marginTop - options.marginBottom);
  const stride = options.pageHeight + options.pageGap;
  let page = 0;
  let accumulatedOffset = 0;
  const placements: LatexVisualPaginationPlacement[] = [];

  for (const [index, block] of blocks.entries()) {
    const height = Math.max(0, block.bottom - block.top);
    let top = block.top + accumulatedOffset;
    let bottom = top + height;

    if (block.explicitBreak) {
      const pageStart = page * stride + options.marginTop;
      const hasContentOnPage = top > pageStart + 1;
      const nextPage = page + (hasContentOnPage ? 1 : 0);
      const target = nextPage * stride + options.marginTop;
      const offset = Math.max(0, target - top);
      const previousPageBottom = Math.max(0, nextPage - 1) * stride + options.pageHeight;
      placements.push({
        page: nextPage,
        offset,
        markerOffset: Math.max(0, previousPageBottom + options.pageGap / 2 - top),
      });
      accumulatedOffset += offset;
      page = nextPage;
      continue;
    }

    while (top >= page * stride + options.pageHeight - options.marginBottom) page += 1;
    let pageStart = page * stride + options.marginTop;
    let pageBottom = page * stride + options.pageHeight - options.marginBottom;
    let offset = 0;

    // A browser can naturally place a block in the previous page's bottom
    // margin or in the visual gap between sheets. Advancing `page` alone is
    // not enough: move that block to the next printable origin as well.
    if (top < pageStart) {
      offset = pageStart - top;
      accumulatedOffset += offset;
      top += offset;
      bottom += offset;
    }

    let groupEnd = index;
    while (
      blocks[groupEnd]?.keepWithNext &&
      blocks[groupEnd + 1] &&
      !blocks[groupEnd + 1]!.explicitBreak
    )
      groupEnd += 1;
    const groupHeight = Math.max(height, blocks[groupEnd]!.bottom - block.top);
    const fittingHeight = groupHeight <= contentHeight ? groupHeight : height;
    if (
      top + fittingHeight > pageBottom + 0.5 &&
      top > pageStart + 1 &&
      fittingHeight <= contentHeight
    ) {
      page += 1;
      pageStart = page * stride + options.marginTop;
      pageBottom = page * stride + options.pageHeight - options.marginBottom;
      const pageOffset = Math.max(0, pageStart - top);
      offset += pageOffset;
      accumulatedOffset += pageOffset;
      top += pageOffset;
      bottom += pageOffset;
    }

    const startPage = page;
    page = Math.max(page, Math.floor(Math.max(top, bottom - 0.5) / stride));
    placements.push({ page: startPage, offset, markerOffset: null });
  }

  return { pageCount: Math.max(1, page + 1), placements };
}
