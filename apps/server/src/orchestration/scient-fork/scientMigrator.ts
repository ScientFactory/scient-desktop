/**
 * Scient-owned versioned migration runner.
 *
 * Follows the repository's Effect SQL Migrator pattern (ledger-based,
 * transactional, ordered) but is Scient-owned and uses a separate
 * `scient_schema_migrations` ledger table. T3's `effect_sql_migrations` table
 * and numbering are never modified.
 *
 * Key reconciliation: existing development databases created by the legacy
 * `ensureScientForkSchema` have an `applied_at` timestamp column in the ledger.
 * The Effect SQL Migrator pattern expects a `created_at` column. This runner
 * explicitly detects the existing `applied_at` column, preserves all recorded
 * timestamp values and ledger IDs/names, and maps reads/writes to `created_at`
 * after reconciliation. Fresh databases receive `created_at` directly.
 *
 * SCIENT-OWNED.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import Migration001 from "./migrations/001_DurableThreadForks.ts";
import Migration002 from "./migrations/002_DurableProviderBootstrap.ts";
import Migration003 from "./migrations/003_NormalizeActiveLineage.ts";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ScientMigrationError extends Data.TaggedError("ScientMigrationError")<{
  readonly kind: "Duplicates" | "Failed" | "Locked";
  readonly message: string;
  readonly migrationId?: number;
  readonly migrationName?: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Migration manifest
// ---------------------------------------------------------------------------

export interface ScientMigration {
  readonly id: number;
  readonly name: string;
  // Migration effects use SqlClient and can fail with SqlError or structured
  // errors (e.g. ScientMalformedLineageError). The runner wraps all failures
  // into ScientMigrationError.
  readonly effect: Effect.Effect<void, SqlError | Error, SqlClient.SqlClient>;
}

/**
 * Explicit, ordered Scient migration manifest.
 *
 * IDs 1 and 2 match the names recorded by the legacy `ensureScientForkSchema`
 * function. Existing databases that already have these ledger entries will not
 * re-run them. Migration 3 is the new normalization pass.
 */
export const SCIENT_MIGRATIONS: ReadonlyArray<ScientMigration> = [
  { id: 1, name: "durable-thread-forks", effect: Migration001 },
  { id: 2, name: "durable-provider-bootstrap", effect: Migration002 },
  { id: 3, name: "normalize-active-lineage", effect: Migration003 },
] as const;

// ---------------------------------------------------------------------------
// Ledger reconciliation: applied_at -> created_at
// ---------------------------------------------------------------------------

interface TableColumn {
  readonly name: string;
}

/**
 * Detect whether the `scient_schema_migrations` ledger table exists and, if so,
 * whether it uses the legacy `applied_at` column or the canonical `created_at`
 * column.
 *
 * This must not assume `CREATE TABLE IF NOT EXISTS` can alter an existing
 * table's column schema. SQLite silently ignores the statement when the table
 * already exists, so the original `applied_at` column would remain.
 */
const detectLedgerTimestampColumn = Effect.fn("detectScientLedgerTimestampColumn")(function* (
  sql: SqlClient.SqlClient,
) {
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scient_schema_migrations'
    `;
  if (tables.length === 0) return null as Readonly<{ column: "applied_at" | "created_at" } | null>;

  const columns = yield* sql<TableColumn>`PRAGMA table_info(scient_schema_migrations)`;
  const columnNames = new Set(columns.map((column) => column.name));

  if (columnNames.has("created_at")) return { column: "created_at" as const };
  if (columnNames.has("applied_at")) return { column: "applied_at" as const };
  return null;
});

/**
 * Reconcile the ledger: if the table exists with `applied_at` but without
 * `created_at`, add `created_at` (nullable — SQLite ALTER TABLE does not allow
 * expression defaults like `datetime('now')`) and copy all existing `applied_at`
 * values into it. New rows always receive an explicit `created_at` value from
 * the runner's INSERT, so the lack of a column DEFAULT is not a problem.
 *
 * No timestamp value, ledger ID, or migration name is lost or altered.
 */
const reconcileLedger = Effect.fn("reconcileScientLedger")(function* (sql: SqlClient.SqlClient) {
  const detected = yield* detectLedgerTimestampColumn(sql);
  if (detected === null || detected.column !== "applied_at") return;

  // Add created_at as a nullable column. SQLite ALTER TABLE only allows
  // constant defaults, not expressions like datetime('now') or CURRENT_TIMESTAMP.
  // The runner always sets created_at explicitly in the INSERT, so no DEFAULT
  // is needed.
  yield* sql.unsafe("ALTER TABLE scient_schema_migrations ADD COLUMN created_at TEXT");

  // Copy existing applied_at values so no timestamp is lost.
  yield* sql`UPDATE scient_schema_migrations SET created_at = applied_at`;
});

// ---------------------------------------------------------------------------
// Ledger table management
// ---------------------------------------------------------------------------

/**
 * Ensure the ledger table exists. For fresh databases this creates it with the
 * canonical `created_at` column. For existing databases (after reconciliation)
 * this is a no-op (`IF NOT EXISTS`).
 */
const ensureLedgerTable = Effect.fn("ensureScientLedgerTable")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_schema_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
});

/**
 * Read the high-water mark (maximum applied migration ID) from the ledger.
 * Returns 0 for an empty ledger (fresh database).
 */
const getHighWaterMark = Effect.fn("getScientMigrationHighWaterMark")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{ readonly max_id: number | null }>`
    SELECT MAX(migration_id) AS max_id FROM scient_schema_migrations
  `;
  return rows[0]?.max_id ?? 0;
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

function checkDuplicateIds(
  migrations: ReadonlyArray<ScientMigration>,
): Effect.Effect<void, ScientMigrationError> {
  const ids = migrations.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length) {
    return Effect.fail(
      new ScientMigrationError({
        kind: "Duplicates",
        message: "Found duplicate migration IDs in the Scient migration manifest",
      }),
    );
  }
  return Effect.void;
}

// ---------------------------------------------------------------------------
// Constraint conflict detection (for concurrent runner locking)
// ---------------------------------------------------------------------------

function isConstraintConflict(error: SqlError): boolean {
  return error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation";
}

// ---------------------------------------------------------------------------
// Pending migration execution
// ---------------------------------------------------------------------------

/**
 * Run pending migrations inside a single transaction.
 *
 * All pending migration records are INSERTed first (serving as both a
 * reservation and a concurrent-runner lock via PRIMARY KEY constraint). Then
 * each migration effect runs in ascending ID order. If any migration fails,
 * the entire transaction rolls back — no partial records, no partial schema
 * changes.
 *
 * If a concurrent runner has already INSERTed the same IDs, the constraint
 * conflict is caught and an empty array is returned (the loser).
 */
function runPendingMigrations(
  sql: SqlClient.SqlClient,
  pending: ReadonlyArray<ScientMigration>,
  hasAppliedAt: boolean,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  ScientMigrationError | SqlError,
  SqlClient.SqlClient
> {
  if (pending.length === 0) {
    return Effect.succeed([]);
  }

  const runTx = Effect.gen(function* () {
    // Use a single timestamp for all pending migrations in this batch.
    const now = DateTime.formatIso(yield* DateTime.now);

    // INSERT all pending records first (lock + reservation).
    // If a concurrent runner already inserted these IDs, the PRIMARY KEY
    // constraint fires and the whole transaction is abandoned.
    // created_at is set explicitly so it works on both fresh databases
    // (DEFAULT available) and reconciled databases (nullable column, no
    // DEFAULT from ALTER TABLE).
    // applied_at is included when the column exists (legacy databases where
    // the original schema had `applied_at TEXT NOT NULL`).
    const insertRows = pending.map((migration) => {
      const row: Record<string, unknown> = {
        migration_id: migration.id,
        name: migration.name,
        created_at: now,
      };
      if (hasAppliedAt) {
        row.applied_at = now;
      }
      return row;
    });

    yield* sql`
      INSERT INTO scient_schema_migrations ${sql.insert(insertRows)}
    `.withoutTransform;

    // Run each migration in ascending ID order.
    for (const migration of pending) {
      yield* migration.effect.pipe(
        Effect.catch((error: SqlError | Error) =>
          Effect.fail(
            new ScientMigrationError({
              kind: "Failed" as const,
              migrationId: migration.id,
              migrationName: migration.name,
              message: `Scient migration "${migration.id}_${migration.name}" failed: ${String(error)}`,
              cause: error,
            }),
          ),
        ),
      );
    }

    return pending.map((migration) => [migration.id, migration.name] as const);
  });

  return sql.withTransaction(runTx).pipe(
    Effect.catchTag("SqlError", (error: SqlError) => {
      if (isConstraintConflict(error)) {
        return Effect.succeed([] as ReadonlyArray<readonly [id: number, name: string]>);
      }
      return Effect.fail(error);
    }),
  );
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

/**
 * Run all pending Scient schema migrations.
 *
 * 1. Reconcile the `applied_at` / `created_at` ledger column mismatch.
 * 2. Ensure the `scient_schema_migrations` ledger table exists.
 * 3. Check for duplicate migration IDs in the manifest.
 * 4. Read the high-water mark from the ledger.
 * 5. Filter to pending migrations (ID > high-water mark).
 * 6. Run pending migrations transactionally in ascending order.
 *
 * @returns Array of `[id, name]` tuples for migrations that were run.
 */
export const runScientMigrations = Effect.fn("runScientMigrations")(function* (
  sql: SqlClient.SqlClient,
) {
  // 1. Reconcile applied_at -> created_at if needed.
  yield* reconcileLedger(sql);

  // 2. Ensure ledger table exists.
  yield* ensureLedgerTable(sql);

  // 2b. Detect whether the legacy `applied_at` column is present so the
  //     INSERT can satisfy its NOT NULL constraint on reconciled databases.
  const ledgerColumns = yield* sql<TableColumn>`PRAGMA table_info(scient_schema_migrations)`;
  const hasAppliedAt = ledgerColumns.some((column) => column.name === "applied_at");

  // 3. Check for duplicate IDs.
  yield* checkDuplicateIds(SCIENT_MIGRATIONS);

  // 4. Get high-water mark.
  const highWaterMark = yield* getHighWaterMark(sql);

  // 5. Filter to pending.
  const pending = SCIENT_MIGRATIONS.filter((migration) => migration.id > highWaterMark).sort(
    (a, b) => a.id - b.id,
  );

  // 6. Run pending migrations.
  const executed = yield* runPendingMigrations(sql, pending, hasAppliedAt);

  // 7. Log.
  yield* executed.length === 0
    ? Effect.logDebug("Scient schema is current")
    : Effect.log("Scient migrations ran successfully").pipe(
        Effect.annotateLogs({
          migrations: executed.map(([id, name]) => `${id}_${name}`),
        }),
      );

  return executed;
});
