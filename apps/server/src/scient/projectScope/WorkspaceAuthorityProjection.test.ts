import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { WorkspaceAuthorityProjection, layer } from "./WorkspaceAuthorityProjection.ts";

const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect(
  "does not grant legacy thread rows or unstamped project rows V2 workspace authority",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("legacy-authority-project");
      const threadId = ThreadId.make("legacy-authority-thread");
      const now = "2026-10-04T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Legacy', '/legacy', '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Legacy', '{"instanceId":"codex","model":"fixture"}',
        'full-access', 'default', ${now}, ${now})`;
      const projection = yield* WorkspaceAuthorityProjection;
      expect(yield* projection.getThreadContext(threadId)).toEqual(Option.none());
      const failure = yield* projection.getProjectContext(projectId).pipe(Effect.flip);
      expect(failure.kind).toBe("workspace-unavailable");
    }).pipe(Effect.provide(testLayer)),
);
