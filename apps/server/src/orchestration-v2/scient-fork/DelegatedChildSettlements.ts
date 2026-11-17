import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2PendingBackgroundTask,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { EventSinkV2Shape } from "../EventSink.ts";

/** A terminal root may still owe a result until its surviving native children settle. */
export const subscribeDelegatedChildSettlements = Effect.fnUntraced(function* <E>(input: {
  readonly events: Pick<EventSinkV2Shape, "stream">;
  readonly afterSequence: number;
  readonly finalize: (threadId: ThreadId) => Effect.Effect<void, E>;
}) {
  // A roster counts when a task seen holding leaves it, since that may be one follow-up's (T3).
  const holdingTaskIdsByProviderThread = new Map<string, ReadonlySet<string>>();
  const settlesBackgroundWork = (
    providerThreadId: string,
    tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> | undefined,
  ) => {
    const holding = new Set(
      (tasks ?? [])
        .filter((task) => backgroundWorkHoldsCompletion([task]))
        .map((task) => task.taskId),
    );
    const previous = holdingTaskIdsByProviderThread.get(providerThreadId);
    if (holding.size > 0) holdingTaskIdsByProviderThread.set(providerThreadId, holding);
    else holdingTaskIdsByProviderThread.delete(providerThreadId);
    const taskLeft = previous !== undefined && [...previous].some((id) => !holding.has(id));
    return taskLeft || (tasks !== undefined && holding.size === 0);
  };
  // Filter at the sink so a parent lock never buffers unrelated tool bodies.
  for (const eventType of [
    "subagent.updated",
    "provider-thread.updated",
    "provider-turn.updated",
  ] as const) {
    yield* input.events.stream({ afterSequence: input.afterSequence, eventType }).pipe(
      Stream.filter(({ event }) => {
        switch (event.type) {
          case "subagent.updated":
          case "provider-turn.updated":
            return !isOrchestrationV2WorkActive(event.payload.status);
          case "provider-thread.updated":
            return settlesBackgroundWork(event.payload.id, event.payload.pendingBackgroundTasks);
          default:
            return false;
        }
      }),
      Stream.runForEach((stored) =>
        input.finalize(stored.event.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to reconcile delegated task after child settlement", {
              threadId: stored.event.threadId,
              sequence: stored.sequence,
              cause,
            }),
          ),
        ),
      ),
      Effect.forkDetach,
    );
  }
});
