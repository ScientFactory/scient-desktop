import type { DataTableColumn, DataTableColumnType } from "@t3tools/contracts";

export const ROW_HEIGHT = 28;
export const HEADER_HEIGHT = 40;
/** Chromium stops scrolling an element taller than about 33 million pixels. */
const MAX_TRACK_HEIGHT = 8_000_000;
const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 360;
/** Numbers grow past the first page's sample, so a numeric column starts wide enough for them. */
const MIN_NUMERIC_CHARS = 10;
/** Rows copied at once; a larger selection copies its first rows. */
export const MAX_COPY_ROWS = 10_000;

export const isNumericType = (type: DataTableColumnType) => type === "integer" || type === "number";

/** A width that fits the name, the type and the longest of the sampled cells. */
export function initialColumnWidth(
  column: DataTableColumn,
  cells: ReadonlyArray<string | null>,
): number {
  const longest = cells.reduce(
    (max, cell) => Math.max(max, cell === null ? 0 : Math.min(cell.length, 60)),
    Math.max(
      column.name.length,
      column.label.length + 2,
      isNumericType(column.type) ? MIN_NUMERIC_CHARS : 0,
    ),
  );
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest * 7 + 28)));
}

export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(1200, Math.max(MIN_COLUMN_WIDTH, width)));
}

/**
 * Which rows a scroll position shows. Tall tables scroll a shorter track that maps onto the
 * rows proportionally, so millions of rows stay reachable.
 */
export function rowWindow(input: {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowCount: number;
}) {
  const bodyHeight = Math.max(0, input.viewportHeight - HEADER_HEIGHT);
  const contentHeight = input.rowCount * ROW_HEIGHT;
  const trackHeight = Math.min(contentHeight, MAX_TRACK_HEIGHT);
  const logicalRange = Math.max(0, contentHeight - bodyHeight);
  const trackRange = Math.max(0, trackHeight - bodyHeight);
  const logicalTop =
    trackRange === 0 ? 0 : Math.min(logicalRange, (input.scrollTop / trackRange) * logicalRange);
  const first = Math.floor(logicalTop / ROW_HEIGHT);
  return {
    trackHeight: trackHeight + HEADER_HEIGHT,
    first,
    offset: logicalTop - first * ROW_HEIGHT,
    count: Math.min(input.rowCount - first, Math.ceil(bodyHeight / ROW_HEIGHT) + 1),
    /** The scroll position that puts `row` at the top. */
    scrollTopFor: (row: number) =>
      logicalRange === 0
        ? 0
        : (Math.min(logicalRange, row * ROW_HEIGHT) / logicalRange) * trackRange,
    rowsPerPage: Math.max(1, Math.floor(bodyHeight / ROW_HEIGHT)),
  };
}

/** Columns that overlap the visible width, after the sticky row numbers. */
export function columnWindow(
  offsets: ReadonlyArray<number>,
  scrollLeft: number,
  viewportWidth: number,
): { readonly first: number; readonly end: number } {
  const columns = offsets.length - 1;
  let first = 0;
  while (first < columns && offsets[first + 1]! <= scrollLeft) first++;
  let end = first;
  while (end < columns && offsets[end]! < scrollLeft + viewportWidth) end++;
  return { first, end };
}

/** Tab-separated text a spreadsheet pastes as cells. */
export function tableText(rows: ReadonlyArray<ReadonlyArray<string | null>>): string {
  return rows
    .map((cells) =>
      cells
        .map((cell) => {
          if (cell === null) return "";
          return /[\t\n\r"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
        })
        .join("\t"),
    )
    .join("\n");
}
