import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadPullRequests from "./Migrations/053_ProjectionThreadPullRequests.ts";
import MessageContext from "./Migrations/054_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/055_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./Migrations/056_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/057_ProjectionThreadsAutoSettleDisabledAt.ts";
import ThreadSections from "./Migrations/058_ProjectionThreadSections.ts";

// Published V2 previews shipped the orchestration schema as migration 53, then
// 54. Scient's ledger is three ids ahead of upstream's at that point, so those
// previews must be lifted onto Scient's immutable sequence before this build can
// migrate them. Upstream's version of this file addressed upstream's numbering;
// on Scient those ids name entirely different migrations, so the rewrites below
// are stated against Scient's ids and verified by
// `reconcileV2PreviewMigration.test.ts`.
//
//   preview ledger                     -> composed ledger
//   53 OrchestrationV2                 -> 53-55 Scient prerequisites (run here)
//                                         56 PullRequestFilesViewed (run here)
//                                         57 AutoSettleDisabledAt   (run here)
//                                         58 ThreadSections        (run here)
//                                         59 OrchestrationV2       (relabelled)
//   53 PullRequestFilesViewed          -> 56 PullRequestFilesViewed (relabelled)
//   54 OrchestrationV2                 -> 53-55, 57-58 prerequisites (run here)
//                                         59 OrchestrationV2       (relabelled)
//   55 RemoveRedundantProjectionIndexes-> 60 RemoveRedundant…       (relabelled)
//
// A ledger without `OrchestrationV2` at exactly 53 or 54 is not a preview
// ledger and is left untouched. Only ids this build has never recorded are
// written, so a current Scient database can never match.
const COMPOSED_PULL_REQUEST_FILES_VIEWED = 56;
const COMPOSED_AUTO_SETTLE_DISABLED_AT = 57;
const COMPOSED_ORCHESTRATION_V2 = 59;
const COMPOSED_REMOVE_REDUNDANT_INDEXES = 60;

export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];

      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
        ORDER BY migration_id
      `;
      const legacy = history.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
      );
      if (!legacy) return [];

      // A preview ledger holds nothing but the migrations it actually ran. Any
      // other row at these ids means this is not a ledger we know how to lift,
      // and rewriting it would guess.
      const recognised = history.every(
        (row) =>
          row === legacy ||
          (legacy.migration_id === 54 &&
            row.name === "PullRequestFilesViewed" &&
            row.migration_id === 53) ||
          (legacy.migration_id === 54 &&
            row.name === "RemoveRedundantProjectionIndexes" &&
            row.migration_id === 55),
      );
      if (!recognised) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot upgrade a V2 preview database: it records migrations at ids 53-55 that this " +
            "build does not recognise as a published preview shape. Refusing to rewrite the ledger.",
        });
      }

      const executed: Array<readonly [number, string]> = [];

      // Relabel first. These ids are free in a preview ledger (its maximum is
      // 55) and every write below inserts rather than overwrites, so there is no
      // primary-key collision to step around.
      if (legacy.migration_id === 54) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${COMPOSED_PULL_REQUEST_FILES_VIEWED}
          WHERE migration_id = 53 AND name = 'PullRequestFilesViewed'`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${COMPOSED_REMOVE_REDUNDANT_INDEXES}
          WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      }
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${COMPOSED_ORCHESTRATION_V2}
        WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;

      // The migrator only runs above the latest recorded id. Apply every
      // prerequisite inside this transaction before publishing the lifted 59,
      // so a rejected upgrade leaves a recognizable preview that can retry.
      yield* ThreadPullRequests;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'ProjectionThreadPullRequests')`;
      executed.push([53, "ProjectionThreadPullRequests"]);
      yield* MessageContext;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'ProjectionThreadMessageContext')`;
      executed.push([54, "ProjectionThreadMessageContext"]);

      // Some previews already carried title state. The shipped migration is
      // immutable and unguarded; retain an existing compatible column rather
      // than replaying its ALTER TABLE.
      const threadColumns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;
      const titleState = threadColumns.find((column) => column.name === "title_state_json");
      if (
        titleState !== undefined &&
        (titleState.type.toUpperCase() !== "TEXT" || titleState.notnull !== 0)
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade a V2 preview database: its title state column is incompatible.",
        });
      }
      if (titleState === undefined) yield* TitleState;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (55, 'ProjectionThreadTitleState')`;
      executed.push([55, "ProjectionThreadTitleState"]);

      if (legacy.migration_id === 53) {
        yield* PullRequestFilesViewed;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${COMPOSED_PULL_REQUEST_FILES_VIEWED}, 'PullRequestFilesViewed')`;
        executed.push([COMPOSED_PULL_REQUEST_FILES_VIEWED, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${COMPOSED_AUTO_SETTLE_DISABLED_AT}, 'ProjectionThreadsAutoSettleDisabledAt')`;
      executed.push([COMPOSED_AUTO_SETTLE_DISABLED_AT, "ProjectionThreadsAutoSettleDisabledAt"]);

      yield* ThreadSections;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (58, 'ProjectionThreadSections')`;
      executed.push([58, "ProjectionThreadSections"]);

      return executed;
    }),
  );
});
