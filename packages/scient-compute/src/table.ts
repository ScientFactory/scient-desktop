import * as Schema from "effect/Schema";

import { Count, Label, ShortText } from "./primitives.ts";

/**
 * One page of a table, whether it comes from a data file or a live kernel value. Pages carry
 * display text only: values are formatted where they live and never travel whole.
 */
export const DATA_TABLE_MAX_COLUMNS = 1024;
export const DATA_TABLE_MAX_PAGE_ROWS = 200;
export const DATA_TABLE_MAX_CELL_LENGTH = 200;
const DATA_TABLE_MAX_PAGE_CELLS = 16_384;

/** Rows per page for a table this wide; producers and the grid page by the same rule. */
export function dataTablePageRows(columns: number): number {
  return Math.max(
    1,
    Math.min(DATA_TABLE_MAX_PAGE_ROWS, Math.floor(DATA_TABLE_MAX_PAGE_CELLS / Math.max(1, columns))),
  );
}

/** Display text for one cell, cut to the page bound. */
export function dataTableCellText(text: string): string {
  return text.length > DATA_TABLE_MAX_CELL_LENGTH
    ? `${text.slice(0, DATA_TABLE_MAX_CELL_LENGTH)}…`
    : text;
}

export const DataTableColumnType = Schema.Literals([
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "text",
  "other",
]);
export type DataTableColumnType = typeof DataTableColumnType.Type;

export const DataTableColumn = Schema.Struct({
  name: ShortText,
  type: DataTableColumnType,
  /** The source's own name for the type, such as `int64` or `float`. */
  label: Label,
});
export type DataTableColumn = typeof DataTableColumn.Type;

export const DataTableSort = Schema.Struct({
  column: Count,
  descending: Schema.Boolean,
});
export type DataTableSort = typeof DataTableSort.Type;

export const DataTableQuery = Schema.Struct({
  offset: Count,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DATA_TABLE_MAX_PAGE_ROWS })),
  sort: Schema.NullOr(DataTableSort),
  /** Case-insensitive text a row must contain in one of its cells. */
  search: Schema.String.check(Schema.isMaxLength(256)),
});
export type DataTableQuery = typeof DataTableQuery.Type;

const CellText = Schema.String.check(Schema.isMaxLength(DATA_TABLE_MAX_CELL_LENGTH + 1));

export const DataTableRow = Schema.Struct({
  /** The row's own name: its number in a file, its index label in a data frame. */
  label: Label,
  /** Null is a missing value. */
  cells: Schema.Array(Schema.NullOr(CellText)).check(Schema.isMaxLength(DATA_TABLE_MAX_COLUMNS)),
});
export type DataTableRow = typeof DataTableRow.Type;

export const DataTablePage = Schema.Struct({
  /** The first {@link DATA_TABLE_MAX_COLUMNS} columns; `columnCount` counts them all. */
  columns: Schema.Array(DataTableColumn).check(Schema.isMaxLength(DATA_TABLE_MAX_COLUMNS)),
  columnCount: Count,
  rowCount: Count,
  /** Rows matching the search; equal to `rowCount` without one. */
  matchCount: Count,
  /** Only the first `rowCount` rows of a larger source can be shown. */
  truncated: Schema.Boolean,
  offset: Count,
  rows: Schema.Array(DataTableRow).check(Schema.isMaxLength(DATA_TABLE_MAX_PAGE_ROWS)),
});
export type DataTablePage = typeof DataTablePage.Type;
