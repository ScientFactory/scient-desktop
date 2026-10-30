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

export const SQL_LANGUAGE_ID = ComputeLanguageId.make("sql");
export const SQL_KERNEL_SCRIPT_NAME = "scient_sql_kernel.py";

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
      const profiles: ComputeRuntimeProfile[] = [];
      // Scient-managed Python carries DuckDB, so it leads unless a Python was chosen for SQL.
      const pythons = [...(yield* python.discover(request))].sort(
        (a, b) => Number(b.source === "configured") - Number(a.source === "configured"),
      );
      for (const profile of pythons) {
        // A configured choice keeps its own failure rather than silently falling back.
        const verification = yield* verifyPython(profile);
        const version = duckdbVersion(verification);
        if (profile.source !== "configured" && (verification.readiness !== "ready" || !version))
          continue;
        profiles.push({
          ...profile,
          languageId: SQL_LANGUAGE_ID,
          languageVersion: version ?? profile.languageVersion,
          displayName: `DuckDB ${version ?? "unavailable"} (${profile.source})`,
        });
      }
      return profiles;
    },
  );

  return {
    adapter: {
      languageId: SQL_LANGUAGE_ID,
      transportKind: python.transportKind,
      ...(python.listInstallations === undefined
        ? {}
        : { listInstallations: python.listInstallations }),
      discover,
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
