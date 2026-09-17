import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkspaceAuthorityProjection, layer } from "./WorkspaceAuthorityProjection.ts";

const PROJECT_ID = ProjectId.make("authority-projection-project");
const THREAD_ID = ThreadId.make("authority-projection-thread");
const NOW = "2026-08-30T12:00:00.000Z";

const TestLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("WorkspaceAuthorityProjection", () => {
  it.effect("revises only when projected workspace authority changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID}, 'Project', '/projects/original', '[]', ${NOW}, ${NOW}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, workspace_root, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          ${THREAD_ID}, ${PROJECT_ID}, NULL, 'Thread',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access', 'default', NULL, '/worktrees/a', NULL,
          ${NOW}, ${NOW}, NULL, NULL
        )
      `;

      const appendEvent = (input: {
        readonly eventId: string;
        readonly aggregateKind: "project" | "thread";
        readonly streamId: string;
        readonly streamVersion: number;
        readonly eventType: string;
        readonly payload: object;
      }) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          ${input.eventId}, ${input.aggregateKind}, ${input.streamId},
          ${input.streamVersion}, ${input.eventType}, ${NOW}, 'client',
          ${JSON.stringify(input.payload)}, '{}'
        )
      `;

      yield* appendEvent({
        eventId: "event-project-created",
        aggregateKind: "project",
        streamId: PROJECT_ID,
        streamVersion: 1,
        eventType: "project.created",
        payload: { projectId: PROJECT_ID, workspaceRoot: "/projects/original" },
      });
      yield* appendEvent({
        eventId: "event-thread-created",
        aggregateKind: "thread",
        streamId: THREAD_ID,
        streamVersion: 1,
        eventType: "thread.created",
        payload: { threadId: THREAD_ID, projectId: PROJECT_ID, worktreePath: "/worktrees/a" },
      });
      yield* appendEvent({
        eventId: "event-thread-title",
        aggregateKind: "thread",
        streamId: THREAD_ID,
        streamVersion: 2,
        eventType: "thread.meta-updated",
        payload: { threadId: THREAD_ID, title: "Renamed" },
      });
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.projects', 3, ${NOW}), ('projection.threads', 3, ${NOW})
      `;

      const projection = yield* WorkspaceAuthorityProjection;
      const initial = yield* projection.getThreadContext(THREAD_ID);
      expect(Option.isSome(initial)).toBe(true);
      if (Option.isNone(initial)) return;
      expect(initial.value.scopeRevision).toBe(2);
      expect(yield* projection.getProjectContext(PROJECT_ID)).toEqual(
        Option.some({
          projectId: PROJECT_ID,
          workspaceRoot: "/projects/original",
          scopeRevision: 1,
        }),
      );
      expect(yield* projection.listRegisteredRoots()).toEqual([
        { projectId: PROJECT_ID, threadId: null, workspaceRoot: "/projects/original" },
        { projectId: PROJECT_ID, threadId: THREAD_ID, workspaceRoot: "/worktrees/a" },
      ]);

      yield* appendEvent({
        eventId: "event-thread-worktree-b",
        aggregateKind: "thread",
        streamId: THREAD_ID,
        streamVersion: 3,
        eventType: "thread.meta-updated",
        payload: { threadId: THREAD_ID, worktreePath: "/worktrees/b" },
      });
      yield* sql`UPDATE projection_threads SET worktree_path = '/worktrees/b' WHERE thread_id = ${THREAD_ID}`;
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 4
        WHERE projector = 'projection.threads'
      `;
      const moved = yield* projection.getThreadContext(THREAD_ID);
      expect(Option.isSome(moved)).toBe(true);
      if (Option.isNone(moved)) return;
      expect(moved.value.worktreePath).toBe("/worktrees/b");
      expect(moved.value.scopeRevision).toBe(4);

      yield* appendEvent({
        eventId: "event-thread-title-again",
        aggregateKind: "thread",
        streamId: THREAD_ID,
        streamVersion: 4,
        eventType: "thread.meta-updated",
        payload: { threadId: THREAD_ID, title: "Renamed again" },
      });
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 5
        WHERE projector = 'projection.threads'
      `;
      const titleOnly = yield* projection.getThreadContext(THREAD_ID);
      expect(Option.isSome(titleOnly)).toBe(true);
      if (Option.isNone(titleOnly)) return;
      expect(titleOnly.value.scopeRevision).toBe(4);
      expect(Option.getOrThrow(yield* projection.getProjectContext(PROJECT_ID)).scopeRevision).toBe(
        1,
      );

      yield* appendEvent({
        eventId: "event-project-root",
        aggregateKind: "project",
        streamId: PROJECT_ID,
        streamVersion: 2,
        eventType: "project.meta-updated",
        payload: { projectId: PROJECT_ID, workspaceRoot: "/projects/replacement" },
      });
      yield* sql`
        UPDATE projection_projects SET workspace_root = '/projects/replacement'
        WHERE project_id = ${PROJECT_ID}
      `;
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 6
        WHERE projector = 'projection.projects'
      `;
      const projectMoved = yield* projection.getThreadContext(THREAD_ID);
      expect(Option.isSome(projectMoved)).toBe(true);
      if (Option.isNone(projectMoved)) return;
      expect(projectMoved.value.projectWorkspaceRoot).toBe("/projects/replacement");
      expect(projectMoved.value.scopeRevision).toBe(6);
      expect(Option.getOrThrow(yield* projection.getProjectContext(PROJECT_ID)).scopeRevision).toBe(
        6,
      );

      yield* appendEvent({
        eventId: "event-project-root-return",
        aggregateKind: "project",
        streamId: PROJECT_ID,
        streamVersion: 3,
        eventType: "project.meta-updated",
        payload: { projectId: PROJECT_ID, workspaceRoot: "/projects/original" },
      });
      // Unprojected events cannot invalidate the projected authority receipt.
      expect(Option.getOrThrow(yield* projection.getProjectContext(PROJECT_ID)).scopeRevision).toBe(
        6,
      );
      yield* sql`UPDATE projection_projects SET workspace_root = '/projects/original' WHERE project_id = ${PROJECT_ID}`;
      yield* sql`UPDATE projection_state SET last_applied_sequence = 7 WHERE projector = 'projection.projects'`;
      expect(yield* projection.getProjectContext(PROJECT_ID)).toEqual(
        Option.some({
          projectId: PROJECT_ID,
          workspaceRoot: "/projects/original",
          scopeRevision: 7,
        }),
      );

      yield* sql`UPDATE projection_threads SET archived_at = ${NOW} WHERE thread_id = ${THREAD_ID}`;
      expect(yield* projection.listRegisteredRoots()).toEqual([
        { projectId: PROJECT_ID, threadId: null, workspaceRoot: "/projects/original" },
      ]);
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${PROJECT_ID}`;
      expect(yield* projection.listRegisteredRoots()).toEqual([]);
      expect(yield* projection.getProjectContext(PROJECT_ID)).toEqual(Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );
});
