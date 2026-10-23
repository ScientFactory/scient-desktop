import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../Orchestrator.ts";

// Subscribe from a durable cursor before reading, so a commit racing the first
// projection read cannot strand a waiter between its check and subscription.
export const awaitThreadProjection = Effect.fn("Test.awaitThreadProjection")(function* (
  threadId: ThreadId,
  accepts: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(accepts), Stream.runHead);
  if (Option.isNone(found)) return yield* Effect.die(`Thread receipt stream ended: ${threadId}`);
  return found.value;
}, Effect.scoped);
