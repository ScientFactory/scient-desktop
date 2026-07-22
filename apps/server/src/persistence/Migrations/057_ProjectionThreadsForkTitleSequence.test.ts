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

describe("057_ProjectionThreadsForkTitleSequence", () => {
  it.effect("adds title metadata and backfills retained legacy fork families idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      assert.notInclude(yield* projectionThreadColumnNames(sql), "fork_title_base");
      assert.notInclude(yield* projectionThreadColumnNames(sql), "fork_title_ordinal");

      const createdAt = "2026-07-22T10:00:00.000Z";
      const rows = [
        {
          id: "root",
          title: "Greeting",
          sourceId: null,
          sidechatSourceId: null,
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
        {
          id: "fork-2",
          title: "Greeting",
          sourceId: "root",
          sidechatSourceId: null,
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
        {
          id: "fork-3",
          title: "Greeting",
          sourceId: "root",
          sidechatSourceId: null,
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
        {
          id: "experiment-2",
          title: "Experiment",
          sourceId: "fork-2",
          sidechatSourceId: null,
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
        {
          id: "sidechat",
          title: "Sidechat: Greeting",
          sourceId: "root",
          sidechatSourceId: "root",
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
        {
          id: "pre-numbered",
          title: "Greeting (7)",
          sourceId: "root",
          sidechatSourceId: null,
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 7,
        },
      ] as const;

      for (const [index, row] of rows.entries()) {
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
            sidechat_source_thread_id,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at
          )
          VALUES (
            ${row.id},
            'project-1',
            ${row.title},
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            'local',
            0,
            0,
            ${row.sourceId},
            ${row.sidechatSourceId},
            0,
            0,
            0,
            ${createdAt},
            ${createdAt}
          )
        `;

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES (
            ${`event-${row.id}`},
            'thread',
            ${row.id},
            1,
            'thread.created',
            ${createdAt},
            ${`command-${row.id}`},
            NULL,
            ${`command-${row.id}`},
            'client',
            ${JSON.stringify({
              threadId: row.id,
              projectId: "project-1",
              title: row.title,
              forkSourceThreadId: row.sourceId,
              sidechatSourceThreadId: row.sidechatSourceId,
              forkTitleBase: row.forkTitleBase,
              forkTitleOrdinal: row.forkTitleOrdinal,
              createdAt,
              updatedAt: createdAt,
            })},
            '{}'
          )
        `;

        if (index === 1) {
          yield* sql`
            UPDATE projection_threads
            SET title = 'Renamed first fork'
            WHERE thread_id = 'fork-2'
          `;
        }
      }

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
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at
        )
        VALUES (
          'projection-only',
          'project-1',
          'Greeting',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          'local',
          0,
          0,
          'root',
          0,
          0,
          0,
          ${createdAt},
          ${createdAt}
        )
      `;

      yield* runMigrations();
      yield* runMigrations();

      assert.include(yield* projectionThreadColumnNames(sql), "fork_title_base");
      assert.include(yield* projectionThreadColumnNames(sql), "fork_title_ordinal");

      const projectionRows = yield* sql<{
        readonly id: string;
        readonly title: string;
        readonly forkTitleBase: string | null;
        readonly forkTitleOrdinal: number | null;
      }>`
        SELECT
          thread_id AS id,
          title,
          fork_title_base AS "forkTitleBase",
          fork_title_ordinal AS "forkTitleOrdinal"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `;
      assert.deepEqual(projectionRows, [
        {
          id: "experiment-2",
          title: "Experiment",
          forkTitleBase: "Experiment",
          forkTitleOrdinal: 2,
        },
        {
          id: "fork-2",
          title: "Renamed first fork",
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 2,
        },
        {
          id: "fork-3",
          title: "Greeting",
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 3,
        },
        {
          id: "pre-numbered",
          title: "Greeting (7)",
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 7,
        },
        {
          id: "projection-only",
          title: "Greeting",
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 8,
        },
        { id: "root", title: "Greeting", forkTitleBase: null, forkTitleOrdinal: null },
        {
          id: "sidechat",
          title: "Sidechat: Greeting",
          forkTitleBase: null,
          forkTitleOrdinal: null,
        },
      ]);

      const eventRows = yield* sql<{
        readonly id: string;
        readonly forkTitleBase: string | null;
        readonly forkTitleOrdinal: number | null;
      }>`
        SELECT
          stream_id AS id,
          json_extract(payload_json, '$.forkTitleBase') AS "forkTitleBase",
          json_extract(payload_json, '$.forkTitleOrdinal') AS "forkTitleOrdinal"
        FROM orchestration_events
        WHERE event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      assert.deepEqual(eventRows, [
        { id: "experiment-2", forkTitleBase: "Experiment", forkTitleOrdinal: 2 },
        { id: "fork-2", forkTitleBase: "Greeting", forkTitleOrdinal: 2 },
        { id: "fork-3", forkTitleBase: "Greeting", forkTitleOrdinal: 3 },
        { id: "pre-numbered", forkTitleBase: "Greeting", forkTitleOrdinal: 7 },
        { id: "root", forkTitleBase: null, forkTitleOrdinal: null },
        { id: "sidechat", forkTitleBase: null, forkTitleOrdinal: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
