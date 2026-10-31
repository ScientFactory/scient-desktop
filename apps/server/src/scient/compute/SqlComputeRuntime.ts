// @effect-diagnostics nodeBuiltinImport:off -- the SQL kernel is a file shipped beside the bridge.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ComputeLanguageId,
  REQUIRED_COMPUTE_CAPABILITIES,
  type ComputeKernelSpec,
  type ComputeLanguageAdapter,
  type ComputeRuntimeProfile,
  type ComputeRuntimeVerification,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";

import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import type { KernelBridgeHost } from "./PythonComputeRuntime.ts";
import { normalizeDiagnosticText } from "./PythonDiagnostic.ts";
import { PYTHON_LANGUAGE_ID } from "./PythonRuntimeAdapter.ts";
import { discoveryContext, type DiscoveryContext } from "./RuntimeDiscovery.ts";
import { readPythonFacts } from "./RuntimeFacts.ts";

export const SQL_LANGUAGE_ID = ComputeLanguageId.make("sql");
const SQL_KERNEL_SCRIPT_NAME = "scient_sql_kernel.py";

// Tables and views are a SQL session's variables.
const SQL_VARIABLES = `SELECT json_object(
  'variables', coalesce(json_group_array(json_object(
    'name', name, 'typeName', kind,
    'shape', CASE WHEN rows IS NULL THEN NULL ELSE concat('(', rows, ', ', columns, ')') END,
    'size', rows, 'preview', NULL)), '[]'),
  'truncated', false)
FROM (
  SELECT CASE WHEN database_name = current_database() AND schema_name = current_schema()
    THEN table_name ELSE concat_ws('.', database_name, schema_name, table_name) END AS name,
    'table' AS kind, estimated_size AS rows, column_count AS columns
  FROM duckdb_tables() WHERE NOT internal
  UNION ALL
  SELECT CASE WHEN database_name = current_database() AND schema_name = current_schema()
    THEN view_name ELSE concat_ws('.', database_name, schema_name, view_name) END,
    'view', NULL, column_count
  FROM duckdb_views() WHERE NOT internal
  ORDER BY name LIMIT 201
)`;

const duckdbVersion = (verification: ComputeRuntimeVerification) =>
  verification.packages.find((entry) => entry.name === "duckdb")?.version ?? null;

const asPython = (profile: ComputeRuntimeProfile): ComputeRuntimeProfile => ({
  ...profile,
  languageId: PYTHON_LANGUAGE_ID,
});

/** DuckDB's kernel runs in the given Python, which must have ipykernel and duckdb. */
export function sqlKernelSpec(python: string, bridgePath: string): ComputeKernelSpec {
  return {
    argv: [
      python,
      "-I",
      NodePath.join(NodePath.dirname(bridgePath), SQL_KERNEL_SCRIPT_NAME),
      "-f",
      "{connection_file}",
    ],
    language: "sql",
    interruptMode: "signal",
    variablesExpression: SQL_VARIABLES,
  };
}

/** Scient-managed Python carries DuckDB; any other Python counts when its files show it. */
const mayHaveDuckdb = (context: DiscoveryContext, source: string, executable: string) =>
  source === "managed" ||
  source === "configured" ||
  readPythonFacts(context, executable).packages("duckdb").state === "present";

/** SQL is DuckDB in a small Python kernel, so its runtimes are Pythons that have DuckDB. */
export function makeSqlRuntimeBinding(host: KernelBridgeHost): ComputeRuntimeBinding {
  const python = host.managedPythonAdapter;

  const verifyPython = (profile: ComputeRuntimeProfile) =>
    python.verify({ profile: asPython(profile), cwd: NodeOS.tmpdir(), environment: {} });

  const verify: ComputeLanguageAdapter["verify"] = (request) =>
    verifyPython(request.profile).pipe(
      Effect.map((verification): ComputeRuntimeVerification => {
        const version = duckdbVersion(verification);
        if (verification.readiness !== "ready" || version !== null)
          return {
            ...verification,
            profile: request.profile,
            packages: [{ name: "duckdb", version }],
          };
        return {
          profile: request.profile,
          readiness: "missing-requirement",
          missingRequirements: ["duckdb"],
          message: "DuckDB is not installed in this Python.",
          packages: [{ name: "duckdb", version: null }],
        };
      }),
    );

  const discover: ComputeLanguageAdapter["discover"] = Effect.fn("SqlComputeRuntime.discover")(
    function* (request) {
      const context = yield* discoveryContext;
      // Scient-managed Python carries DuckDB, so it leads unless a Python was chosen for SQL.
      return (yield* python.discover(request))
        .filter((profile) => mayHaveDuckdb(context, profile.source, profile.executable))
        .toSorted((a, b) => Number(b.source === "configured") - Number(a.source === "configured"))
        .map((profile) => {
          const duckdb = readPythonFacts(context, profile.executable).packages("duckdb");
          const version = duckdb.state === "present" ? duckdb.version : null;
          return {
            ...profile,
            languageId: SQL_LANGUAGE_ID,
            languageVersion: version ?? "unknown",
            displayName: `DuckDB ${version ?? ""} (${profile.source})`.replace("  ", " "),
          };
        });
    },
  );

  const assess: NonNullable<ComputeLanguageAdapter["assess"]> = Effect.fn(
    "SqlComputeRuntime.assess",
  )(function* (profile) {
    const context = yield* discoveryContext;
    const assessment = yield* python.assess!(asPython(profile));
    const duckdb = readPythonFacts(context, profile.executable).packages("duckdb");
    if (assessment.readiness !== "ready" || duckdb.state !== "absent")
      return {
        ...assessment,
        profile,
        packages: [{ name: "duckdb", version: duckdb.state === "present" ? duckdb.version : null }],
      };
    return {
      profile,
      readiness: "missing-requirement" as const,
      missingRequirements: ["duckdb"],
      message: "DuckDB is not installed in this Python.",
      packages: [{ name: "duckdb", version: null }],
    };
  });

  return {
    adapter: {
      languageId: SQL_LANGUAGE_ID,
      transportKind: python.transportKind,
      ...(python.listInstallations === undefined
        ? {}
        : {
            listInstallations: Effect.fn("SqlComputeRuntime.listInstallations")(
              function* (request) {
                const context = yield* discoveryContext;
                return (yield* python.listInstallations!(request)).filter(
                  (installation) =>
                    installation.configured === true ||
                    mayHaveDuckdb(context, installation.source, installation.executable),
                );
              },
            ),
          }),
      discover,
      assess,
      verify,
      prepareLaunch: (request) =>
        python.prepareLaunch({ ...request, profile: asPython(request.profile) }).pipe(
          Effect.map((plan) => ({
            ...plan,
            kernel: sqlKernelSpec(request.profile.executable, host.bridgePath),
          })),
        ),
      normalizeDiagnostic: (report) => [{ ...normalizeDiagnosticText(report), frames: [] }],
      fingerprintEnvironment: (profile) => python.fingerprintEnvironment(asPython(profile)),
    },
    transport: host.transport(),
    descriptor: {
      languageId: SQL_LANGUAGE_ID,
      displayName: "SQL",
      sourceExtensions: [".sql"],
      capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, "variables"],
    },
    ...(host.managedRuntime === undefined ? {} : { managedRuntime: host.managedRuntime }),
  };
}
