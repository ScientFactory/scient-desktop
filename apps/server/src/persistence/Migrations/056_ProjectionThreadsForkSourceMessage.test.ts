import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const projectionThreadColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe("056_ProjectionThreadsForkSourceMessage", () => {
  it.effect("adds and round-trips the message-level fork boundary idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });
      assert.notInclude(yield* projectionThreadColumnNames(sql), "fork_source_message_id");

      yield* runMigrations();
      yield* runMigrations();

      assert.include(yield* projectionThreadColumnNames(sql), "fork_source_message_id");

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          create_branch_flow_completed,
          is_pinned,
          fork_source_thread_id,
          fork_source_message_id,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at
        )
        VALUES (
          'thread-fork',
          'project-1',
          'Fork',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          'local',
          0,
          0,
          'thread-source',
          'message-boundary',
          0,
          0,
          0,
          '2026-07-22T10:00:00.000Z',
          '2026-07-22T10:00:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly forkSourceThreadId: string | null;
        readonly forkSourceMessageId: string | null;
      }>`
        SELECT
          fork_source_thread_id AS "forkSourceThreadId",
          fork_source_message_id AS "forkSourceMessageId"
        FROM projection_threads
        WHERE thread_id = 'thread-fork'
      `;
      assert.deepEqual(rows, [
        {
          forkSourceThreadId: "thread-source",
          forkSourceMessageId: "message-boundary",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
