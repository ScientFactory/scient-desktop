import {
  ApplicationEventMetadata,
  ApplicationProjectEvent,
  type ApplicationStoredEvent,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationV2DomainEventJson,
  OrchestrationV2StoredEvent,
  ProjectId,
  ProjectIconOverride,
  ThreadId,
  type OrchestrationV2DomainEvent,
  OrchestrationEvent,
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
// SCIENT-FORK:START — V1 event access. V1 rows are the
// `application_event_version = 1` rows plus every project row; that is exactly the
// row set the V1 projector can decode, so the V1 reads filter on it.
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;

function inferV1ActorKind(event: Omit<OrchestrationEvent, "sequence">): typeof ActorKind.Type {
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
// SCIENT-FORK:END

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
// SCIENT-FORK:START — V1 row decoding. `aggregateId` is widened to the row's raw
// text and re-decoded by the V1 contract, which brands project vs thread ids.
const decodeV1Event = Schema.decodeUnknownEffect(OrchestrationEvent);

const rowToV1Event = Effect.fn("OrchestrationEventStore.rowToV1Event")(function* (
  row: ApplicationEventRow,
) {
  return yield* decodeV1Event({
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
// SCIENT-FORK:END

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
        Effect.flatMap((row) => decodeProjectEvent(row)),
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
            return yield* decodeV2StoredEvent({
              sequence: rows[0]?.sequence,
              commandId: input.commandId ?? null,
              event,
            });
          }),
        { concurrency: 1 },
      ).pipe(
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

  // SCIENT-FORK:START — V1 accessors. They share the table with V2 but only
  // select rows the V1 projector can decode: `application_event_version = 1`
  // plus every project row.
  const appendV1Row = (event: Omit<OrchestrationEvent, "sequence">) =>
    Effect.gen(function* () {
      const payloadJson =
        event.type === "project.deleted" ||
        !("projectIcon" in event.payload && event.payload.projectIcon)
          ? yield* encodeJson(event.payload)
          : yield* encodeJson({
              ...event.payload,
              projectIcon: encodeProjectIcon(event.payload.projectIcon),
            });
      const metadataJson = yield* encodeJson(event.metadata);
      const rows = yield* sql<ApplicationEventRow>`
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
        ${event.eventId},
        ${event.aggregateKind},
        ${event.aggregateId},
        COALESCE(
          (
            SELECT stream_version + 1
            FROM orchestration_events
            WHERE aggregate_kind = ${event.aggregateKind}
              AND stream_id = ${event.aggregateId}
            ORDER BY stream_version DESC
            LIMIT 1
          ),
          0
        ),
        ${event.type},
        ${event.occurredAt},
        ${event.commandId},
        ${event.causationEventId},
        ${event.correlationId},
        ${inferV1ActorKind(event)},
        ${payloadJson},
        ${metadataJson},
        1
      )
      RETURNING
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
    `;
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(
          toPersistenceSqlError("OrchestrationEventStore.append:insert")(
            new Error("orchestration event insert returned no row"),
          ),
        );
      }
      return yield* rowToV1Event(row);
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decode",
        ),
      ),
    );

  const readV1EventRowsFromSequence = (input: {
    readonly sequenceExclusive: number;
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
      WHERE sequence > ${input.sequenceExclusive}
        AND (aggregate_kind = 'project' OR application_event_version = 1)
      ORDER BY sequence ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.readFromSequence:query")),
    );

  const readFromSequence: OrchestrationEventStore.OrchestrationEventStoreShape["readFromSequence"] =
    (sequenceExclusive, limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT) => {
      const normalizedLimit = Math.max(0, Math.floor(limit));
      if (normalizedLimit === 0) {
        return Stream.empty;
      }
      return Stream.paginate(
        { cursor: sequenceExclusive, remaining: normalizedLimit },
        ({ cursor, remaining }) =>
          readV1EventRowsFromSequence({
            sequenceExclusive: cursor,
            limit: Math.min(remaining, READ_PAGE_SIZE),
          }).pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                rowToV1Event(row).pipe(
                  Effect.mapError(
                    toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                  ),
                ),
              ),
            ),
            Effect.map((events) => {
              const last = events.at(-1);
              const nextRemaining = remaining - events.length;
              return [
                events,
                last === undefined ||
                events.length < Math.min(remaining, READ_PAGE_SIZE) ||
                nextRemaining <= 0
                  ? Option.none()
                  : Option.some({ cursor: last.sequence, remaining: nextRemaining }),
              ] as const;
            }),
          ),
      );
    };

  const findV1EventAfter = (input: {
    readonly aggregateKind: string;
    readonly aggregateId: string;
    readonly type?: string;
    readonly sequenceExclusive: number;
  }) =>
    sql<{ readonly sequence: number }>`
      SELECT sequence
      FROM orchestration_events
      WHERE aggregate_kind = ${input.aggregateKind}
        AND stream_id = ${input.aggregateId}
        AND (aggregate_kind = 'project' OR application_event_version = 1)
        AND ${sql.and([
          sql`sequence > ${input.sequenceExclusive}`,
          ...(input.type === undefined ? [] : [sql`event_type = ${input.type}`]),
        ])}
      LIMIT 1
    `.pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.hasEventAfter:query")));

  const hasEventAfter: OrchestrationEventStore.OrchestrationEventStoreShape["hasEventAfter"] = (
    input,
  ) =>
    findV1EventAfter(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.hasEventAfter:query",
          "OrchestrationEventStore.hasEventAfter:decodeRow",
        ),
      ),
    );

  const readV1AggregateEventRows = (input: {
    readonly aggregateKind: "project" | "thread";
    readonly aggregateId: string;
    readonly fromSequenceExclusive: number;
    readonly toSequenceInclusive: number;
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
      WHERE aggregate_kind = ${input.aggregateKind}
        AND stream_id = ${input.aggregateId}
        AND (aggregate_kind = 'project' OR application_event_version = 1)
        AND sequence > ${input.fromSequenceExclusive}
        AND sequence <= ${input.toSequenceInclusive}
      ORDER BY sequence ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.readAggregateRange:query")),
    );

  const readAggregateRange: OrchestrationEventStore.OrchestrationEventStoreShape["readAggregateRange"] =
    (input) => {
      const limit = Math.max(0, Math.floor(input.limit ?? DEFAULT_READ_FROM_SEQUENCE_LIMIT));
      if (limit === 0 || input.fromSequenceExclusive >= input.toSequenceInclusive) {
        return Stream.empty;
      }
      return Stream.paginate(
        { cursor: input.fromSequenceExclusive, remaining: limit },
        ({ cursor, remaining }) => {
          const pageLimit = Math.min(remaining, READ_PAGE_SIZE);
          return readV1AggregateEventRows({
            ...input,
            fromSequenceExclusive: cursor,
            limit: pageLimit,
          }).pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(rows, (row) =>
                rowToV1Event(row).pipe(
                  Effect.mapError(
                    toPersistenceDecodeError(
                      "OrchestrationEventStore.readAggregateRange:rowToEvent",
                    ),
                  ),
                ),
              ),
            ),
            Effect.map((events) => {
              const last = events.at(-1);
              const nextRemaining = remaining - events.length;
              return [
                events,
                last === undefined ||
                events.length < pageLimit ||
                nextRemaining <= 0 ||
                last.sequence >= input.toSequenceInclusive
                  ? Option.none()
                  : Option.some({ cursor: last.sequence, remaining: nextRemaining }),
              ] as const;
            }),
          );
        },
      );
    };

  const getAggregateReplayStats: OrchestrationEventStore.OrchestrationEventStoreShape["getAggregateReplayStats"] =
    (input) =>
      sql<{
        readonly eventCount: number;
        readonly payloadBytes: number;
        readonly hasCreateEvent: number;
      }>`
        SELECT
          COUNT(*) AS "eventCount",
          COALESCE(SUM(octet_length(payload_json)), 0) AS "payloadBytes",
          COALESCE(MAX(event_type IN (
            'thread.created', 'project.created'
          )), 0) AS "hasCreateEvent"
        FROM (
          SELECT payload_json, event_type
          FROM orchestration_events
          WHERE aggregate_kind = ${input.aggregateKind}
            AND stream_id = ${input.aggregateId}
            AND (aggregate_kind = 'project' OR application_event_version = 1)
            AND sequence > ${input.fromSequenceExclusive}
            AND sequence <= ${input.toSequenceInclusive}
          ORDER BY sequence ASC
          LIMIT ${Math.max(0, Math.floor(input.maxEvents)) + 1}
        )
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventStore.getAggregateReplayStats:query"),
        ),
        Effect.map((rows) => ({
          eventCount: rows[0]?.eventCount ?? 0,
          payloadBytes: rows[0]?.payloadBytes ?? 0,
          hasCreateEvent: (rows[0]?.hasCreateEvent ?? 0) !== 0,
        })),
      );
  // SCIENT-FORK:END

  return {
    // SCIENT-FORK:START — V1 accessors alongside the V2 surface.
    append: appendV1Row,
    readFromSequence,
    readAggregateRange,
    getAggregateReplayStats,
    hasEventAfter,
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
