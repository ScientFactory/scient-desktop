import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Reject incompatible shipped names, ordering, and missing steps; tolerate intentionally retired ids. */
export const validateScientMigrationLedger = Effect.fn("validateLedger")(function* (
  migrationEntries: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return; // Fresh database: nothing recorded yet.
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  if (rows.length === 0) return;

  const latest = migrationEntries[migrationEntries.length - 1]!;
  let previousRecordedId = 0;
  for (const row of rows) {
    if (row.migration_id <= previousRecordedId) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger is not in increasing id order: ${row.migration_id} ("${row.name}") ` +
          `follows ${previousRecordedId}. The ledger was modified; refusing to continue.`,
      });
    }
    if (row.migration_id > latest[0]) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger records ${row.migration_id} ("${row.name}"), beyond the latest known ` +
          `${latest[0]} ("${latest[1]}"). The database was migrated by a newer or different ` +
          `build; refusing to run this build's migrations against it.`,
      });
    }
    // Find the deciding missing step before checking the recorded name.
    let expectedName: string | undefined;
    for (const [id, name] of migrationEntries) {
      if (id === row.migration_id) {
        expectedName = name;
        break;
      }
      if (id > previousRecordedId && id < row.migration_id) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            `Migration ledger skips ${id} ("${name}"), which this build defines, between recorded ` +
            `${previousRecordedId} and ${row.migration_id}. That migration would never run; ` +
            `refusing to continue.`,
        });
      }
    }
    previousRecordedId = row.migration_id;
    // Retired ids are tolerated: an older build recorded them and this build
    // intentionally no longer defines them.
    if (expectedName === undefined) continue;
    if (row.name !== expectedName) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger records ${row.migration_id} as "${row.name}" but this build names it ` +
          `"${expectedName}". The ledger was written by a different build; this build's migration ` +
          `at that id would be silently skipped, so refusing to continue.`,
      });
    }
  }
});
