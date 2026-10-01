import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
  ThreadForkCopiedBoundary,
  type OrchestrationConversationImport,
  type OrchestrationForkBoundary,
  type OrchestrationForkLineage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  resolveForkBoundariesFromList,
  resolveUserForkBoundariesFromList,
  type ResolvedForkBoundaries,
} from "./forkBoundaryTypes.ts";
import { toConversationImportMarker } from "./importRepository.ts";

/**
 * Error raised when the Scient-owned resolver cannot find or validate a fork
 * boundary from SQL-backed projection and lineage data.
 */
export class ForkBoundaryResolutionError extends Schema.TaggedError<ForkBoundaryResolutionError>()(
  "ForkBoundaryResolutionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Fork boundary resolution failed: ${this.detail}`;
  }
}

export const ProjectionForkBoundaryRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  userMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointStatus: Schema.NullOr(Schema.Literals(["ready", "missing", "error"])),
  isForkBaseline: Schema.Number,
});
export type ProjectionForkBoundaryRow = typeof ProjectionForkBoundaryRow.Type;

function mapForkBoundaries(
  rows: ReadonlyArray<ProjectionForkBoundaryRow>,
  threadCreatedAt: string,
  copiedBoundaries: ReadonlyArray<ThreadForkCopiedBoundary> = [],
): ReadonlyArray<OrchestrationForkBoundary> {
  const emptyBoundary: OrchestrationForkBoundary = {
    turnId: null,
    conversationTurnCount: 0,
    userMessageId: null,
    assistantMessageId: null,
    completedAt: threadCreatedAt,
    checkpointTurnCount: null,
    checkpointStatus: null,
  };

  if (copiedBoundaries.length > 0) {
    // Projection creates completed turn rows for copied assistant messages.
    // The immutable manifest is the logical authority for those turns, so all
    // manifest-owned rows (not only the final baseline row) must be excluded
    // before native post-fork turns are appended.
    const copiedTurnIds = new Set(copiedBoundaries.map((boundary) => boundary.turnId));
    const nativeRows = rows.filter((row) => !copiedTurnIds.has(row.turnId));
    return [
      emptyBoundary,
      ...copiedBoundaries.map((boundary): OrchestrationForkBoundary => ({
        ...boundary,
        conversationTurnCount: 0,
        checkpointTurnCount: null,
        checkpointStatus: null,
      })),
      ...nativeRows.map((row, index): OrchestrationForkBoundary => ({
        turnId: row.turnId,
        conversationTurnCount: index + 1,
        userMessageId: row.userMessageId,
        assistantMessageId: row.assistantMessageId,
        completedAt: row.completedAt,
        checkpointTurnCount: row.checkpointTurnCount,
        checkpointStatus: row.checkpointStatus,
      })),
    ];
  }

  let nextConversationTurnCount = 1;
  const boundaries = rows.map((row) => {
    const conversationTurnCount = row.isForkBaseline === 1 ? 0 : nextConversationTurnCount++;
    return {
      turnId: row.turnId,
      conversationTurnCount,
      userMessageId: row.userMessageId,
      assistantMessageId: row.assistantMessageId,
      completedAt: row.completedAt,
      checkpointTurnCount: row.checkpointTurnCount,
      checkpointStatus: row.checkpointStatus,
    };
  });

  if (boundaries[0]?.conversationTurnCount === 0) {
    return boundaries;
  }

  return [emptyBoundary, ...boundaries];
}

function makeForkBoundaryQueries(sql: SqlClient.SqlClient) {
  return {
    listForkBoundaryRowsByThread: SqlSchema.findAll({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: ProjectionForkBoundaryRow,
      execute: ({ threadId }) => sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.pending_message_id AS "userMessageId",
          CASE
            WHEN turns.assistant_message_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM projection_thread_messages AS recorded
              WHERE recorded.thread_id = turns.thread_id
                AND recorded.message_id = turns.assistant_message_id
            ) THEN COALESCE((
              SELECT answer.message_id FROM projection_thread_messages AS answer
              WHERE answer.thread_id = turns.thread_id AND answer.turn_id = turns.turn_id
                AND answer.role = 'assistant' AND answer.is_streaming = 0
              ORDER BY answer.created_at DESC, answer.message_id DESC LIMIT 1
            ), turns.assistant_message_id)
            ELSE turns.assistant_message_id
          END AS "assistantMessageId",
          turns.completed_at AS "completedAt",
          turns.checkpoint_turn_count AS "checkpointTurnCount",
          turns.checkpoint_status AS "checkpointStatus",
          CASE WHEN lineage.baseline_turn_id = turns.turn_id THEN 1 ELSE 0 END AS "isForkBaseline"
        FROM projection_turns AS turns
        LEFT JOIN scient_thread_lineage AS lineage
          ON lineage.thread_id = turns.thread_id
        WHERE turns.thread_id = ${threadId}
          AND turns.turn_id IS NOT NULL
          AND turns.state = 'completed'
          AND turns.completed_at IS NOT NULL
        ORDER BY turns.requested_at ASC, turns.turn_id ASC
      `,
    }),
    listForkMessageRowsByThread: SqlSchema.findAll({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: Schema.Struct({
        messageId: MessageId,
        role: Schema.Literals(["user", "assistant", "system"]),
        isStreaming: Schema.Number,
        createdAt: IsoDateTime,
      }),
      execute: ({ threadId }) => sql`
        SELECT
          message_id AS "messageId",
          role,
          is_streaming AS "isStreaming",
          created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role IN ('user', 'assistant', 'system')
        ORDER BY created_at ASC, message_id ASC
      `,
    }),
    listForkTurnRowsByThread: SqlSchema.findAll({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: Schema.Struct({
        turnId: TurnId,
        userMessageId: Schema.NullOr(MessageId),
        requestedAt: IsoDateTime,
      }),
      execute: ({ threadId }) => sql`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY requested_at ASC, turn_id ASC
      `,
    }),
    getCopiedForkBoundariesByThread: SqlSchema.findOneOption({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: Schema.Struct({
        copiedBoundaries: Schema.fromJsonString(Schema.Array(ThreadForkCopiedBoundary)),
      }),
      execute: ({ threadId }) => sql`
        SELECT COALESCE(copied_boundaries_json, '[]') AS "copiedBoundaries"
        FROM scient_thread_lineage
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
    }),
  } as const;
}

/**
 * Row schema for a thread's origin marker: the narrow fork-lineage marker read
 * from `scient_thread_lineage`, or an import's provenance read from its
 * `import` context transfer.
 */
export const ProjectionForkLineageRow = Schema.Struct({
  threadId: ThreadId,
  originThreadId: Schema.NullOr(ThreadId),
  baselineAssistantMessageId: Schema.NullOr(MessageId),
  importOriginJson: Schema.NullOr(Schema.String),
});
export type ProjectionForkLineageRow = typeof ProjectionForkLineageRow.Type;

const threadOriginRows = (sql: SqlClient.SqlClient) => sql`
  SELECT
    lineage.thread_id AS "threadId",
    lineage.forked_from_thread_id AS "originThreadId",
    lineage.baseline_assistant_message_id AS "baselineAssistantMessageId",
    transfer.origin_json AS "importOriginJson"
  FROM scient_thread_lineage AS lineage
  LEFT JOIN scient_context_transfers AS transfer
    ON transfer.thread_id = lineage.thread_id AND transfer.type = 'fork'
  UNION ALL
  SELECT thread_id, NULL, NULL, origin_json
  FROM scient_context_transfers
  WHERE type = 'import'
`;

/**
 * SQL queries for origin markers. Forks carry local lineage and, when their
 * history came from an import, that source's external provenance and omissions.
 * Direct imports carry the import banner's marker separately.
 */
export function makeForkLineageQueries(sql: SqlClient.SqlClient) {
  return {
    listForkLineageRows: SqlSchema.findAll({
      Request: Schema.Void,
      Result: ProjectionForkLineageRow,
      execute: () => sql`
        SELECT * FROM (${threadOriginRows(sql)}) ORDER BY "threadId" ASC
      `,
    }),
    getForkLineageRowByThread: SqlSchema.findOneOption({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: ProjectionForkLineageRow,
      execute: ({ threadId }) => sql`
        SELECT * FROM (${threadOriginRows(sql)}) WHERE "threadId" = ${threadId} LIMIT 1
      `,
    }),
  } as const;
}

/**
 * Map a lineage row to the narrow contract marker, or null if absent.
 */
export function toForkLineageMarker(
  row: ProjectionForkLineageRow | undefined,
): OrchestrationForkLineage | null {
  if (row === undefined || row.originThreadId === null) {
    return null;
  }
  const marker = toConversationImportMarker(row.importOriginJson);
  const sourceImport =
    marker === null ? undefined : (({ inheritedTurnIds: _turns, ...source }) => source)(marker);
  return {
    originThreadId: row.originThreadId,
    baselineAssistantMessageId: row.baselineAssistantMessageId,
    ...(sourceImport === undefined ? {} : { sourceImport }),
  };
}

/** The thread's import marker as a payload field; absent on threads that were not imported. */
export function importMarkerField(row: ProjectionForkLineageRow | undefined): {
  readonly conversationImport?: OrchestrationConversationImport;
} {
  const marker =
    row?.originThreadId === null ? toConversationImportMarker(row.importOriginJson) : null;
  return marker === null ? {} : { conversationImport: marker };
}

/**
 * Create a Scient-owned authoritative fork boundary resolver.
 *
 * The resolver queries SQL-backed `projection_turns` joined with
 * `scient_thread_lineage` at resolution time, independent of any cached
 * snapshot or client-shaped boundary array. It finds the exact completed
 * assistant boundary matching the public request and returns it together
 * with all resolved boundaries for retained-prefix derivation.
 *
 * The pure decider consumes the returned {@link ResolvedForkBoundaries}
 * without reading `origin.conversationForkBoundaries` from the read model.
 */
export function makeForkBoundaryResolver(sql: SqlClient.SqlClient) {
  const {
    listForkBoundaryRowsByThread,
    listForkMessageRowsByThread,
    listForkTurnRowsByThread,
    getCopiedForkBoundariesByThread,
  } = makeForkBoundaryQueries(sql);

  const resolve = Effect.fn("resolveForkBoundaries")(function* (input: {
    readonly originThreadId: ThreadId;
    readonly sourceAssistantMessageId?: MessageId;
    readonly sourceUserMessageId?: MessageId;
    /** Retain every completed turn; the running turn itself is copied as a live tail. */
    readonly sourceRunningTurnId?: TurnId;
    readonly threadCreatedAt: string;
  }) {
    const rows = yield* listForkBoundaryRowsByThread({ threadId: input.originThreadId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ForkBoundaryResolver.resolve:listForkBoundaryRowsByThread"),
      ),
    );

    const copiedBoundaryRow = yield* getCopiedForkBoundariesByThread({
      threadId: input.originThreadId,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ForkBoundaryResolver.resolve:getCopiedForkBoundariesByThread"),
      ),
    );
    const boundaries = mapForkBoundaries(
      rows,
      input.threadCreatedAt,
      copiedBoundaryRow._tag === "Some" ? copiedBoundaryRow.value.copiedBoundaries : [],
    );
    if (input.sourceRunningTurnId !== undefined) {
      // Completed boundaries only: the running turn has no row among them.
      const selectedBoundary = boundaries.at(-1)!;
      if (selectedBoundary.turnId === input.sourceRunningTurnId) {
        return yield* new ForkBoundaryResolutionError({
          detail: `Turn '${input.sourceRunningTurnId}' of origin thread '${input.originThreadId}' has already completed; fork its response instead.`,
        });
      }
      const turnRequests = yield* listForkTurnRowsByThread({
        threadId: input.originThreadId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ForkBoundaryResolver.resolve:listForkTurnRowsByThread"),
        ),
      );
      return {
        originThreadId: input.originThreadId,
        forkPoint: { kind: "running-turn", turnId: input.sourceRunningTurnId },
        boundaries,
        selectedBoundary,
        turnRequests: turnRequests.map((turn) => ({
          turnId: turn.turnId,
          userMessageId: turn.userMessageId,
        })),
      } satisfies ResolvedForkBoundaries;
    }
    const sourceAssistantMessageId =
      input.sourceAssistantMessageId ??
      (input.sourceUserMessageId === undefined
        ? (boundaries.findLast((boundary) => boundary.assistantMessageId !== null)
            ?.assistantMessageId ?? undefined)
        : undefined);
    const sourceUserMessageId = input.sourceUserMessageId;
    const resolved =
      sourceAssistantMessageId !== undefined
        ? resolveForkBoundariesFromList({
            originThreadId: input.originThreadId,
            sourceAssistantMessageId,
            boundaries,
          })
        : sourceUserMessageId !== undefined
          ? yield* listForkMessageRowsByThread({ threadId: input.originThreadId }).pipe(
              Effect.mapError(
                toPersistenceSqlError("ForkBoundaryResolver.resolve:listForkMessageRowsByThread"),
              ),
              Effect.flatMap((messages) => {
                const source = messages.find(
                  (message) => message.messageId === sourceUserMessageId,
                );
                if (source?.role !== "user" || source.isStreaming !== 0) {
                  return Effect.succeed(null);
                }
                return listForkTurnRowsByThread({ threadId: input.originThreadId }).pipe(
                  Effect.mapError(
                    toPersistenceSqlError("ForkBoundaryResolver.resolve:listForkTurnRowsByThread"),
                  ),
                  Effect.map((orderedTurns) =>
                    resolveUserForkBoundariesFromList({
                      originThreadId: input.originThreadId,
                      sourceUserMessageId,
                      sourceUserCreatedAt: source.createdAt,
                      orderedTurns,
                      boundaries,
                    }),
                  ),
                );
              }),
            )
          : null;
    if (resolved === null) {
      const sourceDescription =
        sourceAssistantMessageId !== undefined
          ? `Assistant message '${sourceAssistantMessageId}' is not a completed conversation boundary`
          : sourceUserMessageId !== undefined
            ? `User message '${sourceUserMessageId}' is not an available durable message`
            : "No fork source message was supplied";
      return yield* new ForkBoundaryResolutionError({
        detail: `${sourceDescription} of origin thread '${input.originThreadId}' in SQL projection.`,
      });
    }

    return resolved;
  });

  return { resolve } as const;
}
