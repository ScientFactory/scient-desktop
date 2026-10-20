import { isOrchestrationV2WorkActive, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { EventSinkV2Shape } from "../EventSink.ts";

/** A terminal root may still owe a result until its surviving native children settle. */
export const subscribeDelegatedChildSettlements = Effect.fnUntraced(function* <E>(input: {
  readonly events: Pick<EventSinkV2Shape, "stream">;
  readonly afterSequence: number;
  readonly finalize: (threadId: ThreadId) => Effect.Effect<void, E>;
}) {
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
            return event.payload.pendingBackgroundTasks?.length === 0;
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
