/**
 * V1 event access. V1 rows are the `application_event_version = 1` rows plus
 * every project row; that is exactly the row set the V1 projector can decode,
 * so the V1 reads filter on it.
 */
import { OrchestrationEvent } from "@t3tools/contracts/legacy/orchestrationEvent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import type * as OrchestrationEventStore from "../Services/OrchestrationEventStore.ts";
import {
  decodeJson,
  encodeJson,
  encodeProjectIcon,
  READ_PAGE_SIZE,
  toPersistenceSqlOrDecodeError,
  type ActorKind,
  type ApplicationEventRow,
} from "./OrchestrationEventStore.ts";

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

// V1 row decoding. `aggregateId` is widened to the row's raw text and
// re-decoded by the V1 contract, which brands project vs thread ids.
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

/**
 * V1 accessors. They share the table with V2 but only select rows the V1
 * projector can decode: `application_event_version = 1` plus every project row.
 */
export function makeV1EventAccess(sql: SqlClient.SqlClient) {
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

  return {
    append: appendV1Row,
    readFromSequence,
    readAggregateRange,
    getAggregateReplayStats,
    hasEventAfter,
  };
}
