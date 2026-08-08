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
 * Reconcile the `scient_schema_migrations` ledger from the legacy `applied_at`
 * column to the canonical `created_at` column expected by the Effect SQL
 * Migrator pattern.
 *
 * The runner must not assume `CREATE TABLE IF NOT EXISTS` can alter an existing
 * table's column schema — SQLite silently ignores the statement when the table
 * already exists, so the original `applied_at` column would remain.
 *
 * Concurrency safety: under concurrent startup, two runners may both detect
 * `applied_at` without `created_at` and race to add the column. The ALTER is
 * guarded so a "duplicate column name" error from a winning runner is treated
 * as success.
 *
 * Crash/retry safety: the backfill UPDATE is idempotent
 * (`WHERE created_at IS NULL`), so a partial reconciliation (ALTER committed,
 * UPDATE did not) is safely recovered on retry. Even after `created_at` exists
 * alongside `applied_at`, any rows that still have NULL `created_at` are
 * populated from `applied_at`.
 *
 * No timestamp value, ledger ID, or migration name is lost or altered.
 */
const reconcileLedger = Effect.fn("reconcileScientLedger")(function* (sql: SqlClient.SqlClient) {
  // Check if the ledger table exists at all.
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scient_schema_migrations'
    `;
  if (tables.length === 0) return; // Fresh database — ensureLedgerTable will create it.

  // Check existing columns directly to handle all reconciliation states:
  // - applied_at only (legacy, needs created_at added + backfill)
  // - applied_at + created_at (partially or fully reconciled, may need backfill)
  // - created_at only (fresh or fully reconciled, nothing to do)
  const columns = yield* sql<TableColumn>`PRAGMA table_info(scient_schema_migrations)`;
  const columnNames = new Set(columns.map((column) => column.name));

  const hasAppliedAt = columnNames.has("applied_at");
  const hasCreatedAt = columnNames.has("created_at");

  // No legacy column to reconcile — fresh or already fully canonical.
  if (!hasAppliedAt) return;

  if (!hasCreatedAt) {
    // Add created_at as a nullable column. SQLite ALTER TABLE only allows
    // constant defaults, not expressions like datetime('now') or
    // CURRENT_TIMESTAMP. The runner always sets created_at explicitly in the
    // INSERT, so no DEFAULT is needed.
    //
    // Under concurrent startup, another runner may have already added the
    // column between our PRAGMA check and this ALTER. Catch the "duplicate
    // column name" error and treat it as success.
    yield* sql.unsafe("ALTER TABLE scient_schema_migrations ADD COLUMN created_at TEXT").pipe(
      Effect.catchTag("SqlError", (error: SqlError) => {
        const msg = String(error.message ?? error);
        if (msg.includes("duplicate column name")) {
          return Effect.void;
        }
        return Effect.fail(error);
      }),
    );
  }

  // Always backfill any missing created_at values from applied_at. This is
  // idempotent (only touches rows where created_at IS NULL) and handles
  // partial reconciliation recovery: if the ALTER committed but the UPDATE
  // did not (crash), the retry detects both columns exist, skips the ALTER,
  // and still populates uncopied timestamps.
  yield* sql`UPDATE scient_schema_migrations SET created_at = applied_at WHERE created_at IS NULL`;
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
