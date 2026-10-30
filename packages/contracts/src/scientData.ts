import {
  dataTablePageRows,
  DataTableColumn,
  DataTableColumnType,
  DataTablePage,
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

/** One page of a table-like value in a live compute session, read without entering history. */
export const ComputeTableInput = Schema.Struct({
  ...ComputeProjectSessionCommandInput.fields,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  query: DataTableQuery,
});
export type ComputeTableInput = typeof ComputeTableInput.Type;

export {
  dataTablePageRows,
  DataTableColumn,
  DataTableColumnType,
  DataTablePage,
  DataTableQuery,
  DataTableRow,
  DataTableSort,
};
