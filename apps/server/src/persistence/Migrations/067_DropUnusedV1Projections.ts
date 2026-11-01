import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V2 never reads these copied V1 projections; pre-0.1.0 builds use state.sqlite, preserving rollback.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SCIENT-FORK:START — Scient's legacy history import and repair read thread activities,
  // pending approvals and proposed plans (`orchestration-v2/legacy/LegacyScientHistory.ts`,
  // refreshed by `refreshLegacyV1Snapshot.ts`), and Scient V2 migration 016 reads turns on
  // databases still upgrading. Only the tables no Scient path reads are dropped.
  yield* sql`DROP TABLE IF EXISTS projection_state`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
  // SCIENT-FORK:END
});
