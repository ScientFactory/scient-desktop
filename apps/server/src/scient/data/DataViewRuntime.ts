// @effect-diagnostics nodeBuiltinImport:off -- gives each DuckDB process a private output directory.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DataTableTotals } from "@scientfactory/compute";
import { DataViewError, type DataTableQuery } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { sanitizeComputeEnvironment } from "../compute/ComputeEnvironmentPolicy.ts";
import { runOwnedProcess } from "../compute/ManagedPythonProvisioner.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";

const PYTHON = String.raw`
import hashlib
import json
from array import array
import math
import re
import sys
from pathlib import Path

import duckdb

options = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
output = Path(sys.argv[2])
connection = duckdb.connect(":memory:", config={
    "allow_community_extensions": "false",
    "autoload_known_extensions": "false",
    "autoinstall_known_extensions": "false",
    "allow_persistent_secrets": "false",
    "memory_limit": "256MB",
    "max_temp_directory_size": "2GB",
    "threads": "2",
    "temp_directory": str(output.parent / "spill"),
})

def quote(text):
    return "'" + text.replace("'", "''") + "'"

def identifier(text):
    return '"' + text.replace('"', '""') + '"'

def display_rows(rows, width):
    clipped_columns = [False] * width
    display = []
    for row in rows:
        cells = []
        for i, value in enumerate(row):
            if value is None:
                cells.append(None)
                continue
            text = "NaN" if isinstance(value, float) and math.isnan(value) else str(value)
            # Bound the length in UTF-16 units, as the grid's wire schema does.
            if len(text) > 100:
                encoded = text.encode("utf-16-le")
                if len(encoded) > 400:
                    text = encoded[:400].decode("utf-16-le", errors="ignore") + "…"
                    clipped_columns[i] = True
            cells.append(text)
        display.append(cells)
    return display, clipped_columns

def profile_parquet(table, numeric, footer):
    rows = table.aggregate("count(*)").fetchone()[0]
    columns = []
    for index, (name, kind) in enumerate(zip(table.columns[:1024], table.types[:1024])):
        field = identifier(name)
        aggregate = [f"approx_count_distinct({field})"]
        floating = str(kind) in ("DOUBLE", "FLOAT")
        missing_in_footer, range_in_footer = footer[index]
        aggregate.append("0" if missing_in_footer else f"count(*) - count({field})")
        aggregate.append(f"count(*) FILTER (isnan({field}))" if floating else "0")
        bounds = numeric[index] and not range_in_footer
        if bounds:
            finite = f" FILTER (NOT isnan({field}))" if floating else ""
            aggregate.extend([f"min({field}){finite}", f"max({field}){finite}"])
        distinct, missing, nans, *extrema = table.aggregate(", ".join(aggregate)).fetchone()
        top = []
        approximate_top = False
        approximate_distinct = distinct != 0
        clipped = False
        if not numeric[index] and distinct:
            if distinct <= 1024:
                common = table.query("dataset", f"""
                    SELECT {field}, count(*), count(*) OVER ()
                    FROM dataset WHERE {field} IS NOT NULL
                    GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 3
                """).fetchall()
                if common:
                    distinct = common[0][2]
                    approximate_distinct = False
            else:
                approximate_top = True
                common = table.query("dataset", f"""
                    WITH candidates AS (
                        SELECT unnest(approx_top_k({field}, 3)) AS candidate FROM dataset
                    )
                    SELECT {field}, count(*) FROM dataset
                    WHERE {field} IN (SELECT candidate FROM candidates)
                    GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 3
                """).fetchall()
            values, flags = display_rows([(row[0],) for row in common], 1)
            clipped = flags[0]
            top = [{"value": value[0], "count": entry[1]} for value, entry in zip(values, common)]
        column = {
            "missing": missing,
            "distinct": distinct,
            "distinctApproximate": approximate_distinct,
            "range": {"min": str(extrema[0]), "max": str(extrema[1])}
                if extrema and extrema[0] is not None else None,
            "valuesClipped": clipped,
            "topApproximate": approximate_top,
            "top": top,
        }
        if nans:
            column["nanCount"] = nans
        columns.append(column)
    return {"profile": {"rowCount": rows, "columns": columns}}

def run():
    files = options["sources"]
    target = options.get("writePath")
    if target:
        files = [*files, target]
    connection.execute("SET allowed_paths = [" + ", ".join(map(quote, files)) + "]")
    connection.execute("SET enable_external_access = false")
    connection.execute("SET lock_configuration = true")
    if "profilePath" in options:
        table = connection.read_parquet(options["profilePath"])
        return profile_parquet(table, options["numeric"], options["footer"])
    statements = connection.extract_statements(options["sql"])
    if len(statements) != 1 or statements[0].type != duckdb.StatementType.SELECT:
        return {"error": "query-required"}
    table = connection.sql(statements[0].query)
    if "countSql" in options:
        digest = hashlib.sha256()
        while True:
            chunk = table.fetchmany(8192)
            if not chunk:
                break
            digest.update(array("I", (row[0] - 1 for row in chunk)))
        count_sql = options["countSql"]
        row_count = connection.sql(count_sql).fetchone()[0] if count_sql else None
        return {"digest": digest.hexdigest(), "rowCount": row_count}
    if target:
        if target.endswith(".csv"):
            table.write_csv(target, header=True)
        else:
            table.write_parquet(target)
        return None
    columns = table.columns
    types = [str(kind) for kind in table.types]
    count = table.aggregate("count(*)").fetchone()[0]
    query = options["query"]
    needle = query["search"].strip().lower()
    if needle and columns:
        table = table.filter(" OR ".join(
            "contains(lower(cast(" + identifier(column) + " as varchar)), " + quote(needle) + ")"
            for column in columns
        ))
    minimum = query.get("minimum")
    if minimum and minimum["column"] < min(1024, len(columns)):
        name = identifier(columns[minimum["column"]])
        number = "try_cast(" + name + " AS DOUBLE)"
        table = table.filter(number + " >= " + str(minimum["value"]) + " AND NOT isnan(" + number + ")")
    match_count = table.aggregate("count(*)").fetchone()[0] if needle or minimum else count
    if query["sort"] is not None and query["sort"]["column"] < min(1024, len(columns)):
        sort = query["sort"]
        order = " DESC" if sort["descending"] else " ASC"
        table = table.order(identifier(columns[sort["column"]]) + order + " NULLS LAST")
    width = min(1024, len(columns))
    limit = min(query["limit"], max(1, 16384 // max(1, width)))
    if width < len(columns):
        table = table.project(", ".join(map(identifier, columns[:width])))
    rows, clipped_columns = display_rows(table.limit(limit, query["offset"]).fetchall(), width)
    return {
        "names": [name[:1024] for name in columns[:width]],
        "types": [kind[:256] for kind in types[:width]],
        "columnCount": len(columns),
        "rowCount": count,
        "matchCount": match_count,
        "rows": rows,
        "clippedColumns": clipped_columns,
    }

try:
    result = run()
except duckdb.PermissionException as error:
    match = re.search(r'Cannot access file "([^\n]+)" - file system operations are disabled', str(error))
    reference = match.group(1) if match else None
    missing = reference and re.sub(r"^(?:\./)+", "", reference) in options.get("missingSources", ())
    result = {"error": "source-missing" if missing else "source-untraced"}
    if reference:
        result["reference"] = reference[:1024]
except duckdb.IOException as error:
    match = re.search(r'No files found that match the pattern "([^\n]+)"', str(error))
    result = {"error": "source-missing", "reference": match.group(1)[:1024]} if match else {"error": "query-failed"}
except duckdb.Error:
    result = {"error": "query-failed"}
output.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
`;

const ViewPage = Schema.Struct({
  names: Schema.Array(Schema.String),
  types: Schema.Array(Schema.String),
  columnCount: Schema.Int,
  rowCount: Schema.Int,
  matchCount: Schema.Int,
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  clippedColumns: Schema.Array(Schema.Boolean),
});
type ViewPage = typeof ViewPage.Type;

const response = Schema.fromJsonString(
  Schema.Union([
    ViewPage,
    Schema.Struct({ profile: DataTableTotals }),
    Schema.Struct({ digest: Schema.String, rowCount: Schema.NullOr(Schema.Int) }),
    Schema.Null,
    Schema.Struct({
      error: Schema.Literals([
        "query-required",
        "query-failed",
        "source-missing",
        "source-untraced",
      ]),
      reference: Schema.optional(Schema.String),
    }),
  ]),
);

const encodeOptions = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = Schema.decodeEffect(response);

type ReadOptions = { readonly query: DataTableQuery };
type WriteOptions = { readonly writePath: string };
type CheckOptions = { readonly countSql: string | null };
type ProfileOptions = {
  readonly profilePath: string;
  readonly numeric: ReadonlyArray<boolean>;
  readonly footer: ReadonlyArray<readonly [boolean, boolean]>;
};
type ViewOptions = (
  | ((ReadOptions | WriteOptions | CheckOptions) & { readonly sql: string })
  | ProfileOptions
) & {
  readonly sources: ReadonlyArray<string>;
  readonly missingSources?: ReadonlyArray<string>;
};

export class DataViewPython extends Context.Service<
  DataViewPython,
  { readonly executable: Effect.Effect<string, DataViewError> }
>()("t3/scient/data/DataViewRuntime/DataViewPython") {}

export const makeDataViewRuntime = Effect.gen(function* () {
  const { executable } = yield* DataViewPython;
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ExecutionProcess;
  const host = yield* HostProcess.Environment;
  const permits = yield* Semaphore.make(2);
  const environment = sanitizeComputeEnvironment(
    Object.fromEntries(
      Object.entries(host).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  ).environment;
  return Effect.fn("DataViews.queryDuckDb")(function* (cwd: string, options: ViewOptions) {
    const temp = yield* fs
      .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "scient-view-" })
      .pipe(Effect.mapError((cause) => new DataViewError({ reason: "query-failed", cause })));
    const resultPath = NodePath.join(temp, "result.json");
    const python = yield* executable;
    const configPath = NodePath.join(temp, "request.json");
    const config = yield* encodeOptions(options).pipe(
      Effect.mapError((cause) => new DataViewError({ reason: "query-failed", cause })),
    );
    yield* fs
      .writeFileString(configPath, config)
      .pipe(Effect.mapError((cause) => new DataViewError({ reason: "query-failed", cause })));
    yield* runOwnedProcess(processes, {
      runId: `scient-data-view-${NodeCrypto.randomUUID()}`,
      executable: python,
      args: ["-I", "-B", "-c", PYTHON, configPath, resultPath],
      cwd,
      environment,
    }).pipe(
      Effect.timeout("writePath" in options ? "5 minutes" : "45 seconds"),
      Effect.mapError(
        (cause) =>
          new DataViewError({
            reason: Cause.isTimeoutError(cause) ? "query-timeout" : "runner-failed",
            cause,
          }),
      ),
    );
    const result = yield* fs.readFileString(resultPath).pipe(
      Effect.flatMap(decodeResponse),
      Effect.mapError((cause) => new DataViewError({ reason: "runner-failed", cause })),
    );
    if (result !== null && "error" in result)
      return yield* new DataViewError({
        reason: result.error,
        ...(result.reference === undefined ? {} : { reference: result.reference }),
      });
    if (result === null && "writePath" in options) return { kind: "file" } as const;
    if (result !== null && "profile" in result)
      return { kind: "profile", profile: result.profile } as const;
    if (result !== null && "digest" in result) return { kind: "check", ...result } as const;
    if (result !== null) return { kind: "page", page: result } as const;
    return yield* new DataViewError({ reason: "query-failed" });
  }, permits.withPermits(1));
});
