// @effect-diagnostics nodeBuiltinImport:off -- uses exclusive creation and checks project-relative file paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { DATA_TABLE_MAX_COLUMNS, type DataTableColumnType } from "@scientfactory/compute";
import {
  DataViewError,
  type DataFileProfileInput,
  type DataFileTableError,
  type DataProfileEvent,
  type DataProfile,
  type DataViewPage,
  type DataViewInput,
  type DataViewMaterializeInput,
  type DataViewPageInput,
  type DataViewSaveInput,
} from "@t3tools/contracts";
import {
  expandSavedViewGlobs,
  isSavedDataView,
  savedViewReferences,
} from "@t3tools/shared/savedDataView";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { mediaFileRevision } from "../../assets/MediaFile.ts";

import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import { workspaceEntryDisposition } from "../workspace/WorkspaceEntryPolicy.ts";
import { DataTables } from "./DataTables.ts";
import { makeDataViewRuntime } from "./DataViewRuntime.ts";
import { filteredTableRows, type TableSource } from "./TableView.ts";
import { profileTablePage } from "./TableProfile.ts";

const MAX_SQL_BYTES = 64 * 1024;
const MAX_GLOB_MATCHES = 2_048;
const UNSUPPORTED_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);
const dataViewError = Schema.is(DataViewError);

const failure = (reason: DataViewError["reason"]) => (cause: unknown) =>
  dataViewError(cause) ? cause : new DataViewError({ reason, cause });

const missingFile = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const writeFailure = (cause: unknown) =>
  failure(
    (cause as NodeJS.ErrnoException | null)?.code === "EEXIST"
      ? "destination-exists"
      : "write-failed",
  )(cause);

function projectPath(root: string, relative: string): string {
  if (
    relative.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\\:\u0000-\u001f]/u.test(relative)
  ) {
    throw new DataViewError({ reason: "invalid-path" });
  }
  return NodePath.join(root, ...relative.split("/"));
}

/** A path used by a view must name a regular file directly in this project. */
async function sourceInfo(root: string, relative: string) {
  const path = projectPath(root, relative);
  if ((await NodeFSP.realpath(path)) !== path)
    throw new DataViewError({ reason: "source-unavailable" });
  const stat = await NodeFSP.stat(path, { bigint: true });
  if (!stat.isFile()) throw new DataViewError({ reason: "source-unavailable" });
  return { path, revision: mediaFileRevision(stat) };
}

async function sourceFile(root: string, relative: string) {
  return (await sourceInfo(root, relative)).path;
}

async function destinationFile(root: string, relative: string) {
  const target = projectPath(root, relative);
  if (workspaceEntryDisposition(relative).mutation === "owner")
    throw new DataViewError({ reason: "invalid-path" });
  let directory = root;
  for (const part of relative.split("/").slice(0, -1)) {
    directory = NodePath.join(directory, part);
    await NodeFSP.mkdir(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if (
      (await NodeFSP.realpath(directory)) !== directory ||
      !(await NodeFSP.stat(directory)).isDirectory()
    )
      throw new DataViewError({ reason: "invalid-path" });
  }
  return target;
}

async function resolveGlob(
  root: string,
  pattern: string,
  sources: Map<string, string>,
  signal: AbortSignal,
) {
  const untraced = () =>
    new DataViewError({ reason: "source-untraced", reference: pattern.slice(0, 4096) });
  projectPath(root, pattern);
  const files: string[] = [];
  for await (const entry of NodeFSP.glob(pattern, { cwd: root, withFileTypes: true })) {
    signal.throwIfAborted();
    if (entry.isDirectory()) continue;
    const relative = NodePath.relative(
      root,
      NodePath.join(entry.parentPath, entry.name),
    ).replaceAll(NodePath.sep, "/");
    if (files.length === MAX_GLOB_MATCHES || /[*?[]/u.test(relative)) throw untraced();
    try {
      sources.set(relative, (await sourceInfo(root, relative)).revision);
    } catch {
      throw untraced();
    }
    files.push(relative);
  }
  return files.sort();
}

async function readSql(root: string, path: string, signal: AbortSignal) {
  if (!isSavedDataView(path)) throw new DataViewError({ reason: "invalid-path" });
  const absolutePath = await sourceFile(root, path);
  const buffer = new Uint8Array(MAX_SQL_BYTES + 1);
  const file = await NodeFSP.open(absolutePath, "r");
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0).finally(() => file.close());
  signal.throwIfAborted();
  if (bytesRead > MAX_SQL_BYTES) throw new DataViewError({ reason: "query-required" });
  const sql = new TextDecoder().decode(buffer.subarray(0, bytesRead));
  const sources = new Map<string, string>();
  const missingSources = new Set<string>();
  for (const relative of savedViewReferences(sql).files) {
    signal.throwIfAborted();
    try {
      sources.set(relative, (await sourceInfo(root, relative)).revision);
    } catch (cause) {
      // Dataset-like literals can appear in predicates. Report only failed reads.
      if (missingFile(cause)) missingSources.add(relative);
    }
  }
  const expansions = new Map<string, ReadonlyArray<string>>();
  const rewritten = await expandSavedViewGlobs(sql, async (pattern) => {
    const cached = expansions.get(pattern);
    if (cached !== undefined) return cached;
    const files = await resolveGlob(root, pattern, sources, signal);
    expansions.set(pattern, files);
    if (files.length === 0) missingSources.add(pattern);
    return files;
  });
  const revision = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([sql, [...sources].sort(), [...expansions], [...missingSources].sort()]))
    .digest("hex");
  return {
    sql: rewritten,
    sources: [...sources.keys()],
    missingSources: [...missingSources],
    revision,
  };
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function viewSql(input: DataViewSaveInput, table: TableSource) {
  const columnInfo = table.columns;
  const names = columnInfo.map((column) => column.name);
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  if (names.length > DATA_TABLE_MAX_COLUMNS || lowerNames.size !== names.length)
    throw new DataViewError({ reason: "invalid-columns" });
  const indices = [...new Set(input.columns)];
  if (
    indices.some((index) => names[index] === undefined) ||
    (input.sort !== null && names[input.sort.column] === undefined) ||
    (input.minimum !== undefined &&
      !["integer", "number"].includes(columnInfo[input.minimum.column]?.type ?? ""))
  )
    throw new DataViewError({ reason: "invalid-columns" });
  const source = literal(input.path);
  const needle = input.search.trim().toLowerCase();
  if (needle && (table.delimiter === undefined || !names.length))
    throw new DataViewError({ reason: "search-not-saved" });
  const raw = needle !== "" && table.delimiter !== undefined;
  let ordinal = "_scient_source_row";
  while (lowerNames.has(ordinal)) ordinal += "_";
  const ordinalColumn = identifier(ordinal);
  const fields = names.map(identifier);
  const relation = raw
    ? `read_csv(${source}, header = true, delim = ${literal(table.delimiter!)}, quote = '"', escape = '"', all_varchar = true, null_padding = true) WITH ORDINALITY AS source(${[...fields, ordinalColumn].join(", ")})`
    : /\.(tsv|tab)$/iu.test(input.path)
      ? `read_csv(${source}, header = true, delim = '${"\t"}')`
      : source;
  const select =
    indices.length > 0
      ? indices.map((index) => fields[index]!).join(", ")
      : raw
        ? fields.join(", ")
        : "*";
  const conditions: string[] = [];
  if (needle && names.length) {
    const search = fields.map((field) => `contains(lower(${field}), ${literal(needle)})`);
    conditions.push(`(${search.join(" OR ")})`);
  }
  if (input.minimum) {
    const name = identifier(names[input.minimum.column]!);
    const number = `TRY_CAST(${name} AS DOUBLE)`;
    conditions.push(`${number} >= ${input.minimum.value} AND NOT isnan(${number})`);
  }
  if (raw && table.truncated) conditions.push(`${ordinalColumn} <= ${table.rowCount}`);
  const from = `\nFROM ${relation}`;
  const where = conditions.length ? `\nWHERE ${conditions.join(" AND ")}` : "";
  let order = raw ? `\nORDER BY ${ordinalColumn}` : "";
  if (input.sort !== null) {
    const field = fields[input.sort.column]!;
    const type = columnInfo[input.sort.column]!.type;
    const value = raw
      ? type === "integer" || type === "number"
        ? `NULLIF(TRY_CAST(${field} AS DOUBLE), 'NaN'::DOUBLE)`
        : `NULLIF(${field}, '')`
      : field;
    order = `\nORDER BY ${value} ${input.sort.descending ? "DESC" : "ASC"} NULLS LAST${raw ? `, ${ordinalColumn}` : ""}`;
  }
  return {
    sql: `SELECT ${select}${from}${where}${order};\n`,
    checkSql: raw ? `SELECT ${ordinalColumn}${from}${where} ORDER BY ${ordinalColumn}` : null,
    countSql: raw && !table.truncated ? `SELECT count(*)${from}` : null,
  };
}

function columnType(label: string): DataTableColumnType {
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|VARINT|BIGNUM)$/u.test(label)) return "integer";
  if (/^(DECIMAL|FLOAT|DOUBLE|REAL)/u.test(label)) return "number";
  if (label === "BOOLEAN") return "boolean";
  if (label === "DATE") return "date";
  if (label.startsWith("TIMESTAMP")) return "datetime";
  return label === "VARCHAR" ? "text" : "other";
}

export class DataViews extends Context.Service<
  DataViews,
  {
    readonly profileFile: (
      input: DataFileProfileInput,
    ) => Stream.Stream<DataProfileEvent, DataFileTableError>;
    readonly viewRevision: (input: DataViewInput) => Effect.Effect<string, DataViewError>;
    readonly readView: (input: DataViewPageInput) => Effect.Effect<DataViewPage, DataViewError>;
    readonly profileDataset: (
      input: DataViewInput & { readonly sheet?: number },
    ) => Effect.Effect<DataProfile, DataViewError>;
    readonly profileView: (input: DataViewInput) => Effect.Effect<DataProfile, DataViewError>;
    readonly saveView: (input: DataViewSaveInput) => Effect.Effect<{ path: string }, DataViewError>;
    readonly materializeView: (
      input: DataViewMaterializeInput,
    ) => Effect.Effect<{ path: string }, DataViewError>;
  }
>()("t3/scient/data/DataViews") {}

const make = Effect.gen(function* () {
  const workspace = yield* WorkspaceBindingResolver;
  const tables = yield* DataTables;
  const fs = yield* FileSystem.FileSystem;
  const run = yield* makeDataViewRuntime;
  const rootFor = Effect.fn("DataViews.projectRoot")(function* (cwd: string) {
    const { binding } = yield* workspace
      .resolveWorkspaceRoot(cwd)
      .pipe(Effect.mapError(failure("workspace-unavailable")));
    return binding.canonicalRoot;
  });
  const load = Effect.fn("DataViews.loadSql")(function* (root: string, path: string) {
    return yield* Effect.tryPromise({
      try: (signal) => readSql(root, path, signal),
      catch: (cause) =>
        missingFile(cause)
          ? new DataViewError({ reason: "source-missing", reference: path })
          : failure("source-unavailable")(cause),
    });
  });
  const viewRevision = Effect.fn("DataViews.viewRevision")(function* (input: DataViewInput) {
    const root = yield* rootFor(input.cwd);
    return (yield* load(root, input.path)).revision;
  });

  const changedView = () => new DataViewError({ reason: "view-changed" });
  const loadPinned = Effect.fn("DataViews.loadPinned")(function* (
    root: string,
    input: DataViewInput,
  ) {
    const view = yield* load(root, input.path).pipe(
      Effect.mapError((error) => (input.revision === undefined ? error : changedView())),
    );
    if (input.revision !== undefined && input.revision !== view.revision)
      return yield* changedView();
    return view;
  });
  const runPinned = Effect.fn("DataViews.runPinned")(function* (
    root: string,
    path: string,
    revision: string,
    options: Parameters<typeof run>[1],
  ) {
    const result = yield* run(root, options).pipe(Effect.result);
    const current = yield* load(root, path).pipe(Effect.mapError(changedView));
    if (current.revision !== revision) return yield* changedView();
    return yield* Effect.fromResult(result);
  });

  const readViewPage = Effect.fn("DataViews.readViewPage")(function* (input: DataViewPageInput) {
    const root = yield* rootFor(input.cwd);
    const { revision, ...options } = yield* loadPinned(root, input);
    const result = yield* runPinned(root, input.path, revision, { ...options, query: input.query });
    if (result.kind !== "page") return yield* new DataViewError({ reason: "query-failed" });
    const { names, types, columnCount, rowCount, matchCount, rows, clippedColumns } = result.page;
    const page = {
      columns: names.map((name, index) => {
        const label = types[index] ?? "unknown";
        return { name, label: label.slice(0, 256), type: columnType(label) };
      }),
      rowCount,
      columnCount,
      matchCount,
      rows: rows.map((cells, index) => ({
        label: String(input.query.offset + index + 1),
        cells,
      })),
      offset: input.query.offset,
      truncated: false,
      revision,
    } satisfies DataViewPage;
    return { page, clippedColumns };
  }, Effect.scoped);

  const readView = (input: DataViewPageInput) =>
    readViewPage(input).pipe(Effect.map(({ page }) => page));

  const profileView = Effect.fn("DataViews.profileView")(function* (input: DataViewInput) {
    const { page, clippedColumns } = yield* readViewPage({
      ...input,
      query: { offset: 0, limit: 200, search: "", sort: null },
    });
    return profileTablePage(page, { clippedColumns, countNaN: true });
  });

  const profileFile = (input: DataFileProfileInput) =>
    tables.profileFile(
      input,
      !input.sampleOnly && /\.parquet$/iu.test(input.path)
        ? (source, metadata) => {
            const profilePath = NodePath.basename(input.path);
            const columns = source.columns.slice(0, DATA_TABLE_MAX_COLUMNS);
            return run(NodePath.dirname(input.path), {
              profilePath,
              sources: [profilePath],
              numeric: columns.map(({ type }) => type === "integer" || type === "number"),
              footer: columns.map((_, index) => [
                metadata?.[index]?.missing !== undefined,
                metadata?.[index]?.range !== undefined,
              ]),
            }).pipe(
              Effect.map((result) => (result.kind === "profile" ? result.profile : null)),
              Effect.orElseSucceed(() => null),
              Effect.scoped,
            );
          }
        : undefined,
    );

  const profileDataset = Effect.fn("DataViews.profileDataset")(function* (
    input: DataViewInput & { readonly sheet?: number },
  ) {
    if (isSavedDataView(input.path)) return yield* profileView(input);
    const root = yield* rootFor(input.cwd);
    const path = yield* Effect.tryPromise({
      try: () => sourceFile(root, input.path),
      catch: failure("source-unavailable"),
    });
    const last = yield* profileFile({ path, sheet: input.sheet ?? 0 }).pipe(
      Stream.runLast,
      Effect.mapError(failure("source-unavailable")),
    );
    if (Option.isSome(last) && last.value._tag === "Complete") return last.value.profile;
    return yield* new DataViewError({ reason: "source-unavailable" });
  });

  const stageFile = Effect.fn("DataViews.stageFile")(function* (target: string) {
    if (yield* fs.exists(target).pipe(Effect.mapError(writeFailure))) {
      return yield* new DataViewError({ reason: "destination-exists" });
    }
    const directory = yield* fs
      .makeTempDirectoryScoped({
        directory: NodePath.dirname(target),
        prefix: ".scient-derived-",
      })
      .pipe(Effect.mapError(writeFailure));
    return NodePath.join(directory, "table.tmp");
  });

  const publish = Effect.fn("DataViews.publish")(function* (staged: string, target: string) {
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.link(staged, target);
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | null)?.code;
          if (code === undefined || !UNSUPPORTED_LINK.has(code)) throw cause;
          await NodeFSP.copyFile(staged, target, NodeFSP.constants.COPYFILE_EXCL);
        }
      },
      catch: writeFailure,
    });
  });

  const saveView = Effect.fn("DataViews.saveView")(function* (input: DataViewSaveInput) {
    if (!/\.(csv|tsv|tab|parquet)$/iu.test(input.path) || !isSavedDataView(input.destination))
      return yield* new DataViewError({ reason: "invalid-path" });
    const root = yield* rootFor(input.cwd);
    const path = yield* Effect.tryPromise({
      try: () => sourceFile(root, input.path),
      catch: failure("source-unavailable"),
    });
    const before = yield* fs.stat(path).pipe(Effect.mapError(failure("source-unavailable")));
    const { view } = yield* tables
      .openFileTable(path, 0)
      .pipe(Effect.mapError(failure("source-unavailable")));
    const { sql, checkSql, countSql } = yield* Effect.try({
      try: () => viewSql(input, view.source),
      catch: writeFailure,
    });
    if (checkSql !== null) {
      const expected = yield* Effect.tryPromise({
        try: async (signal) => {
          const rows = (await filteredTableRows(view, input, signal))!;
          return NodeCrypto.createHash("sha256")
            .update(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength))
            .digest("hex");
        },
        catch: failure("search-not-saved"),
      });
      const checked = yield* run(root, { sql: checkSql, sources: [input.path], countSql }).pipe(
        Effect.mapError(() => new DataViewError({ reason: "search-not-saved" })),
      );
      const after = yield* fs.stat(path).pipe(Effect.mapError(failure("source-unavailable")));
      if (
        checked.kind !== "check" ||
        checked.digest !== expected ||
        (countSql !== null && checked.rowCount !== view.source.rowCount) ||
        before.size !== after.size ||
        Option.getOrUndefined(Option.map(before.mtime, (date) => date.getTime())) !==
          Option.getOrUndefined(Option.map(after.mtime, (date) => date.getTime()))
      )
        return yield* new DataViewError({ reason: "search-not-saved" });
    }
    const target = yield* Effect.tryPromise({
      try: () => destinationFile(root, input.destination),
      catch: writeFailure,
    });
    const staged = yield* stageFile(target);
    yield* fs.writeFileString(staged, sql).pipe(Effect.mapError(writeFailure));
    yield* publish(staged, target);
    return { path: input.destination };
  }, Effect.scoped);

  const materializeView = Effect.fn("DataViews.materializeView")(function* (
    input: DataViewMaterializeInput,
  ) {
    const format = NodePath.extname(input.destination).toLowerCase();
    if (format !== ".csv" && format !== ".parquet")
      return yield* new DataViewError({ reason: "invalid-path" });
    const root = yield* rootFor(input.cwd);
    const { revision, ...options } = yield* loadPinned(root, input);
    const target = yield* Effect.tryPromise({
      try: () => destinationFile(root, input.destination),
      catch: writeFailure,
    });
    const writePath = yield* stageFile(target);
    yield* runPinned(root, input.path, revision, {
      ...options,
      writePath,
      format: format === ".csv" ? "csv" : "parquet",
      ...(input.filter === undefined ? {} : { filter: input.filter }),
    });
    yield* publish(writePath, target);
    return { path: input.destination };
  }, Effect.scoped);

  return DataViews.of({
    profileFile,
    viewRevision,
    readView,
    profileDataset,
    profileView,
    saveView,
    materializeView,
  });
});

export const layer = Layer.effect(DataViews, make);
