import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { resolveNextForkTitle, type ForkTitleThread } from "../../orchestration/forkTitle.ts";

interface SeedThread {
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly ordinal: number;
}

describe("058_ClearRenamedForkTitleLineage", () => {
  it.effect("reconciles historical rename boundaries and keeps event replay equivalent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const createdAt = "2026-07-22T10:00:00.000Z";

      const insertThread = (thread: SeedThread) =>
        Effect.gen(function* () {
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
              ${thread.id},
              'project-1',
              ${thread.title},
              '{"provider":"codex","model":"gpt-5-codex"}',
              'approval-required',
              'default',
              'local',
              0,
              0,
              ${thread.sourceId},
              ${thread.title},
              ${thread.ordinal},
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
              ${`event-created-${thread.id}`},
              'thread',
              ${thread.id},
              1,
              'thread.created',
              ${createdAt},
              ${`command-created-${thread.id}`},
              NULL,
              ${`command-created-${thread.id}`},
              'client',
              ${JSON.stringify({
                threadId: thread.id,
                projectId: "project-1",
                title: thread.title,
                forkSourceThreadId: thread.sourceId,
                forkTitleBase: thread.title,
                forkTitleOrdinal: thread.ordinal,
                createdAt,
                updatedAt: createdAt,
              })},
              '{}'
            )
          `;
        });

      const insertTitleEvent = (input: {
        readonly threadId: string;
        readonly version: number;
        readonly title: string;
      }) =>
        sql`
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
            ${`event-title-${input.threadId}-${input.version}`},
            'thread',
            ${input.threadId},
            ${input.version},
            'thread.meta-updated',
            ${createdAt},
            ${`command-title-${input.threadId}-${input.version}`},
            NULL,
            ${`command-title-${input.threadId}-${input.version}`},
            'client',
            ${JSON.stringify({
              threadId: input.threadId,
              title: input.title,
              updatedAt: createdAt,
            })},
            '{}'
          )
        `;

      // This emulates metadata written by the earlier migration 057. The
      // parent was renamed away and back; its child was therefore incorrectly
      // numbered in the original root family instead of the parent's new one.
      yield* insertThread({
        id: "renamed-parent",
        title: "Greeting",
        sourceId: "root",
        ordinal: 2,
      });
      yield* insertTitleEvent({ threadId: "renamed-parent", version: 2, title: "Experiment" });
      yield* insertTitleEvent({ threadId: "renamed-parent", version: 3, title: "Greeting" });
      yield* insertThread({
        id: "renamed-parent-child",
        title: "Greeting",
        sourceId: "renamed-parent",
        ordinal: 3,
      });

      // A no-op title event is not a manual rename and must remain in its
      // automatic family after migration and after replay from event truth.
      yield* insertThread({
        id: "same-title",
        title: "Greeting",
        sourceId: "other-root",
        ordinal: 2,
      });
      yield* insertTitleEvent({ threadId: "same-title", version: 2, title: "Greeting" });

      yield* runMigrations();
      yield* runMigrations();

      const projectionRows = yield* sql<{
        readonly id: string;
        readonly forkTitleBase: string | null;
        readonly forkTitleOrdinal: number | null;
      }>`
        SELECT
          thread_id AS id,
          fork_title_base AS "forkTitleBase",
          fork_title_ordinal AS "forkTitleOrdinal"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepEqual(projectionRows, [
        { id: "renamed-parent", forkTitleBase: null, forkTitleOrdinal: null },
        {
          id: "renamed-parent-child",
          forkTitleBase: "Greeting",
          forkTitleOrdinal: 2,
        },
        { id: "same-title", forkTitleBase: "Greeting", forkTitleOrdinal: 2 },
      ]);

      const createdEvents = yield* sql<{
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
      assert.deepEqual(createdEvents, projectionRows);

      const allocatorRows = yield* sql<ForkTitleThread>`
        SELECT
          thread_id AS id,
          project_id AS "projectId",
          title,
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          fork_title_base AS "forkTitleBase",
          fork_title_ordinal AS "forkTitleOrdinal"
        FROM projection_threads
      `;
      const renamedParent = allocatorRows.find((row) => row.id === "renamed-parent");
      if (!renamedParent) {
        throw new Error("Expected renamed parent after migration");
      }
      assert.strictEqual(
        resolveNextForkTitle({ sourceThread: renamedParent, threads: allocatorRows }).title,
        "Greeting (3)",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
