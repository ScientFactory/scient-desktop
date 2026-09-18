import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

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
 * The inherited shell projection remains the product read model. This narrow
 * query adds one Scient-owned guarantee it does not need: a monotonic revision
 * of only the thread/project events that can change filesystem authority.
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
        threads.worktree_path AS "workspaceRoot"
      FROM projection_threads threads
      JOIN projection_projects projects ON projects.project_id = threads.project_id
      WHERE projects.deleted_at IS NULL AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL AND threads.worktree_path IS NOT NULL
      ORDER BY "projectId", "threadId"
    `,
  });

  const readProjectContext = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: ProjectContextRow,
    execute: ({ projectId }) => sql`
      SELECT projects.project_id AS "projectId", projects.workspace_root AS "workspaceRoot",
        COALESCE((
          SELECT MAX(events.sequence) FROM orchestration_events events
          WHERE events.aggregate_kind = 'project' AND events.stream_id = projects.project_id
            AND events.sequence <= COALESCE((SELECT last_applied_sequence FROM projection_state
              WHERE projector = 'projection.projects'), 0)
            AND (events.event_type = 'project.created' OR (
              events.event_type = 'project.meta-updated'
              AND json_type(events.payload_json, '$.workspaceRoot') IS NOT NULL
            ))
        ), 0) AS "scopeRevision"
      FROM projection_projects projects
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
      WITH authority_cursors AS (
        SELECT
          COALESCE(
            MAX(
              CASE
                WHEN projector = 'projection.threads' THEN last_applied_sequence
                ELSE NULL
              END
            ),
            0
          ) AS thread_cursor,
          COALESCE(
            MAX(
              CASE
                WHEN projector = 'projection.projects' THEN last_applied_sequence
                ELSE NULL
              END
            ),
            0
          ) AS project_cursor
        FROM projection_state
      )
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        threads.worktree_path AS "worktreePath",
        projects.workspace_root AS "projectWorkspaceRoot",
        MAX(
          COALESCE(
            (
              SELECT MAX(events.sequence)
              FROM orchestration_events events
              WHERE events.aggregate_kind = 'thread'
                AND events.stream_id = threads.thread_id
                AND events.sequence <= authority_cursors.thread_cursor
                AND (
                  events.event_type = 'thread.created'
                  OR (
                    events.event_type = 'thread.meta-updated'
                    AND (
                      json_type(events.payload_json, '$.projectId') IS NOT NULL
                      OR json_type(events.payload_json, '$.workspaceRoot') IS NOT NULL
                      OR json_type(events.payload_json, '$.worktreePath') IS NOT NULL
                    )
                  )
                )
            ),
            0
          ),
          COALESCE(
            (
              SELECT MAX(events.sequence)
              FROM orchestration_events events
              WHERE events.aggregate_kind = 'project'
                AND events.stream_id = threads.project_id
                AND events.sequence <= authority_cursors.project_cursor
                AND (
                  events.event_type = 'project.created'
                  OR (
                    events.event_type = 'project.meta-updated'
                    AND json_type(events.payload_json, '$.workspaceRoot') IS NOT NULL
                  )
                )
            ),
            0
          )
        ) AS "scopeRevision"
      FROM projection_threads threads
      CROSS JOIN authority_cursors
      LEFT JOIN projection_projects projects
        ON projects.project_id = threads.project_id
        AND projects.deleted_at IS NULL
      WHERE threads.thread_id = ${threadId}
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
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
