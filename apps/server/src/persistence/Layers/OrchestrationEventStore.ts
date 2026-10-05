import {
  ApplicationEventMetadata,
  ApplicationProjectEvent,
  type ApplicationStoredEvent,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2StoredEvent,
  ProjectId,
  ProjectIconOverride,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { replayAndBufferProjectedLiveEvents } from "../../orchestration-v2/LiveStreamBudget.ts";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import * as OrchestrationEventStore from "../Services/OrchestrationEventStore.ts";
// SCIENT-FORK:START — V1 event access.
import { makeV1EventAccess } from "./ScientV1EventAccess.ts";
// SCIENT-FORK:END

const encodeProjectIcon = Schema.encodeSync(ProjectIconOverride);
const decodeProjectEvent = Schema.decodeUnknownEffect(ApplicationProjectEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(ApplicationEventMetadata);
const ProjectEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
]);
const ActorKind = Schema.Literals(["client", "server", "provider"]);

const AppendProjectEventRequestSchema = Schema.Struct({
  eventId: EventId,
  streamId: ProjectId,
  type: ProjectEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: ActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const ProjectEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: ProjectEventType,
  aggregateKind: Schema.Literal("project"),
  aggregateId: ProjectId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const READ_PAGE_SIZE = 500;

interface ApplicationEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly command_id: string | null;
  readonly aggregate_kind: "project" | "thread";
  readonly stream_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
  readonly metadata_json: string;
  readonly application_event_version: number;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
}

const decodeV2EventJson = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const encodeV2EventJson = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const decodeV2StoredEvent = Schema.decodeUnknownEffect(OrchestrationV2StoredEvent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isThreadState = Schema.is(OrchestrationV2AppThread);
const threadStateJson = Schema.fromJsonString(OrchestrationV2AppThreadJson);
const decodeThreadState = Schema.decodeUnknownEffect(threadStateJson);
const encodeThreadState = Schema.encodeEffect(threadStateJson);

function metadataForV2Event(event: OrchestrationV2DomainEvent): Record<string, unknown> {
  return {
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    ...(event.driver === undefined ? {} : { driver: event.driver }),
    ...(event.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: event.providerInstanceId }),
    ...(event.rawEventId === undefined ? {} : { rawEventId: event.rawEventId }),
  };
}

const rowToV2StoredEvent = Effect.fn("OrchestrationEventStore.rowToV2StoredEvent")(function* (
  row: ApplicationEventRow,
) {
  const payload = yield* decodeJson(row.payload_json);
  const metadata = yield* decodeJson(row.metadata_json);
  const values =
    typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const event = yield* decodeV2EventJson({
    id: row.event_id,
    threadId: row.stream_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    payload,
    ...(values.runId === undefined ? {} : { runId: values.runId }),
    ...(values.nodeId === undefined ? {} : { nodeId: values.nodeId }),
    ...(values.driver === undefined ? {} : { driver: values.driver }),
    ...(values.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: values.providerInstanceId }),
    ...(values.rawEventId === undefined ? {} : { rawEventId: values.rawEventId }),
  });
  return yield* decodeV2StoredEvent({
    sequence: row.sequence,
    commandId: row.command_id,
    event,
  });
});

const rowToProjectEvent = Effect.fn("OrchestrationEventStore.rowToProjectEvent")(function* (
  row: ApplicationEventRow,
) {
  return yield* decodeProjectEvent({
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.event_type,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.stream_id,
    occurredAt: row.occurred_at,
    commandId: row.command_id,
    causationEventId: row.causation_event_id,
    correlationId: row.correlation_id,
    payload: yield* decodeJson(row.payload_json),
    metadata: yield* decodeJson(row.metadata_json),
  });
});

function rowToApplicationStoredEvent(
  row: ApplicationEventRow,
): Effect.Effect<ApplicationStoredEvent, Schema.SchemaError> {
  return row.aggregate_kind === "project" ? rowToProjectEvent(row) : rowToV2StoredEvent(row);
}

function inferActorKind(
  event: OrchestrationEventStore.UnsequencedProjectEvent,
): typeof ActorKind.Type {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

// SCIENT-FORK:START — shared with the Scient V1 event access.
export {
  ActorKind,
  decodeJson,
  encodeJson,
  encodeProjectIcon,
  READ_PAGE_SIZE,
  toPersistenceSqlOrDecodeError,
};
export type { ApplicationEventRow };
// SCIENT-FORK:END

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const committedEvents = yield* PubSub.unbounded<ApplicationStoredEvent>();

  const appendProjectEventRow = SqlSchema.findOne({
    Request: AppendProjectEventRequestSchema,
    Result: ProjectEventPersistedRowSchema,
    execute: (request) =>
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
          metadata_json,
          application_event_version
        )
        VALUES (
          ${request.eventId},
          'project',
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = 'project'
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson},
          2
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const appendProjectEvent: OrchestrationEventStore.OrchestrationEventStoreShape["appendProjectEvent"] =
    (event) =>
      appendProjectEventRow({
        eventId: event.eventId,
        streamId: event.aggregateId,
        type: event.type,
        causationEventId: event.causationEventId,
        correlationId: event.correlationId,
        actorKind: inferActorKind(event),
        occurredAt: event.occurredAt,
        commandId: event.commandId,
        payloadJson:
          event.type === "project.deleted" || !event.payload.projectIcon
            ? event.payload
            : { ...event.payload, projectIcon: encodeProjectIcon(event.payload.projectIcon) },
        metadataJson: event.metadata,
      }).pipe(
        Effect.flatMap((row) =>
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
          }),
        ),
        sql.withTransaction,
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.appendProjectEvent:insert",
            "OrchestrationEventStore.appendProjectEvent:decode",
          ),
        ),
      );

  const readApplicationRows = (input: {
    readonly afterSequence: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    readonly onlyAgentEvents?: boolean;
    readonly limit: number;
  }) =>
    sql<ApplicationEventRow>`
      SELECT
        sequence,
        event_id,
        command_id,
        aggregate_kind,
        stream_id,
        event_type,
        occurred_at,
        payload_json,
        metadata_json,
        application_event_version,
        causation_event_id,
        correlation_id
      FROM orchestration_events
      ${
        input.onlyAgentEvents === true
          ? sql``
          : sql`INDEXED BY idx_orchestration_events_application_high_water`
      }
      WHERE sequence > ${input.afterSequence}
        AND sequence <= ${input.throughSequence ?? Number.MAX_SAFE_INTEGER}
        AND (
          ${
            input.onlyAgentEvents === true
              ? sql`application_event_version = 2 AND aggregate_kind = 'thread'`
              : sql`aggregate_kind = 'project'
                    OR (application_event_version = 2 AND aggregate_kind = 'thread')`
          }
        )
        AND ${sql.and([
          ...(input.threadId === undefined ? [] : [sql`stream_id = ${input.threadId}`]),
          ...(input.commandId === undefined ? [] : [sql`command_id = ${input.commandId}`]),
          ...(input.eventType === undefined ? [] : [sql`event_type = ${input.eventType}`]),
        ])}
      ORDER BY sequence ASC
      LIMIT ${input.limit}
    `;

  const appendAgentEvents: OrchestrationEventStore.OrchestrationEventStoreShape["appendAgentEvents"] =
    (input) =>
      Effect.forEach(
        input.events,
        (event) =>
          Effect.gen(function* () {
            const encoded = yield* encodeV2EventJson(event);
            const rows = yield* sql<{ readonly sequence: number }>`
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
              metadata_json,
              application_event_version
            )
            VALUES (
              ${event.id},
              'thread',
              ${event.threadId},
              COALESCE(
                (
                  SELECT MAX(stream_version) + 1
                  FROM orchestration_events
                  WHERE aggregate_kind = 'thread' AND stream_id = ${event.threadId}
                ),
                0
              ),
              ${event.type},
              ${encoded.occurredAt},
              ${input.commandId ?? null},
              NULL,
              ${input.commandId ?? null},
              ${event.rawEventId === undefined ? "server" : "provider"},
              ${yield* encodeJson(encoded.payload)},
              ${yield* encodeJson(metadataForV2Event(event))},
              2
            )
            RETURNING sequence
          `;
            const sequence = rows[0]?.sequence;
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
                priorRow === undefined
                  ? undefined
                  : yield* decodeThreadState(priorRow.payload_json);
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
            return yield* decodeV2StoredEvent({
              sequence,
              commandId: input.commandId ?? null,
              event: persistedEvent,
            });
          }),
        { concurrency: 1 },
      ).pipe(
        sql.withTransaction,
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.appendAgentEvents:insert",
            "OrchestrationEventStore.appendAgentEvents:decode",
          ),
        ),
      );

  const readAgentEvents: OrchestrationEventStore.OrchestrationEventStoreShape["readAgentEvents"] = (
    input,
  ) => {
    const totalLimit =
      input?.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(input.limit));
    if (totalLimit === 0) {
      return Stream.empty;
    }
    return Stream.paginate(
      { cursor: input?.afterSequence ?? 0, remaining: totalLimit },
      ({ cursor, remaining }) => {
        const pageLimit = Math.min(remaining, READ_PAGE_SIZE);
        return readApplicationRows({
          afterSequence: cursor,
          ...(input?.throughSequence === undefined
            ? {}
            : { throughSequence: input.throughSequence }),
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.commandId === undefined ? {} : { commandId: input.commandId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
          onlyAgentEvents: true,
          limit: pageLimit,
        }).pipe(
          Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.readAgentEvents:query")),
          Effect.map((rows) => {
            const last = rows.at(-1);
            const nextRemaining = remaining - rows.length;
            return [
              rows,
              last === undefined ||
              rows.length < pageLimit ||
              nextRemaining <= 0 ||
              (input?.throughSequence !== undefined && last.sequence >= input.throughSequence)
                ? Option.none()
                : Option.some({ cursor: last.sequence, remaining: nextRemaining }),
            ] as const;
          }),
        );
      },
    ).pipe(
      Stream.mapEffect((row) =>
        rowToV2StoredEvent(row).pipe(
          Effect.mapError(
            toPersistenceDecodeError("OrchestrationEventStore.readAgentEvents:decode"),
          ),
        ),
      ),
    );
  };

  const getAgentReplayStats: OrchestrationEventStore.OrchestrationEventStoreShape["getAgentReplayStats"] =
    (input) =>
      sql<{
        readonly eventCount: number;
        readonly rawPayloadBytes: number;
        readonly hasCreateEvent: number;
      }>`
      SELECT
        COUNT(*) AS "eventCount",
        COALESCE(SUM(octet_length(payload_json)), 0) AS "rawPayloadBytes",
        COALESCE(MAX(event_type = 'thread.created'), 0) AS "hasCreateEvent"
      FROM (
        SELECT payload_json, event_type
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
          AND application_event_version = 2
          AND sequence > ${input.afterSequence}
          AND sequence <= ${input.throughSequence}
        ORDER BY sequence ASC
        LIMIT ${Math.max(0, Math.floor(input.maxEvents)) + 1}
      )
    `.pipe(
        Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.getAgentReplayStats:query")),
        Effect.map((rows) => ({
          eventCount: rows[0]?.eventCount ?? 0,
          rawPayloadBytes: rows[0]?.rawPayloadBytes ?? 0,
          hasCreateEvent: (rows[0]?.hasCreateEvent ?? 0) !== 0,
        })),
      );

  const getReplayStats: OrchestrationEventStore.OrchestrationEventStoreShape["getReplayStats"] = (
    input,
  ) =>
    sql<{ readonly eventCount: number; readonly rawPayloadBytes: number }>`
      SELECT
        COUNT(*) AS "eventCount",
        COALESCE(SUM(octet_length(payload_json)), 0) AS "rawPayloadBytes"
      FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water
      WHERE sequence > ${input.afterSequence}
        AND sequence <= ${input.throughSequence}
        AND (
          aggregate_kind = 'project'
          OR (application_event_version = 2 AND aggregate_kind = 'thread')
        )
    `.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.getReplayStats:query")),
      Effect.map((rows) => ({
        eventCount: rows[0]?.eventCount ?? 0,
        rawPayloadBytes: rows[0]?.rawPayloadBytes ?? 0,
      })),
    );

  const latestAgentSequence: OrchestrationEventStore.OrchestrationEventStoreShape["latestAgentSequence"] =
    (threadId) =>
      sql<{ readonly sequence: number | null }>`
      SELECT MAX(sequence) AS sequence
      FROM orchestration_events
      ${
        threadId === undefined
          ? sql``
          : sql`INDEXED BY idx_orchestration_events_agent_stream_sequence`
      }
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        ${threadId === undefined ? sql`` : sql`AND stream_id = ${threadId}`}
    `.pipe(
        Effect.map((rows) => rows[0]?.sequence ?? 0),
        Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.latestAgentSequence:query")),
      );

  // The OR planner otherwise scans every V2 event instead of seeking the final sequence.
  const latestApplicationSequence = sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence
    FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
  `.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    Effect.mapError(
      toPersistenceSqlError("OrchestrationEventStore.latestApplicationSequence:query"),
    ),
  );

  const readApplicationEventPage = (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError> =>
    Stream.fromEffect(
      readApplicationRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventStore.readApplicationEvents:query"),
        ),
      ),
    ).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) =>
        rowToApplicationStoredEvent(row).pipe(
          Effect.mapError(
            toPersistenceDecodeError("OrchestrationEventStore.readApplicationEvents:decode"),
          ),
        ),
      ),
    );

  const catchUpApplicationEvents = (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }): Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError> => {
    return Stream.paginate(input.afterSequence, (afterSequence) =>
      readApplicationEventPage({
        afterSequence,
        throughSequence: input.throughSequence,
        limit: READ_PAGE_SIZE,
      }).pipe(
        Stream.runCollect,
        Effect.map((events) => {
          const last = events.at(-1);
          return [
            events,
            last === undefined ||
            events.length < READ_PAGE_SIZE ||
            last.sequence >= input.throughSequence
              ? Option.none()
              : Option.some(last.sequence),
          ] as const;
        }),
      ),
    );
  };

  const streamProjectedApplicationEvents: OrchestrationEventStore.OrchestrationEventStoreShape["streamProjectedApplicationEvents"] =
    (input) =>
      replayAndBufferProjectedLiveEvents({
        subscribe: PubSub.subscribe(committedEvents),
        latestSequence: latestApplicationSequence,
        afterSequence: input.afterSequence ?? 0,
        project: input.project,
        replay: (throughSequence) =>
          catchUpApplicationEvents({
            afterSequence: input?.afterSequence ?? 0,
            throughSequence,
          }),
      }).pipe(
        Stream.catchTag("LiveStreamBufferError", (cause) =>
          Stream.fail(
            toPersistenceSqlError("OrchestrationEventStore.streamApplicationEvents:buffer")(cause),
          ),
        ),
      );

  const streamApplicationEvents: OrchestrationEventStore.OrchestrationEventStoreShape["streamApplicationEvents"] =
    (input) => streamProjectedApplicationEvents({ ...input, project: (event) => event });

  return {
    // SCIENT-FORK:START — V1 accessors alongside the V2 surface.
    ...makeV1EventAccess(sql),
    // SCIENT-FORK:END
    appendProjectEvent,
    appendAgentEvents,
    readAgentEvents,
    getAgentReplayStats,
    getReplayStats,
    latestAgentSequence,
    latestApplicationSequence,
    readApplicationEvents: catchUpApplicationEvents,
    publishCommitted: (events) => PubSub.publishAll(committedEvents, events).pipe(Effect.asVoid),
    streamApplicationEvents,
    streamProjectedApplicationEvents,
  } satisfies OrchestrationEventStore.OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(
  OrchestrationEventStore.OrchestrationEventStore,
  makeEventStore,
);
