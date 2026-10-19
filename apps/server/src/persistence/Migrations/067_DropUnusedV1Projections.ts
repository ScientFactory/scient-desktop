import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * V2 databases start as a copy of the V1 database, and nothing reads these V1
 * projections after the copy. The V1 transcript import still reads threads,
 * messages and pull request links, so those stay. Builds before 0.1.0 read
 * `state.sqlite`, never this file, so dropping them does not affect a rollback.
 * The freed pages are reported as reclaimable space for `t3 doctor`.
 */
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
