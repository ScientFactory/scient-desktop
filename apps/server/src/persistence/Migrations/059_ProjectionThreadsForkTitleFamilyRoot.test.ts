import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { resolveNextForkTitle, type ForkTitleThread } from "../../orchestration/forkTitle.ts";

describe("059_ProjectionThreadsForkTitleFamilyRoot", () => {
  it.effect("freezes descendant families across later and earlier ancestor renames", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const createdAt = "2026-07-22T10:00:00.000Z";

      const insertThread = (input: {
        readonly id: string;
        readonly title: string;
        readonly sourceId?: string;
        readonly base?: string;
        readonly ordinal?: number;
      }) =>
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
              ${input.id},
              'project-1',
              ${input.title},
              '{"provider":"codex","model":"gpt-5-codex"}',
              'approval-required',
              'default',
              'local',
              0,
              0,
              ${input.sourceId ?? null},
              ${input.base ?? null},
              ${input.ordinal ?? null},
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
              ${`event-created-${input.id}`},
              'thread',
              ${input.id},
              1,
              'thread.created',
              ${createdAt},
              ${`command-created-${input.id}`},
              NULL,
              ${`command-created-${input.id}`},
              'client',
              ${JSON.stringify({
                threadId: input.id,
                projectId: "project-1",
                title: input.title,
                forkSourceThreadId: input.sourceId ?? null,
                forkTitleBase: input.base ?? null,
                forkTitleOrdinal: input.ordinal ?? null,
                createdAt,
                updatedAt: createdAt,
              })},
              '{}'
            )
          `;
        });

      const rename = (threadId: string, version: number, title: string) =>
        Effect.gen(function* () {
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
              ${`event-title-${threadId}-${version}`},
              'thread',
              ${threadId},
              ${version},
              'thread.meta-updated',
              ${createdAt},
              ${`command-title-${threadId}-${version}`},
              NULL,
              ${`command-title-${threadId}-${version}`},
              'client',
              ${JSON.stringify({ threadId, title, updatedAt: createdAt })},
              '{}'
            )
          `;
          yield* sql`
            UPDATE projection_threads
            SET
              title = ${title},
              fork_title_base = NULL,
              fork_title_ordinal = NULL
            WHERE thread_id = ${threadId}
          `;
        });

      yield* insertThread({ id: "root", title: "Greeting" });
      yield* insertThread({
        id: "fork-2",
        title: "Greeting (2)",
        sourceId: "root",
        base: "Greeting",
        ordinal: 2,
      });
      // Created before fork-2 is renamed, so this descendant must retain root.
      yield* insertThread({
        id: "fork-3",
        title: "Greeting (3)",
        sourceId: "fork-2",
        base: "Greeting",
        ordinal: 3,
      });
      // Emulate the earlier buggy migration 058: a no-op title event cleared
      // the already-completed projection metadata while event truth retained it.
      yield* rename("fork-3", 2, "Greeting (3)");
      yield* insertThread({
        id: "fork-4",
        title: "Greeting (4)",
        sourceId: "root",
        base: "Greeting",
        ordinal: 4,
      });
      yield* rename("fork-2", 2, "Experiment");
      yield* rename("fork-2", 3, "Greeting");
      // Created after a rename-away and rename-back, so this is fork-2's new family.
      yield* insertThread({
        id: "renamed-child-2",
        title: "Greeting (2)",
        sourceId: "fork-2",
        base: "Greeting",
        ordinal: 2,
      });

      yield* runMigrations();
      yield* runMigrations();

      const createdRoots = yield* sql<{
        readonly id: string;
        readonly familyRootId: string | null;
        readonly base: string | null;
        readonly ordinal: number | null;
      }>`
        SELECT
          stream_id AS id,
          json_extract(payload_json, '$.forkTitleFamilyRootId') AS "familyRootId",
          json_extract(payload_json, '$.forkTitleBase') AS base,
          json_extract(payload_json, '$.forkTitleOrdinal') AS ordinal
        FROM orchestration_events
        WHERE event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      assert.deepEqual(createdRoots, [
        { id: "fork-2", familyRootId: "root", base: "Greeting", ordinal: 2 },
        { id: "fork-3", familyRootId: "root", base: "Greeting", ordinal: 3 },
        { id: "fork-4", familyRootId: "root", base: "Greeting", ordinal: 4 },
        {
          id: "renamed-child-2",
          familyRootId: "fork-2",
          base: "Greeting",
          ordinal: 2,
        },
        { id: "root", familyRootId: null, base: null, ordinal: null },
      ]);

      const projectedRoots = yield* sql<{
        readonly id: string;
        readonly familyRootId: string | null;
        readonly base: string | null;
        readonly ordinal: number | null;
      }>`
        SELECT
          thread_id AS id,
          fork_title_family_root_id AS "familyRootId",
          fork_title_base AS base,
          fork_title_ordinal AS ordinal
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      // Replaying the creation roots and the two title updates produces this
      // exact projection: only the renamed ancestor itself loses its old family.
      assert.deepEqual(projectedRoots, [
        { id: "fork-2", familyRootId: null, base: null, ordinal: null },
        { id: "fork-3", familyRootId: "root", base: "Greeting", ordinal: 3 },
        { id: "fork-4", familyRootId: "root", base: "Greeting", ordinal: 4 },
        {
          id: "renamed-child-2",
          familyRootId: "fork-2",
          base: "Greeting",
          ordinal: 2,
        },
        { id: "root", familyRootId: null, base: null, ordinal: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("reconstructs legacy fork families in creation order across a later rename", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const createdAt = "2026-07-22T11:00:00.000Z";

      const insertLegacyThread = (input: {
        readonly id: string;
        readonly title: string;
        readonly sourceId?: string;
      }) =>
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
              pending_approval_count,
              pending_user_input_count,
              has_actionable_proposed_plan,
              created_at,
              updated_at
            )
            VALUES (
              ${input.id},
              'project-legacy',
              ${input.title},
              '{"provider":"codex","model":"gpt-5-codex"}',
              'approval-required',
              'default',
              'local',
              0,
              0,
              ${input.sourceId ?? null},
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
              ${`event-created-${input.id}`},
              'thread',
              ${input.id},
              1,
              'thread.created',
              ${createdAt},
              ${`command-created-${input.id}`},
              NULL,
              ${`command-created-${input.id}`},
              'client',
              ${JSON.stringify({
                threadId: input.id,
                projectId: "project-legacy",
                title: input.title,
                forkSourceThreadId: input.sourceId ?? null,
                createdAt,
                updatedAt: createdAt,
              })},
              '{}'
            )
          `;
        });

      yield* insertLegacyThread({ id: "legacy-root", title: "Greeting" });
      yield* insertLegacyThread({
        id: "legacy-child",
        title: "Greeting",
        sourceId: "legacy-root",
      });
      yield* insertLegacyThread({
        id: "legacy-grandchild",
        title: "Greeting",
        sourceId: "legacy-child",
      });
      yield* insertLegacyThread({
        id: "legacy-sibling",
        title: "Greeting",
        sourceId: "legacy-root",
      });
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
          'event-title-legacy-child-2',
          'thread',
          'legacy-child',
          2,
          'thread.meta-updated',
          ${createdAt},
          'command-title-legacy-child-2',
          NULL,
          'command-title-legacy-child-2',
          'client',
          ${JSON.stringify({
            threadId: "legacy-child",
            title: "Experiment",
            updatedAt: createdAt,
          })},
          '{}'
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET title = 'Experiment'
        WHERE thread_id = 'legacy-child'
      `;
      yield* insertLegacyThread({
        id: "legacy-renamed-child",
        title: "Experiment",
        sourceId: "legacy-child",
      });

      yield* runMigrations();
      yield* runMigrations();

      const createdRoots = yield* sql<{
        readonly id: string;
        readonly familyRootId: string | null;
        readonly base: string | null;
        readonly ordinal: number | null;
      }>`
        SELECT
          stream_id AS id,
          json_extract(payload_json, '$.forkTitleFamilyRootId') AS "familyRootId",
          json_extract(payload_json, '$.forkTitleBase') AS base,
          json_extract(payload_json, '$.forkTitleOrdinal') AS ordinal
        FROM orchestration_events
        WHERE event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      assert.deepEqual(createdRoots, [
        {
          id: "legacy-child",
          familyRootId: "legacy-root",
          base: "Greeting",
          ordinal: 2,
        },
        {
          id: "legacy-grandchild",
          familyRootId: "legacy-root",
          base: "Greeting",
          ordinal: 3,
        },
        {
          id: "legacy-renamed-child",
          familyRootId: "legacy-child",
          base: "Experiment",
          ordinal: 2,
        },
        { id: "legacy-root", familyRootId: null, base: null, ordinal: null },
        {
          id: "legacy-sibling",
          familyRootId: "legacy-root",
          base: "Greeting",
          ordinal: 4,
        },
      ]);

      const projectedRoots = yield* sql<{
        readonly id: string;
        readonly familyRootId: string | null;
        readonly base: string | null;
        readonly ordinal: number | null;
      }>`
        SELECT
          thread_id AS id,
          fork_title_family_root_id AS "familyRootId",
          fork_title_base AS base,
          fork_title_ordinal AS ordinal
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepEqual(projectedRoots, [
        { id: "legacy-child", familyRootId: null, base: null, ordinal: null },
        {
          id: "legacy-grandchild",
          familyRootId: "legacy-root",
          base: "Greeting",
          ordinal: 3,
        },
        {
          id: "legacy-renamed-child",
          familyRootId: "legacy-child",
          base: "Experiment",
          ordinal: 2,
        },
        { id: "legacy-root", familyRootId: null, base: null, ordinal: null },
        {
          id: "legacy-sibling",
          familyRootId: "legacy-root",
          base: "Greeting",
          ordinal: 4,
        },
      ]);

      const allocatorRows = yield* sql<{
        readonly id: string;
        readonly projectId: string;
        readonly title: string;
        readonly forkSourceThreadId: string | null;
        readonly sidechatSourceThreadId: string | null;
        readonly forkTitleFamilyRootId: string | null;
        readonly forkTitleBase: string | null;
        readonly forkTitleOrdinal: number | null;
      }>`
        SELECT
          thread_id AS id,
          project_id AS "projectId",
          title,
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          fork_title_family_root_id AS "forkTitleFamilyRootId",
          fork_title_base AS "forkTitleBase",
          fork_title_ordinal AS "forkTitleOrdinal"
        FROM projection_threads
      `;
      const allocatorThreads = allocatorRows satisfies ReadonlyArray<ForkTitleThread>;
      for (const sourceId of ["legacy-grandchild", "legacy-sibling"]) {
        const sourceThread = allocatorThreads.find((thread) => thread.id === sourceId);
        if (!sourceThread) {
          throw new Error(`Expected migrated source thread ${sourceId}`);
        }
        assert.strictEqual(
          resolveNextForkTitle({ sourceThread, threads: allocatorThreads }).title,
          "Greeting (5)",
        );
      }
      const renamedSource = allocatorThreads.find((thread) => thread.id === "legacy-renamed-child");
      if (!renamedSource) {
        throw new Error("Expected migrated renamed-family source thread");
      }
      assert.strictEqual(
        resolveNextForkTitle({ sourceThread: renamedSource, threads: allocatorThreads }).title,
        "Experiment (3)",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
