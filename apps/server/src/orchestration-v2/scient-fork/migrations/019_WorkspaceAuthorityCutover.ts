/**
 * Adopt the committed workspace read models into stamped V2 authority.
 * Never infer applied state from the global replay cursor or a matching root
 * in the log: an appended event may not have reached its projection yet.
 * The explicit baseline records exactly the projected state at cutover.
 */
import { EventId, OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../EventStore.ts";
import * as ProjectStore from "../../ProjectStore.ts";
import * as ProjectionStore from "../../ProjectionStore.ts";
import { projectWorkspaceAuthorityKey } from "../../../scient/projectScope/WorkspaceAuthorityRevision.ts";

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('projection_projects', 'orchestration_v2_projection_threads',
        'orchestration_v2_projection_metadata')
  `;
  // Older fork-only schemas do not own a V2 workspace projection yet.
  if (tables.length !== 3) return;
  yield* Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    for (const row of yield* projects.list({ includeDeleted: true })) {
      const existing = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_metadata
        WHERE projection_name = ${projectWorkspaceAuthorityKey(row.projectId, row.workspaceRoot)}
      `;
      if (existing.length > 0) continue;
      const created = yield* events.appendProjectEvent({
        eventId: EventId.make(`scient:workspace-authority:project:${row.projectId}:created`),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: row.projectId,
        occurredAt: row.updatedAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId: row.projectId,
          title: row.title,
          workspaceRoot: row.workspaceRoot,
          defaultModelSelection: row.defaultModelSelection,
          defaultThreadEnvMode: row.defaultThreadEnvMode,
          faviconPath: row.faviconPath,
          projectIcon: row.projectIcon,
          scripts: row.scripts,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
      yield* projects.apply(created);
      const settings = yield* events.appendProjectEvent({
        eventId: EventId.make(`scient:workspace-authority:project:${row.projectId}:settings`),
        type: "project.meta-updated",
        aggregateKind: "project",
        aggregateId: row.projectId,
        occurredAt: row.updatedAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { projectId: row.projectId, autoPull: row.autoPull, updatedAt: row.updatedAt },
      });
      yield* projects.apply(settings);
      if (row.deletedAt !== null) {
        const deleted = yield* events.appendProjectEvent({
          eventId: EventId.make(`scient:workspace-authority:project:${row.projectId}:deleted`),
          type: "project.deleted",
          aggregateKind: "project",
          aggregateId: row.projectId,
          occurredAt: row.deletedAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { projectId: row.projectId, deletedAt: row.deletedAt },
        });
        yield* projects.apply(deleted);
      }
    }
    const threads = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads
      WHERE json_type(payload_json, '$.workspaceAuthorityRevision') IS NULL
      ORDER BY thread_id
    `;
    for (const row of threads) {
      const thread = yield* decodeThread(row.payload_json);
      const stored = yield* events.append({
        events: [
          {
            id: EventId.make(`scient:workspace-authority:thread:${thread.id}`),
            type: "thread.metadata-updated",
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: thread.updatedAt,
            payload: thread,
          },
        ],
      });
      for (const event of stored) yield* projection.apply(event.event);
    }
  }).pipe(
    Effect.provide(Layer.mergeAll(EventStore.layer, ProjectStore.layer, ProjectionStore.layer)),
    sql.withTransaction,
  );
});
