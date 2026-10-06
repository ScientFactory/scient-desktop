/** Which rollback-candidate attachments are still referenced by a record the
 * rollback does not release, so attachment pruning keeps them. */
import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";

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
