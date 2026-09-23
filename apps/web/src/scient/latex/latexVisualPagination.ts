export interface LatexVisualPaginationBlock {
  readonly top: number;
  readonly bottom: number;
  readonly explicitBreak?: boolean;
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
 * Plan block-level pagination for the editable canvas. The browser still lays
 * out each block; this inserts only the vertical space needed to keep ordinary
 * blocks inside a page and honor explicit LaTeX page breaks.
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

  for (const block of blocks) {
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

    // Keep ordinary editor objects together when they fit on a page. Objects
    // taller than the printable area remain intact rather than being clipped.
    if (bottom > pageBottom && top > pageStart + 1 && height <= contentHeight) {
      page += 1;
      pageStart = page * stride + options.marginTop;
      pageBottom = page * stride + options.pageHeight - options.marginBottom;
      const pageOffset = Math.max(0, pageStart - top);
      offset += pageOffset;
      accumulatedOffset += pageOffset;
      top += pageOffset;
      bottom += pageOffset;
    }

    page = Math.max(page, Math.floor(Math.max(top, bottom - options.marginBottom) / stride));
    placements.push({ page, offset, markerOffset: null });
  }

  return { pageCount: Math.max(1, page + 1), placements };
}
