/** A user's steer over the provider-input limit stays saved on its run with one error saying why
 * it was not sent. The limit is deterministic, so the refusal is final and the run keeps going. */
import {
  CommandId,
  TurnItemId,
  type MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { OrchestratorDispatchError, OrchestratorProjectionError } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { ProviderCurrentInputError } from "../ScientCurrentInput.ts";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";

type SteerInputRefuseCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "steer-input.refuse" }
>;

const isProviderCurrentInputError = Schema.is(ProviderCurrentInputError);

/** The refusal to record for a failed steer, or `undefined` when its cause may still pass. */
export const steerInputRefusal = (input: {
  readonly effectId: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly cause: unknown;
}): SteerInputRefuseCommand | undefined =>
  isProviderCurrentInputError(input.cause)
    ? {
        type: "steer-input.refuse",
        commandId: CommandId.make(`command:steer-input-refused:${input.effectId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        message: input.cause.message,
      }
    : undefined;

/** Records the refusal when the steer was saved as the user's message. Otherwise, as for a
 * server notification, it returns false and the failure keeps its retry path. */
export const refuseUserSteerInput = Effect.fn("SteerInputRefusal.refuseUserSteerInput")(function* (
  threads: Pick<ThreadManagementServiceShape, "getThreadRecords" | "dispatch">,
  refusal: SteerInputRefuseCommand,
) {
  const { messages } = yield* threads.getThreadRecords(refusal.threadId, ["messages"], {
    messageIds: [refusal.messageId],
  });
  const runId = messages.find((message) => message.id === refusal.messageId)?.runId;
  if (runId == null) return false;
  const steerItemId = IdAllocator.derive.userTurnItem({ messageId: refusal.messageId });
  const { turnItems } = yield* threads.getThreadRecords(refusal.threadId, ["turnItems"], {
    turnItemRunId: runId,
    turnItemTypes: ["user_message"],
  });
  if (!turnItems.some((item) => item.id === steerItemId)) return false;
  yield* threads.dispatch(refusal);
  return true;
});

export const dispatchSteerInputRefusal = Effect.fn("SteerInputRefusal.dispatch")(function* (
  deps: {
    readonly idAllocator: Pick<IdAllocator.IdAllocatorV2["Service"], "derive">;
    readonly projectionStore: Pick<
      ProjectionStoreV2Shape,
      "getThread" | "getTurnItem" | "getThreadRecords"
    >;
    readonly mapDispatchError: (
      command: OrchestrationV2ServerCommand,
    ) => <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, OrchestratorDispatchError, R>;
    readonly emit: (
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      command: OrchestrationV2ServerCommand,
    ) => <Event extends OrchestrationV2DomainEvent>(
      event: Omit<Event, "id">,
    ) => Effect.Effect<Event, OrchestratorDispatchError>;
    readonly nextTurnItemOrdinal: (
      projection: Pick<OrchestrationV2ThreadProjection, "thread">,
    ) => Effect.Effect<number, OrchestratorProjectionError>;
  },
  command: SteerInputRefuseCommand,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const { idAllocator, projectionStore, mapDispatchError, emit, nextTurnItemOrdinal } = deps;
  const thread = yield* projectionStore.getThread(command.threadId).pipe(mapDispatchError(command));
  if (thread.deletedAt !== null) return;
  const refusalId = TurnItemId.make(`turn-item:steer-input-refused:${command.messageId}`);
  const recorded = yield* projectionStore
    .getTurnItem({ threadId: command.threadId, itemId: refusalId, ownOnly: true })
    .pipe(mapDispatchError(command));
  if (recorded !== null) return;
  const steer = yield* projectionStore
    .getTurnItem({
      threadId: command.threadId,
      itemId: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
      ownOnly: true,
    })
    .pipe(mapDispatchError(command));
  if (steer?.type !== "user_message" || steer.runId === null) return;
  const runId = steer.runId;
  const { runs } = yield* projectionStore
    .getThreadRecords(command.threadId, ["runs"], { runIds: [runId] })
    .pipe(mapDispatchError(command));
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return;
  const now = yield* DateTime.now;
  yield* emit(
    events,
    command,
  )({
    type: "turn-item.updated",
    threadId: command.threadId,
    runId,
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: {
      id: refusalId,
      threadId: command.threadId,
      runId,
      // Off the root node, so a run failure still reads the run's own error.
      nodeId: null,
      providerThreadId: steer.providerThreadId,
      providerTurnId: steer.providerTurnId,
      nativeItemRef: null,
      // A child of the steer, so the timeline does not read it as the run failing.
      parentItemId: steer.id,
      ordinal: yield* nextTurnItemOrdinal({ thread }),
      status: "failed",
      title: "Message not sent",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "error",
      failure: makeProviderFailure({
        class: "validation_error",
        message: command.message,
        retryable: false,
      }),
    },
  });
});
