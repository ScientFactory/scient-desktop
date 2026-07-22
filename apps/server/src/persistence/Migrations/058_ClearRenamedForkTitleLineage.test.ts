import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("058_ClearRenamedForkTitleLineage", () => {
  it.effect("clears backfilled lineage after a durable title update", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const createdAt = "2026-07-22T10:00:00.000Z";

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
          fork_title_base,
          fork_title_ordinal,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at
        )
        VALUES (
          'renamed-fork',
          'project-1',
          'Greeting (2)',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          'local',
          0,
          0,
          'root',
          'Greeting',
          2,
          0,
          0,
          0,
          ${createdAt},
          ${createdAt}
        )
      `;

      for (const [eventType, payload, version] of [
        [
          "thread.created",
          {
            threadId: "renamed-fork",
            projectId: "project-1",
            title: "Greeting (2)",
            forkSourceThreadId: "root",
            forkTitleBase: "Greeting",
            forkTitleOrdinal: 2,
            createdAt,
            updatedAt: createdAt,
          },
          1,
        ],
        [
          "thread.meta-updated",
          {
            threadId: "renamed-fork",
            title: "Greeting (2)",
            updatedAt: "2026-07-22T10:01:00.000Z",
          },
          2,
        ],
      ] as const) {
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
            ${`event-${version}`},
            'thread',
            'renamed-fork',
            ${version},
            ${eventType},
            ${createdAt},
            ${`command-${version}`},
            NULL,
            ${`command-${version}`},
            'client',
            ${JSON.stringify(payload)},
            '{}'
          )
        `;
      }

      yield* runMigrations();
      const rows = yield* sql<{
        readonly forkTitleBase: string | null;
        readonly forkTitleOrdinal: number | null;
      }>`
        SELECT
          fork_title_base AS "forkTitleBase",
          fork_title_ordinal AS "forkTitleOrdinal"
        FROM projection_threads
        WHERE thread_id = 'renamed-fork'
      `;
      assert.deepEqual(rows, [{ forkTitleBase: null, forkTitleOrdinal: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
