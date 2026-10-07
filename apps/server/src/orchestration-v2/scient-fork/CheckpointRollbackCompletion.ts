/** A provider rollback that finished records its request as completed on the thread, so a
 * client waiting on it stops, and a late failure for the same request is ignored. */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
  OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorDispatchError } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export const dispatchCheckpointRollbackComplete = (
  deps: {
    readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThread">;
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
  },
  command: Extract<
    OrchestrationV2InternalCommand,
    { readonly type: "checkpoint.rollback.complete" }
  >,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) =>
  Effect.gen(function* () {
    const { projectionStore, mapDispatchError, emit } = deps;
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(mapDispatchError(command));
    // Superseded work may finish late; it cannot settle the newer request.
    if (
      thread.deletedAt !== null ||
      thread.rollbackRequestId !== command.requestId ||
      thread.rollbackCompletedRequestId === command.requestId
    )
      return;
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...thread,
        rollbackCompletedRequestId: command.requestId,
        rollbackFailure: null,
        updatedAt: now,
      },
    });
  });
