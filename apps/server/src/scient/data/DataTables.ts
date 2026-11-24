// @effect-diagnostics nodeBuiltinImport:off -- a source is keyed by the file's size and mtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { DATA_TABLE_MAX_COLUMNS, type DataTableTotals } from "@scientfactory/compute";

import {
  DataFileTableError,
  type DataFileTable,
  type DataFileTableInput,
  type DataFileProfileInput,
  type DataProfileEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { openDelimitedSource } from "./DelimitedTableSource.ts";
import { openParquetSource } from "./ParquetTableSource.ts";
import {
  profileTableSource,
  wholeTableProfile,
  type WholeColumnStatistics,
} from "./TableProfile.ts";
import { readTablePage, type TableSource, TableViewCache } from "./TableView.ts";
import {
  readWorkbookSheet,
  WorkbookFormatError,
  workbookTableSource,
} from "./WorkbookTableSource.ts";

const isWorkbookFormatError = Schema.is(WorkbookFormatError);

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
    ...(isWorkbookFormatError(cause) ? { detail: cause.message } : {}),
  });
}

type AggregateProfile = (
  source: TableSource,
  footer: ReadonlyArray<WholeColumnStatistics | undefined> | undefined,
) => Effect.Effect<DataTableTotals | null>;

export class DataTables extends Context.Service<
  DataTables,
  {
    readonly openFileTable: (
      path: string,
      sheet: number,
    ) => Effect.Effect<OpenTable, DataFileTableError>;
    readonly profileFile: (
      input: DataFileProfileInput,
      aggregate?: AggregateProfile,
    ) => Stream.Stream<DataProfileEvent, DataFileTableError>;
    /** One page of a data file, read in place on this environment. */
    readonly readFileTable: (
      input: DataFileTableInput,
    ) => Effect.Effect<DataFileTable, DataFileTableError>;
  }
>()("t3/scient/data/DataTables") {}

const cacheKey = (
  path: string,
  sheet: number,
  stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
) => JSON.stringify([path, sheet, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);

const make = Effect.sync(() => {
  // A changed file has a new key, so its old index simply ages out.
  const open = new Map<
    string,
    { readonly table: Promise<OpenTable>; readonly abort: () => void }
  >();

  const openCached = async (path: string, format: DataFileFormat, sheet: number) => {
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile()) throw Object.assign(new Error("Not a file."), { code: "ENOTDIR" });
    const key = cacheKey(path, sheet, stat);
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

  const openFileTable = Effect.fn("DataTables.openFileTable")(function* (
    path: string,
    sheet: number,
  ) {
    const format = dataFileFormat(path);
    if (!NodePath.isAbsolute(path) || format === null) {
      return yield* new DataFileTableError({ path, reason: "unsupported" });
    }
    return yield* Effect.tryPromise({
      try: () => openCached(path, format, sheet),
      catch: (cause) => tableError(path, cause),
    });
  });

  const readFileTable = Effect.fn("DataTables.readFileTable")(function* (
    input: DataFileTableInput,
  ) {
    const table = yield* openFileTable(input.path, input.sheet);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const page = await readTablePage(table.view, input.query, signal);
        return { ...page, sheets: table.sheets } satisfies DataFileTable;
      },
      catch: (cause) => tableError(input.path, cause),
    });
  });

  const openForProfile = Effect.fn("DataTables.openForProfile")(function* (
    input: DataFileProfileInput,
  ) {
    const format = dataFileFormat(input.path);
    if (!NodePath.isAbsolute(input.path) || format === null) {
      return yield* new DataFileTableError({ path: input.path, reason: "unsupported" });
    }
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const stat = await NodeFSP.stat(input.path);
        if (!stat.isFile()) throw Object.assign(new Error("Not a file."), { code: "ENOTDIR" });
        const key = cacheKey(input.path, input.sheet, stat);
        const table = await (open.get(key)?.table ??
          openTable(input.path, stat.size, format, input.sheet, signal));
        return { source: table.view.source, key };
      },
      catch: (cause) => tableError(input.path, cause),
    });
  });

  const profileFile = (input: DataFileProfileInput, aggregate?: AggregateProfile) =>
    Stream.concat(
      Stream.succeed<DataProfileEvent>({
        _tag: "Progress",
        rowsProfiled: 0,
        rowCount: null,
        target: null,
      }),
      Stream.unwrap(
        openForProfile(input).pipe(
          Effect.map(({ source, key }) =>
            Stream.callback<DataProfileEvent, DataFileTableError>((queue) =>
              Effect.gen(function* () {
                const footer = source.profileStatistics?.();
                const totals = aggregate === undefined ? null : yield* aggregate(source, footer);
                const profile =
                  totals?.rowCount === source.rowCount &&
                  totals.columns.length === Math.min(source.columns.length, DATA_TABLE_MAX_COLUMNS)
                    ? wholeTableProfile(source.columns, source.columns.length, totals, footer)
                    : yield* Effect.tryPromise({
                        try: (signal) =>
                          profileTableSource(
                            source,
                            signal,
                            (event) => {
                              Queue.offerUnsafe(queue, event);
                            },
                            footer,
                          ),
                        catch: (cause) => tableError(input.path, cause),
                      });
                const stat = yield* Effect.tryPromise({
                  try: () => NodeFSP.stat(input.path),
                  catch: (cause) => tableError(input.path, cause),
                });
                if (cacheKey(input.path, input.sheet, stat) !== key) {
                  return yield* new DataFileTableError({
                    path: input.path,
                    reason: "invalid",
                    detail: "The file changed during profiling. Open the profile again.",
                  });
                }
                Queue.offerUnsafe(queue, { _tag: "Complete", profile });
                Queue.endUnsafe(queue);
              }),
            ),
          ),
        ),
      ),
    );

  return DataTables.of({ openFileTable, readFileTable, profileFile });
});

export const layer = Layer.effect(DataTables, make);
