import {
  dataTableCellText,
  dataTablePageRows,
  DataTableColumn,
  DataTableColumnType,
  DataTablePage,
  DataTableMinimum,
  DataTableQuery,
  DataTableRow,
  DataTableSort,
} from "@scientfactory/compute";
import * as Schema from "effect/Schema";

import { ComputeProjectSessionCommandInput } from "./scientCompute.ts";

const DataFilePath = Schema.NonEmptyString.check(Schema.isMaxLength(4096));

/** One page of a data file the environment reads in place; `path` is absolute on that host. */
export const DataFileTableInput = Schema.Struct({
  path: DataFilePath,
  /** Zero-based worksheet of a workbook; other formats have one table. */
  sheet: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  query: DataTableQuery,
});
export type DataFileTableInput = typeof DataFileTableInput.Type;

export const DataFileProfileInput = Schema.Struct({
  path: DataFileTableInput.fields.path,
  sheet: DataFileTableInput.fields.sheet,
  sampleOnly: Schema.optional(Schema.Boolean),
});
export type DataFileProfileInput = typeof DataFileProfileInput.Type;

const RowCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const DataColumnProfile = Schema.Struct({
  columnIndex: RowCount,
  column: DataTableColumn,
  missing: RowCount,
  nanCount: Schema.optional(RowCount),
  missingShare: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  missingFromFooter: Schema.Boolean,
  distinct: RowCount,
  distinctFromFooter: Schema.Boolean,
  distinctApproximate: Schema.optional(Schema.Boolean),
  distinctLowerBound: Schema.Boolean,
  valuesClipped: Schema.Boolean,
  range: Schema.NullOr(Schema.Struct({ min: Schema.String, max: Schema.String })),
  rangeFromFooter: Schema.Boolean,
  topTracked: Schema.Boolean,
  topApproximate: Schema.optional(Schema.Boolean),
  top: Schema.Array(Schema.Struct({ value: Schema.String, count: RowCount })),
});

export const DataProfile = Schema.Struct({
  scope: Schema.Literals(["all", "sample"]),
  rowsProfiled: RowCount,
  rowCount: Schema.NullOr(RowCount),
  columnCount: RowCount,
  columns: Schema.Array(DataColumnProfile),
});
export type DataProfile = typeof DataProfile.Type;

export const DataProfileEvent = Schema.Union([
  Schema.TaggedStruct("Progress", {
    rowsProfiled: RowCount,
    rowCount: Schema.NullOr(RowCount),
    target: Schema.NullOr(RowCount),
  }),
  Schema.TaggedStruct("Complete", { profile: DataProfile }),
]);
export type DataProfileEvent = typeof DataProfileEvent.Type;

export const DataFileTable = Schema.Struct({
  ...DataTablePage.fields,
  sheets: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(4096),
  ),
});
export type DataFileTable = typeof DataFileTable.Type;

export class DataFileTableError extends Schema.TaggedError<DataFileTableError>()(
  "DataFileTableError",
  {
    path: DataFilePath,
    reason: Schema.Literals(["not_found", "unreadable", "unsupported", "invalid"]),
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The file no longer exists.";
      case "unreadable":
        return "The file cannot be read.";
      case "unsupported":
        return "This file is not a data table Scient can show.";
      case "invalid":
        return this.detail ?? "The file could not be read as a table.";
    }
  }
}

export const DataViewRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const DataViewAddress = Schema.Struct({ cwd: DataFilePath, path: DataFilePath });
export const DataViewInput = Schema.Struct({
  ...DataViewAddress.fields,
  revision: Schema.optional(DataViewRevision),
});
export type DataViewInput = typeof DataViewInput.Type;

export const DataViewPageInput = Schema.Struct({ ...DataViewInput.fields, query: DataTableQuery });
export type DataViewPageInput = typeof DataViewPageInput.Type;

export const DataViewPage = Schema.Struct({ ...DataTablePage.fields, revision: DataViewRevision });
export type DataViewPage = typeof DataViewPage.Type;

export const DataViewFilter = Schema.Struct({
  search: DataTableQuery.fields.search,
  sort: DataTableQuery.fields.sort,
  minimum: DataTableQuery.fields.minimum,
});
export type DataViewFilter = typeof DataViewFilter.Type;

export const DataViewSaveInput = Schema.Struct({
  ...DataViewAddress.fields,
  destination: DataFilePath,
  ...DataViewFilter.fields,
  columns: Schema.Array(RowCount).check(Schema.isMaxLength(1024)),
});
export type DataViewSaveInput = typeof DataViewSaveInput.Type;

export const DataViewMaterializeInput = Schema.Struct({
  ...DataViewInput.fields,
  destination: DataFilePath,
  filter: Schema.optional(DataViewFilter),
});
export type DataViewMaterializeInput = typeof DataViewMaterializeInput.Type;

export class DataViewError extends Schema.TaggedError<DataViewError>()("DataViewError", {
  reason: Schema.Literals([
    "workspace-unavailable",
    "source-unavailable",
    "source-missing",
    "source-untraced",
    "view-changed",
    "destination-exists",
    "invalid-path",
    "invalid-columns",
    "search-not-saved",
    "query-required",
    "query-failed",
    "query-timeout",
    "runner-failed",
    "runtime-unavailable",
    "write-failed",
  ]),
  reference: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "workspace-unavailable":
        return "Scient could not open this project folder.";
      case "source-unavailable":
        return "One of the view’s data files could not be read in this project.";
      case "source-missing":
        return this.reference
          ? `Data file not found: ${this.reference}`
          : "A data file for this view is missing.";
      case "view-changed":
        return "This view changed. Reload the rows and try again.";
      case "source-untraced":
        return this.reference
          ? `Scient couldn’t trace this view’s input: ${this.reference}`
          : "Scient couldn’t trace a file this view reads.";
      case "destination-exists":
        return "A file already exists at this destination.";
      case "invalid-path":
        return "Choose a valid path inside the project.";
      case "invalid-columns":
        return "Choose columns with unique names.";
      case "search-not-saved":
        return "Search isn’t saved: Scient couldn’t verify that DuckDB returns the same rows as the grid.";
      case "query-required":
        return "A saved view needs one DuckDB SELECT query.";
      case "query-failed":
        return "DuckDB couldn’t run the view’s SQL.";
      case "query-timeout":
        return "DuckDB timed out while running the view.";
      case "runner-failed":
        return "The DuckDB process stopped before returning a result.";
      case "runtime-unavailable":
        return "DuckDB could not start. Check the SQL runtime in Settings.";
      case "write-failed":
        return "Scient could not write the new file.";
    }
  }
}

/** One page of a table-like value in a live compute session, read without entering history. */
export const ComputeTableInput = Schema.Struct({
  ...ComputeProjectSessionCommandInput.fields,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  query: DataTableQuery,
});
export type ComputeTableInput = typeof ComputeTableInput.Type;
export const ComputeTableProfileInput = Schema.Struct({
  ...ComputeProjectSessionCommandInput.fields,
  name: ComputeTableInput.fields.name,
});

export {
  dataTableCellText,
  dataTablePageRows,
  DataTableMinimum,
  DataTableColumn,
  DataTableColumnType,
  DataTablePage,
  DataTableQuery,
  DataTableRow,
  DataTableSort,
};
