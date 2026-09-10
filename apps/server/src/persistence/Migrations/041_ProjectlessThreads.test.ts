import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectlessThreads", (it) => {
  it.effect("makes project ownership nullable and preserves thread indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-before-041', 'project-before-041', 'Existing project thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
          'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(columns.find((column) => column.name === "project_id")?.notnull, 0);
      assert.equal(columns.find((column) => column.name === "workspace_root")?.notnull, 0);
      assert.equal(
        columns.find((column) => column.name === "runtime_mode")?.dflt_value,
        "'full-access'",
      );
      assert.equal(
        columns.find((column) => column.name === "interaction_mode")?.dflt_value,
        "'default'",
      );
      for (const columnName of [
        "pending_approval_count",
        "pending_user_input_count",
        "has_actionable_proposed_plan",
      ]) {
        assert.equal(columns.find((column) => column.name === columnName)?.dflt_value, "0");
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      const indexNames = new Set(indexes.map((index) => index.name));
      for (const expectedIndex of [
        "idx_projection_threads_project_id",
        "idx_projection_threads_project_archived_at",
        "idx_projection_threads_project_deleted_created",
        "idx_projection_threads_shell_active",
        "idx_projection_threads_shell_archived",
      ]) {
        assert.ok(indexNames.has(expectedIndex), `missing ${expectedIndex}`);
      }

      const preserved = yield* sql<{
        readonly projectId: string | null;
        readonly title: string;
        readonly workspaceRoot: string | null;
      }>`
        SELECT project_id AS projectId, title, workspace_root AS workspaceRoot
        FROM projection_threads
        WHERE thread_id = 'thread-before-041'
      `;
      assert.deepEqual(preserved, [
        {
          projectId: "project-before-041",
          title: "Existing project thread",
          workspaceRoot: null,
        },
      ]);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, workspace_root, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-quick-chat', NULL, '/tmp/environment-workspace', 'Quick chat',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
          'default', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
        )
      `;
      const quickChat = yield* sql<{
        readonly projectId: string | null;
        readonly workspaceRoot: string | null;
      }>`
        SELECT project_id AS projectId, workspace_root AS workspaceRoot
        FROM projection_threads
        WHERE thread_id = 'thread-quick-chat'
      `;
      assert.deepEqual(quickChat, [
        { projectId: null, workspaceRoot: "/tmp/environment-workspace" },
      ]);
    }),
  );
});
