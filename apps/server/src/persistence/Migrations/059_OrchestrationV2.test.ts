import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("059_OrchestrationV2", (it) => {
  it.effect("preserves released migration ids and leaves retired migration 50 unused", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 63 }, (_, index) => index + 1).filter((id) => id !== 50),
      );
    }),
  );

  it.effect("upgrades released schema 56 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [57, "ProjectionThreadsAutoSettleDisabledAt"],
        [58, "ProjectionThreadSections"],
        [59, "OrchestrationV2"],
        [60, "RemoveRedundantProjectionIndexes"],
        [61, "ScheduledTaskWebhooks"],
        [62, "WebhookRelayDeliveries"],
        [63, "McpAppModelContext"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "RepairAutomaticSettlementTimestamps" },
        { migration_id: 49, name: "ProjectionProjectIcon" },
        { migration_id: 51, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 52, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 53, name: "ProjectionThreadPullRequests" },
        { migration_id: 54, name: "ProjectionThreadMessageContext" },
        { migration_id: 55, name: "ProjectionThreadTitleState" },
        { migration_id: 56, name: "PullRequestFilesViewed" },
        { migration_id: 57, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 58, name: "ProjectionThreadSections" },
        { migration_id: 59, name: "OrchestrationV2" },
        { migration_id: 60, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 61, name: "ScheduledTaskWebhooks" },
        { migration_id: 62, name: "WebhookRelayDeliveries" },
        { migration_id: 63, name: "McpAppModelContext" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks',
            'scheduled_task_webhook_deliveries',
            'scheduled_task_webhook_relay_deliveries',
            'mcp_app_model_context'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "mcp_app_model_context",
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_task_webhook_deliveries",
          "scheduled_task_webhook_relay_deliveries",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
