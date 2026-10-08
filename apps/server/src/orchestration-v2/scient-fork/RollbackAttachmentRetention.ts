/** Rollback attachment pruning: which candidate attachments are still referenced
 * by a record the rollback does not release, so pruning keeps them. */
import { type OrchestrationV2ThreadProjection, type RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { readLiveForkSharedAttachmentIds } from "./ForkHistory.ts";

type RollbackAttachmentOwner = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "turnItems" | "runtimeRequests"
>;

/** Finds every thread whose stored records mention a candidate attachment and
 * applies the retention policy to their projections, in one transaction. */
export const readRollbackAttachmentOwners = <E>(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly revertedRunIds: ReadonlyArray<RunId>;
    readonly attachmentIds: ReadonlyArray<string>;
  },
  readOwner: (threadId: ThreadId) => Effect.Effect<RollbackAttachmentOwner, E>,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const threadIds = new Set<ThreadId>([input.threadId]);
      for (const id of input.attachmentIds) {
        const rows = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_messages WHERE instr(lower(payload_json), ${id.toLowerCase()}) > 0
            UNION SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE instr(lower(payload_json), ${id.toLowerCase()}) > 0
            UNION SELECT thread_id FROM orchestration_v2_projection_threads WHERE instr(lower(payload_json), ${id.toLowerCase()}) > 0
          `;
        rows.forEach((row) => threadIds.add(ThreadId.make(row.thread_id)));
      }
      const owners = yield* Effect.forEach(threadIds, (threadId) => readOwner(threadId));
      // A live fork shares the original's items by reference: what its frozen
      // history shows stays, even after the original rolls those runs back.
      return [
        ...new Set([
          ...retainedRollbackAttachmentIds(input, owners),
          ...(yield* readLiveForkSharedAttachmentIds(sql, input.threadId, input.attachmentIds)),
        ]),
      ];
    }),
  );

export const retainedRollbackAttachmentIds = (
  input: {
    readonly threadId: ThreadId;
    readonly revertedRunIds: ReadonlyArray<RunId>;
    readonly attachmentIds: ReadonlyArray<string>;
  },
  projections: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "turnItems" | "runtimeRequests"
    >
  >,
) => {
  const candidates = new Set(input.attachmentIds.map((id) => id.toLowerCase()));
  const retained = new Set<string>();
  const retain = (ids: ReadonlyArray<string>) =>
    ids.forEach((id) => {
      if (candidates.has(id.toLowerCase())) retained.add(id.toLowerCase());
    });
  for (const projection of projections) {
    // A deleted conversation shows nothing, so it keeps no file.
    if (projection.thread.deletedAt !== null && projection.thread.id !== input.threadId) continue;
    const recoverable = new Set(
      projection.turnItems
        .filter(
          (item) =>
            item.type === "user_message" &&
            (item.inputIntent === "queued_turn" || item.inputIntent === "promoted_queued_to_steer"),
        )
        .map((item) => item.runId),
    );
    const releasable = (runId: RunId | null) =>
      projection.thread.id === input.threadId &&
      runId !== null &&
      input.revertedRunIds.includes(runId) &&
      !recoverable.has(runId) &&
      projection.runs.some(
        (run) =>
          run.id === runId &&
          run.status === "rolled_back" &&
          run.legacyQueue === undefined &&
          run.queueHeld !== true,
      );
    for (const message of projection.messages)
      if (!releasable(message.runId))
        retain(message.attachments.map((attachment) => attachment.id));
    for (const item of projection.turnItems) {
      if (
        item.inheritedFrom === undefined &&
        releasable(item.runId) &&
        !(
          item.type === "user_input_request" &&
          projection.runtimeRequests.some(
            (request) => request.id === item.requestId && request.status === "pending",
          )
        )
      )
        continue;
      if (item.type === "user_message" || item.type === "assistant_message")
        retain((item.attachments ?? []).map((attachment) => attachment.id));
      if (item.type === "user_input_request" && item.questionAnswer !== undefined)
        retain(
          Object.values(item.questionAnswer.attachmentsByQuestionId)
            .flat()
            .map((attachment) => attachment.id),
        );
    }
    const fork = projection.thread.conversationFork;
    if (fork != null && fork.status !== "ready")
      retain(fork.attachmentCopies.map((copy) => copy.source.id));
  }
  return input.attachmentIds.filter((id) => retained.has(id.toLowerCase()));
};
