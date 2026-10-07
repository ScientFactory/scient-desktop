import { TurnItemId, type OrchestrationV2TurnItem, type ThreadId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

type ForkItem = Extract<OrchestrationV2TurnItem, { type: "fork" }>;

/** A destination-owned presentation fact; the source reference grants no execution authority. */
export function conversationForkBoundaryItem(input: {
  readonly targetThreadId: ThreadId;
  readonly source: Extract<ForkItem["source"], { type: "run" | "message" }>;
  readonly ordinal: number;
  readonly createdAt: DateTime.Utc;
}): ForkItem {
  const base = {
    id: TurnItemId.make(`turn-item:fork:${input.targetThreadId}`),
    threadId: input.targetThreadId,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: "Conversation forked here",
    startedAt: null,
    completedAt: input.createdAt,
    updatedAt: input.createdAt,
    type: "fork",
    targetThreadId: input.targetThreadId,
  } satisfies Omit<ForkItem, "source">;
  return input.source.type === "message"
    ? { ...base, source: input.source }
    : { ...base, source: input.source };
}
