import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { PROJECT_WORKSPACE_AUTHORITY_PREFIX } from "./WorkspaceAuthorityRevision.ts";

import {
  WorkspaceAuthorityScopeRevision,
  type WorkspaceAuthorityScopeRevision as WorkspaceAuthorityScopeRevisionType,
  WorkspaceBindingResolutionError,
} from "./WorkspaceBinding.ts";

const WorkspaceAuthorityProjectionRequest = Schema.Struct({ threadId: ThreadId });

const ProjectContextRow = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  scopeRevision: Schema.Int,
});

const RegisteredRootRow = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceRoot: Schema.String,
});

export interface WorkspaceProjectContext {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly scopeRevision: WorkspaceAuthorityScopeRevisionType;
}

const WorkspaceAuthorityProjectionRow = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  worktreePath: Schema.NullOr(Schema.String),
  projectWorkspaceRoot: Schema.NullOr(Schema.String),
  scopeRevision: Schema.Int,
});

export interface WorkspaceAuthorityProjectionContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly worktreePath: string | null;
  readonly projectWorkspaceRoot: string | null;
  readonly scopeRevision: WorkspaceAuthorityScopeRevisionType;
}

/**
 * App-private projection bridge for workspace authority.
 *
 * The native V2 projection supplies the workspace and its committed revision.
 * A title, model or attention update retains the revision; a workspace change
 * receives a new canonical sequence. Unstamped pre-cutover rows fail closed.
 */
export class WorkspaceAuthorityProjection extends Context.Service<
  WorkspaceAuthorityProjection,
  {
    readonly listRegisteredRoots: () => Effect.Effect<
      ReadonlyArray<typeof RegisteredRootRow.Type>,
      WorkspaceBindingResolutionError
    >;
    readonly getProjectContext: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<WorkspaceProjectContext>, WorkspaceBindingResolutionError>;
    readonly getThreadContext: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<WorkspaceAuthorityProjectionContext>,
      WorkspaceBindingResolutionError
    >;
  }
>()("t3/scient/projectScope/WorkspaceAuthorityProjection") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRoots = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RegisteredRootRow,
    execute: () => sql`
      SELECT project_id AS "projectId", NULL AS "threadId", workspace_root AS "workspaceRoot"
      FROM projection_projects WHERE deleted_at IS NULL
      UNION ALL
      SELECT projects.project_id AS "projectId", threads.thread_id AS "threadId",
        json_extract(threads.payload_json, '$.worktreePath') AS "workspaceRoot"
      FROM orchestration_v2_projection_threads threads
      JOIN projection_projects projects ON projects.project_id = threads.project_id
      WHERE projects.deleted_at IS NULL AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL AND json_type(threads.payload_json, '$.worktreePath') = 'text'
      ORDER BY "projectId", "threadId"
    `,
  });

  const readProjectContext = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: ProjectContextRow,
    execute: ({ projectId }) => sql`
      SELECT projects.project_id AS "projectId", projects.workspace_root AS "workspaceRoot",
        COALESCE(authority.last_sequence, 0) AS "scopeRevision"
      FROM projection_projects projects
      LEFT JOIN orchestration_v2_projection_metadata authority
        ON authority.projection_name = ${PROJECT_WORKSPACE_AUTHORITY_PREFIX}
          || json_array(projects.project_id, projects.workspace_root)
      WHERE projects.project_id = ${projectId} AND projects.deleted_at IS NULL
      LIMIT 1
    `,
  });

  const projectionError = (cause: unknown) =>
    new WorkspaceBindingResolutionError({
      operation: "read-workspace-authority-projection",
      kind: "workspace-unavailable",
      cause,
    });

  const listRegisteredRoots = () => listRoots(undefined).pipe(Effect.mapError(projectionError));
  const getProjectContext = Effect.fn("WorkspaceAuthorityProjection.getProjectContext")(function* (
    projectId: ProjectId,
  ) {
    const row = yield* readProjectContext({ projectId }).pipe(Effect.mapError(projectionError));
    if (Option.isNone(row)) return Option.none();
    if (row.value.scopeRevision < 1)
      return yield* projectionError("Missing project authority revision.");
    return Option.some({
      ...row.value,
      scopeRevision: WorkspaceAuthorityScopeRevision.make(row.value.scopeRevision),
    });
  });

  const readThreadContext = SqlSchema.findOneOption({
    Request: WorkspaceAuthorityProjectionRequest,
    Result: WorkspaceAuthorityProjectionRow,
    execute: ({ threadId }) => sql`
      SELECT threads.thread_id AS "threadId", threads.project_id AS "projectId",
        json_extract(threads.payload_json, '$.worktreePath') AS "worktreePath",
        projects.workspace_root AS "projectWorkspaceRoot",
        CASE
          WHEN json_type(threads.payload_json, '$.workspaceAuthorityRevision') <> 'integer'
            OR json_type(threads.payload_json, '$.workspaceAuthorityRevision') IS NULL
            OR (projects.project_id IS NOT NULL AND authority.last_sequence IS NULL)
          THEN 0
          ELSE MAX(json_extract(threads.payload_json, '$.workspaceAuthorityRevision'),
            COALESCE(authority.last_sequence, 0))
        END AS "scopeRevision"
      FROM orchestration_v2_projection_threads threads
      LEFT JOIN projection_projects projects ON projects.project_id = threads.project_id
        AND projects.deleted_at IS NULL
      LEFT JOIN orchestration_v2_projection_metadata authority
        ON authority.projection_name = ${PROJECT_WORKSPACE_AUTHORITY_PREFIX}
          || json_array(projects.project_id, projects.workspace_root)
      WHERE threads.thread_id = ${threadId}
        AND threads.deleted_at IS NULL AND threads.archived_at IS NULL
        AND (threads.project_id IS NULL OR projects.project_id IS NOT NULL)
      LIMIT 1
    `,
  });

  const getThreadContext: WorkspaceAuthorityProjection["Service"]["getThreadContext"] = Effect.fn(
    "WorkspaceAuthorityProjection.getThreadContext",
  )(function* (threadId) {
    const row = yield* readThreadContext({ threadId }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBindingResolutionError({
            operation: "read-workspace-authority-projection",
            kind: "workspace-unavailable",
            cause,
          }),
      ),
    );
    if (Option.isNone(row)) return Option.none();
    if (row.value.scopeRevision < 1) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "read-workspace-authority-revision",
        kind: "workspace-unavailable",
      });
    }
    return Option.some({
      threadId: row.value.threadId,
      projectId: row.value.projectId,
      worktreePath: row.value.worktreePath,
      projectWorkspaceRoot: row.value.projectWorkspaceRoot,
      scopeRevision: WorkspaceAuthorityScopeRevision.make(row.value.scopeRevision),
    });
  });

  return WorkspaceAuthorityProjection.of({
    getThreadContext,
    listRegisteredRoots,
    getProjectContext,
  });
});

export const layer = Layer.effect(WorkspaceAuthorityProjection, make);
