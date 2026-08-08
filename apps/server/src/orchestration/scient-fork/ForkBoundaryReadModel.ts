import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
  type OrchestrationForkBoundary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

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
