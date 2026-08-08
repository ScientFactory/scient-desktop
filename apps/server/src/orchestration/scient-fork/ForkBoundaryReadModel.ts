import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
  type OrchestrationForkBoundary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * Error raised when the Scient-owned resolver cannot find or validate a fork
 * boundary from SQL-backed projection and lineage data.
 */
export class ForkBoundaryResolutionError extends Schema.TaggedErrorClass<ForkBoundaryResolutionError>()(
  "ForkBoundaryResolutionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Fork boundary resolution failed: ${this.detail}`;
  }
}

/**
 * The server-owned decision produced by the authoritative resolver. The pure
 * decider consumes this without trusting client-shaped boundary arrays.
 */
export interface ResolvedForkBoundaries {
  readonly originThreadId: ThreadId;
  readonly sourceAssistantMessageId: MessageId;
  /** All SQL-backed boundaries for the origin thread, ordered by turn count. */
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
  /** The exact boundary whose assistant message matches the public request. */
  readonly selectedBoundary: OrchestrationForkBoundary;
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

export function mapForkBoundaries(
  rows: ReadonlyArray<ProjectionForkBoundaryRow>,
  threadCreatedAt: string,
): ReadonlyArray<OrchestrationForkBoundary> {
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

  return [
    {
      turnId: null,
      conversationTurnCount: 0,
      userMessageId: null,
      assistantMessageId: null,
      completedAt: threadCreatedAt,
      checkpointTurnCount: null,
      checkpointStatus: null,
    },
    ...boundaries,
  ];
}

export function makeForkBoundaryQueries(sql: SqlClient.SqlClient) {
  return {
    listForkBoundaryRows: SqlSchema.findAll({
      Request: Schema.Void,
      Result: ProjectionForkBoundaryRow,
      execute: () => sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.pending_message_id AS "userMessageId",
          turns.assistant_message_id AS "assistantMessageId",
          turns.completed_at AS "completedAt",
          turns.checkpoint_turn_count AS "checkpointTurnCount",
          turns.checkpoint_status AS "checkpointStatus",
          CASE WHEN lineage.baseline_turn_id = turns.turn_id THEN 1 ELSE 0 END AS "isForkBaseline"
        FROM projection_turns AS turns
        LEFT JOIN scient_thread_lineage AS lineage
          ON lineage.thread_id = turns.thread_id
        WHERE turns.turn_id IS NOT NULL
          AND turns.state = 'completed'
          AND turns.completed_at IS NOT NULL
        ORDER BY turns.thread_id ASC, turns.requested_at ASC, turns.turn_id ASC
      `,
    }),
    listForkBoundaryRowsByThread: SqlSchema.findAll({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: ProjectionForkBoundaryRow,
      execute: ({ threadId }) => sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.pending_message_id AS "userMessageId",
          turns.assistant_message_id AS "assistantMessageId",
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
  } as const;
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
  const { listForkBoundaryRowsByThread } = makeForkBoundaryQueries(sql);

  const resolve = Effect.fn("resolveForkBoundaries")(function* (input: {
    readonly originThreadId: ThreadId;
    readonly sourceAssistantMessageId: MessageId;
    readonly threadCreatedAt: string;
  }) {
    const rows = yield* listForkBoundaryRowsByThread({ threadId: input.originThreadId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ForkBoundaryResolver.resolve:listForkBoundaryRowsByThread"),
      ),
    );

    const boundaries = mapForkBoundaries(rows, input.threadCreatedAt);

    const selectedBoundary = boundaries.find(
      (boundary) => boundary.assistantMessageId === input.sourceAssistantMessageId,
    );

    if (!selectedBoundary) {
      return yield* new ForkBoundaryResolutionError({
        detail: `Assistant message '${input.sourceAssistantMessageId}' is not a completed conversation boundary of origin thread '${input.originThreadId}' in SQL projection.`,
      });
    }

    return {
      originThreadId: input.originThreadId,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      boundaries,
      selectedBoundary,
    } satisfies ResolvedForkBoundaries;
  });

  return { resolve } as const;
}
