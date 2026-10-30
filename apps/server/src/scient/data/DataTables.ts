// @effect-diagnostics nodeBuiltinImport:off -- a source is keyed by the file's size and mtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DataFileTableError,
  type DataFileTable,
  type DataFileTableInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { openDelimitedSource } from "./DelimitedTableSource.ts";
import { openParquetSource } from "./ParquetTableSource.ts";
import { readTablePage, TableViewCache } from "./TableView.ts";
import {
  readWorkbookSheet,
  WorkbookFormatError,
  workbookTableSource,
} from "./WorkbookTableSource.ts";

/** Indexed sources stay open for paging; each can hold a few hundred megabytes. */
const MAX_OPEN_SOURCES = 3;

type DataFileFormat =
  | { readonly kind: "delimited"; readonly delimiter: string | null }
  | { readonly kind: "parquet" }
  | { readonly kind: "workbook"; readonly workbook: "xlsx" | "ods" };

function dataFileFormat(path: string): DataFileFormat | null {
  switch (NodePath.extname(path).toLowerCase()) {
    case ".csv":
      return { kind: "delimited", delimiter: null };
    case ".tsv":
    case ".tab":
      return { kind: "delimited", delimiter: "\t" };
    case ".parquet":
      return { kind: "parquet" };
    case ".xlsx":
    case ".xlsm":
      return { kind: "workbook", workbook: "xlsx" };
    case ".ods":
      return { kind: "workbook", workbook: "ods" };
    default:
      return null;
  }
}

interface OpenTable {
  readonly view: TableViewCache;
  readonly sheets: ReadonlyArray<string>;
}

async function openTable(
  path: string,
  size: number,
  format: DataFileFormat,
  sheet: number,
  signal: AbortSignal,
): Promise<OpenTable> {
  switch (format.kind) {
    case "delimited":
      return {
        view: new TableViewCache(await openDelimitedSource(path, size, format.delimiter, signal)),
        sheets: [],
      };
    case "parquet":
      return { view: new TableViewCache(await openParquetSource(path)), sheets: [] };
    case "workbook": {
      const read = await readWorkbookSheet(path, format.workbook, sheet);
      return { view: new TableViewCache(workbookTableSource(read)), sheets: read.sheets };
    }
  }
}

function tableError(path: string, cause: unknown): DataFileTableError {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new DataFileTableError({ path, reason: "not_found" });
  if (code === "EACCES" || code === "EPERM")
    return new DataFileTableError({ path, reason: "unreadable" });
  return new DataFileTableError({
    path,
    reason: "invalid",
    ...(cause instanceof WorkbookFormatError ? { detail: cause.message } : {}),
  });
}

export class DataTables extends Context.Service<
  DataTables,
  {
    /** One page of a data file, read in place on this environment. */
    readonly readFileTable: (
      input: DataFileTableInput,
    ) => Effect.Effect<DataFileTable, DataFileTableError>;
  }
>()("t3/scient/data/DataTables") {}

export const make = Effect.sync(() => {
  // A changed file has a new key, so its old index simply ages out.
  const open = new Map<
    string,
    { readonly table: Promise<OpenTable>; readonly abort: () => void }
  >();

  const openCached = async (path: string, format: DataFileFormat, sheet: number) => {
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile()) throw Object.assign(new Error("Not a file."), { code: "ENOTDIR" });
    const key = JSON.stringify([path, sheet, stat.size, stat.mtimeMs]);
    const cached = open.get(key);
    if (cached) {
      open.delete(key);
      open.set(key, cached);
      return cached.table;
    }
    const controller = new AbortController();
    const entry = {
      table: openTable(path, stat.size, format, sheet, controller.signal),
      abort: () => controller.abort(),
    };
    open.set(key, entry);
    entry.table.catch(() => {
      if (open.get(key) === entry) open.delete(key);
    });
    for (const [oldKey, old] of open) {
      if (open.size <= MAX_OPEN_SOURCES) break;
      open.delete(oldKey);
      old.abort();
    }
    return entry.table;
  };

  const readFileTable = Effect.fn("DataTables.readFileTable")(function* (
    input: DataFileTableInput,
  ) {
    const format = dataFileFormat(input.path);
    if (!NodePath.isAbsolute(input.path) || format === null) {
      return yield* new DataFileTableError({ path: input.path, reason: "unsupported" });
    }
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const table = await openCached(input.path, format, input.sheet);
        const page = await readTablePage(table.view, input.query, signal);
        return { ...page, sheets: table.sheets } satisfies DataFileTable;
      },
      catch: (cause) => tableError(input.path, cause),
    });
  });

  return DataTables.of({ readFileTable });
});

export const layer = Layer.effect(DataTables, make);
