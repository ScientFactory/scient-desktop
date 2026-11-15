import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  RuntimeRequestId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

const isQuestion = (
  item: OrchestrationV2TurnItem | undefined,
): item is Extract<OrchestrationV2TurnItem, { type: "approval_request" | "user_input_request" }> =>
  item?.type === "approval_request" || item?.type === "user_input_request";

export const nativeQuestionSettled = (item: OrchestrationV2TurnItem | undefined) =>
  isQuestion(item) && item.status !== "waiting";

export const nativeQuestionRequest = <E, R>(
  previous: OrchestrationV2TurnItem | undefined,
  requests: ReadonlyMap<string, { readonly request: OrchestrationV2RuntimeRequest }>,
  allocate: Effect.Effect<RuntimeRequestId, E, R>,
  fresh: Omit<OrchestrationV2RuntimeRequest, "id" | "status" | "resolvedAt">,
): Effect.Effect<OrchestrationV2RuntimeRequest, E, R> => {
  const current = isQuestion(previous) ? requests.get(previous.requestId)?.request : undefined;
  return current === undefined
    ? Effect.map(allocate, (id) => ({ ...fresh, id, status: "pending", resolvedAt: null }))
    : Effect.succeed(current);
};

// A listed request must have its question committed, even across a control-event batch barrier.
export const nativeQuestionFrames = (
  frames: ReadonlyArray<ProviderAdapterV2Event>,
): ReadonlyArray<ProviderAdapterV2Event> => {
  const questions = new Set(
    frames.flatMap((frame) =>
      frame.type === "turn_item.updated" && isQuestion(frame.turnItem)
        ? [frame.turnItem.requestId]
        : [],
    ),
  );
  if (questions.size === 0) return frames;
  const pending = (frame: ProviderAdapterV2Event) =>
    frame.type === "runtime_request.updated" &&
    frame.runtimeRequest.status === "pending" &&
    questions.has(frame.runtimeRequest.id);
  return [...frames.filter((frame) => !pending(frame)), ...frames.filter(pending)];
};
