import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/056_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/060_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/059_OrchestrationV2.ts";

// The V2 schema is unchanged from the published September 15-16 previews. A
// preview ledger records it at 53, then 54; Scient lifts those onto its own
// immutable ids. The loader keys below are deliberately the *preview* ids — they
// reproduce the ledger a preview left behind, not this build's numbering.
const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

// The expected lists stay exactly as T3 writes them, so T3's new migrations merge cleanly.
// Scient's ids come from its manifest: everything after 52 runs except 59, the relabelled
// preview schema. Every T3 migration must run, in T3's order.
const assertRunsAfterPreview = (
  ran: ReadonlyArray<readonly [number, string]>,
  upstreamExpected: ReadonlyArray<readonly [number, string]>,
) => {
  assert.deepStrictEqual(
    ran,
    migrationManifest.filter(([id]) => id > 52 && id !== 59),
  );
  const upstreamNames = new Set(upstreamExpected.map(([, name]) => name));
  assert.deepStrictEqual(
    ran.map(([, name]) => name).filter((name) => upstreamNames.has(name)),
    upstreamExpected.map(([, name]) => name),
  );
};

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assertRunsAfterPreview(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "AuthConnectDevices"],
        [91, "AuthConnectDeniedRequests"],
        [92, "QueuedTurnInputIndexJsonValid"],
        [93, "ProviderTurnAttemptIndex"],
        [94, "TurnItemMessageOrdinalIndex"],
        [95, "TurnItemInlineWorkOutput"],
        [96, "RepairStaleTitleRegeneration"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      // The preview's row is relabelled, not recreated: its original timestamp
      // must survive the lift to 59.
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 59`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_thread_pull_requests'`,
        [],
      );
      const messageColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      const threadColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(messageColumns.some((column) => column.name === "context_json"));
      assert.isFalse(threadColumns.some((column) => column.name === "title_state_json"));
      assert.isFalse(threadColumns.some((column) => column.name === "section_id"));
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assertRunsAfterPreview(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "AuthConnectDevices"],
        [91, "AuthConnectDeniedRequests"],
        [92, "QueuedTurnInputIndexJsonValid"],
        [93, "ProviderTurnAttemptIndex"],
        [94, "TurnItemMessageOrdinalIndex"],
        [95, "TurnItemInlineWorkOutput"],
        [96, "RepairStaleTitleRegeneration"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("preserves title state already carried by a preview", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, title_state_json
      ) VALUES (
        'preview-with-title', 'preview-project', 'Authored title',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-09-15', '2026-09-15', '{"source":"user"}'
      )`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT title, title_state_json FROM projection_threads
          WHERE thread_id = 'preview-with-title'`,
        [{ title: "Authored title", title_state_json: '{"source":"user"}' }],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 59`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses an incompatible preview title column without changing schema or history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json INTEGER`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
        schema,
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves an ordinary Scient ledger untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      // The lift must never write over a migration Scient already recorded.
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id IN (53, 54, 55)`,
        [
          { migration_id: 53, name: "ProjectionThreadPullRequests" },
          { migration_id: 54, name: "ProjectionThreadMessageContext" },
          { migration_id: 55, name: "ProjectionThreadTitleState" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
