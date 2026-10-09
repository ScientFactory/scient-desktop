/**
 * Workspace authority revisions. Each appended project or thread state is
 * stamped with the sequence at which its workspace last changed, carried
 * forward while the workspace stays the same.
 */
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2DomainEventJson,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as OrchestrationEventStore from "./OrchestrationEventStore.ts";
import {
  decodeJson,
  decodeProjectEvent,
  decodeV2EventJson,
  encodeJson,
} from "./OrchestrationEventStore.ts";

const isThreadState = Schema.is(OrchestrationV2AppThread);
const threadStateJson = Schema.fromJsonString(OrchestrationV2AppThreadJson);
const decodeThreadState = Schema.decodeUnknownEffect(threadStateJson);
const encodeThreadState = Schema.encodeEffect(threadStateJson);

/** Stamps an appended project event's metadata, then decodes it as the store returns it. */
export const stampProjectWorkspaceAuthorityRevision = (
  sql: SqlClient.SqlClient,
  event: OrchestrationEventStore.UnsequencedProjectEvent,
  row: { readonly sequence: number; readonly metadata: object },
) =>
  Effect.gen(function* () {
    const previous = yield* sql<{
      readonly workspaceRoot: string;
      readonly scopeRevision: number | null;
    }>`
      SELECT json_extract(source.payload_json, '$.workspaceRoot') AS "workspaceRoot",
        (
          SELECT json_extract(stamped.metadata_json, '$.workspaceAuthorityRevision')
          FROM orchestration_events stamped
          WHERE stamped.aggregate_kind = 'project' AND stamped.stream_id = ${event.aggregateId}
            AND stamped.sequence < ${row.sequence}
            AND CASE WHEN json_valid(stamped.metadata_json)
              THEN json_type(stamped.metadata_json, '$.workspaceAuthorityRevision') = 'integer'
              ELSE 0 END
          ORDER BY stamped.sequence DESC LIMIT 1
        ) AS "scopeRevision"
      FROM orchestration_events source
      WHERE source.aggregate_kind = 'project' AND source.stream_id = ${event.aggregateId}
        AND source.sequence < ${row.sequence}
        AND CASE WHEN json_valid(source.payload_json)
          THEN json_type(source.payload_json, '$.workspaceRoot') = 'text' ELSE 0 END
      ORDER BY source.sequence DESC LIMIT 1
    `;
    const prior = previous[0];
    const root = event.type === "project.deleted" ? undefined : event.payload.workspaceRoot;
    const workspaceAuthorityRevision =
      event.type !== "project.created" &&
      prior !== undefined &&
      prior.scopeRevision !== null &&
      (root === undefined || root === prior.workspaceRoot)
        ? prior.scopeRevision
        : row.sequence;
    const metadata = { ...row.metadata, workspaceAuthorityRevision };
    yield* sql`UPDATE orchestration_events SET metadata_json = ${yield* encodeJson(metadata)}
      WHERE sequence = ${row.sequence}`;
    return yield* decodeProjectEvent({ ...row, metadata });
  });

/** Stamps an appended thread state's payload; other events pass through unchanged. */
export const stampThreadWorkspaceAuthorityRevision = (
  sql: SqlClient.SqlClient,
  input: {
    readonly event: OrchestrationV2DomainEvent;
    readonly sequence: number | undefined;
    readonly encoded: typeof OrchestrationV2DomainEventJson.Encoded;
  },
) =>
  Effect.gen(function* () {
    const { event, sequence, encoded } = input;
    let persistedEvent = event;
    if (sequence !== undefined && isThreadState(event.payload)) {
      const previous = yield* sql<{
        readonly sequence: number;
        readonly payload_json: string;
      }>`
        SELECT sequence, payload_json FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${event.threadId}
          AND application_event_version = 2 AND sequence < ${sequence}
          AND CASE WHEN json_valid(payload_json)
            THEN json_type(payload_json, '$.lineage.rootThreadId') = 'text' ELSE 0 END
        ORDER BY sequence DESC LIMIT 1
      `;
      const priorRow = previous[0];
      const prior =
        priorRow === undefined ? undefined : yield* decodeThreadState(priorRow.payload_json);
      const workspaceAuthorityRevision =
        event.type !== "thread.created" &&
        prior !== undefined &&
        prior.workspaceAuthorityRevision !== undefined &&
        prior.projectId === event.payload.projectId &&
        prior.worktreePath === event.payload.worktreePath
          ? prior.workspaceAuthorityRevision
          : sequence;
      const payloadJson = yield* encodeThreadState({
        ...event.payload,
        workspaceAuthorityRevision,
      });
      yield* sql`UPDATE orchestration_events SET payload_json = ${payloadJson}
        WHERE sequence = ${sequence}`;
      persistedEvent = yield* decodeV2EventJson({
        ...encoded,
        payload: yield* decodeJson(payloadJson),
      });
    }
    return persistedEvent;
  });
