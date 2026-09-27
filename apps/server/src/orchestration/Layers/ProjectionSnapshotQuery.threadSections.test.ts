import { ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

/**
 * Scient thread sections: every snapshot path reads `section_id` back into
 * `sectionId`. The upstream tests only see null, which would pass even if a
 * mapping dropped the column.
 */
const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ProjectionSnapshotQuery thread sections", (it) => {
  it.effect("reads a thread's section on shell, archived, detail and read-model paths", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-filed");
      const archivedId = ThreadId.make("thread-filed-archived");
      const sectionId = ThreadSectionId.make("research");

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        )
        VALUES (
          'project-sections', 'Sections', '/tmp/sections',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-04-06T00:00:00.000Z', '2026-04-06T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, archived_at,
          deleted_at, section_id
        )
        VALUES (
          ${threadId}, 'project-sections', 'Filed Thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-04-06T00:00:02.000Z', '2026-04-06T00:00:05.000Z', NULL, NULL, ${sectionId}
        ),
        (
          ${archivedId}, 'project-sections', 'Archived Filed Thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-04-06T00:00:02.000Z', '2026-04-06T00:00:05.000Z',
          '2026-04-06T00:00:06.000Z', NULL, ${sectionId}
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shells = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shells.threads.find((thread) => thread.id === threadId)?.sectionId, sectionId);

      const shell = yield* snapshotQuery.getThreadShellById(threadId);
      assert.equal(Option.getOrUndefined(shell)?.sectionId, sectionId);

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.equal(Option.getOrUndefined(detail)?.sectionId, sectionId);

      const snapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(snapshot.threads.find((thread) => thread.id === threadId)?.sectionId, sectionId);

      const archived = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.equal(
        archived.threads.find((thread) => thread.id === archivedId)?.sectionId,
        sectionId,
      );

      const readModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(
        readModel.threads.find((thread) => thread.id === threadId)?.sectionId,
        sectionId,
      );
    }),
  );
});
