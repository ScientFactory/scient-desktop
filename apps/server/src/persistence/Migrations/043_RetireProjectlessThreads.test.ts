import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_RetireProjectlessThreads", (it) => {
  it.effect("deletes current projectless streams while preserving project-owned history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"instanceId":"codex","model":"gpt-5"}', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, workspace_root, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        ) VALUES
          (
            'thread-retired', NULL, '/tmp/legacy', 'Legacy thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          ),
          (
            'thread-survives', 'project-1', NULL, 'Project thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('message-retired', 'thread-retired', 'user', 'remove', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('message-survives', 'thread-survives', 'user', 'keep', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, plan_markdown, created_at, updated_at, implementation_thread_id
        ) VALUES
          ('plan-retired', 'thread-retired', 'remove',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('plan-survives', 'thread-survives', 'keep',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'thread-retired')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json,
          source_proposed_plan_thread_id, source_proposed_plan_id
        ) VALUES
          ('thread-retired', 'turn-retired', 'completed',
           '2026-01-01T00:00:00.000Z', '[]', NULL, NULL),
          ('thread-survives', 'turn-survives', 'completed',
           '2026-01-01T00:00:00.000Z', '[]', 'thread-retired', 'plan-retired')
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id, from_turn_count, to_turn_count, diff, created_at
        ) VALUES ('thread-retired', 0, 1, 'remove', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at
        ) VALUES ('thread-retired', 'codex', 'codex', 'full-access', 'idle',
                  '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          ('event-retired', 'thread', 'thread-retired', 1, 'thread.created',
           '2026-01-01T00:00:00.000Z', 'system', '{}', '{}'),
          ('event-survives', 'thread', 'thread-survives', 1, 'thread.created',
           '2026-01-01T00:00:00.000Z', 'system', '{}', '{}')
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        ) VALUES
          ('command-retired', 'thread', 'thread-retired',
           '2026-01-01T00:00:00.000Z', 1, 'accepted', NULL),
          ('command-survives', 'thread', 'thread-survives',
           '2026-01-01T00:00:00.000Z', 1, 'accepted', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const retiredThreads = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = 'thread-retired'
      `;
      const retiredMessages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages
        WHERE thread_id = 'thread-retired'
      `;
      const retiredEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = 'thread-retired'
      `;
      const retiredDiffs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM checkpoint_diff_blobs WHERE thread_id = 'thread-retired'
      `;
      const retiredRuntime = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_session_runtime WHERE thread_id = 'thread-retired'
      `;
      const retiredReceipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = 'thread-retired'
      `;
      const survivingReceipts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = 'thread-survives'
      `;
      assert.equal(retiredThreads[0]?.count, 0);
      assert.equal(retiredMessages[0]?.count, 0);
      assert.equal(retiredEvents[0]?.count, 0);
      assert.equal(retiredDiffs[0]?.count, 0);
      assert.equal(retiredRuntime[0]?.count, 0);
      assert.equal(retiredReceipts[0]?.count, 0);
      assert.equal(survivingReceipts[0]?.count, 1);

      const survivor = yield* sql<{
        readonly implementationThreadId: string | null;
        readonly sourceThreadId: string | null;
        readonly sourcePlanId: string | null;
      }>`
        SELECT
          plan.implementation_thread_id AS "implementationThreadId",
          turn.source_proposed_plan_thread_id AS "sourceThreadId",
          turn.source_proposed_plan_id AS "sourcePlanId"
        FROM projection_thread_proposed_plans AS plan
        JOIN projection_turns AS turn ON turn.thread_id = plan.thread_id
        WHERE plan.thread_id = 'thread-survives'
      `;
      assert.deepEqual(survivor, [
        { implementationThreadId: null, sourceThreadId: null, sourcePlanId: null },
      ]);

      const cleanup = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM retired_projectless_thread_cleanup
      `;
      assert.deepEqual(cleanup, [{ threadId: "thread-retired" }]);
    }),
  );
});
