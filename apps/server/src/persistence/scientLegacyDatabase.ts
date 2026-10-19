import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether Scient's legacy history import has copied the original database (`state.sqlite`)
 * into this one. Until a copy succeeds, the original holds conversations this database does
 * not, so `doctor` must not offer to delete it.
 */
export const legacyHistoryCopied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scient_legacy_reconciliation_state'
  `;
  if (tables.length === 0) return false;
  const rows = yield* sql<{
    readonly source_token: string | null;
    readonly last_error: string | null;
  }>`SELECT source_token, last_error FROM scient_legacy_reconciliation_state WHERE id = 1`;
  const state = rows[0];
  return state !== undefined && state.source_token !== null && state.last_error === null;
});
