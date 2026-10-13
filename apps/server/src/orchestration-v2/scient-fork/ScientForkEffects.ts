import type { OrchestrationDispatchCommandError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ConversationForkService } from "./ConversationForkService.ts";
import { ThreadFileRelease, type ThreadFileReleaseDeferred } from "./ThreadFileRelease.ts";

/** What the conversation-fork effects need from the server runtime. */
export type ScientForkEffectsContext = ConversationForkService;

/** The outbox effects that Scient's conversation fork owns. */
export type ScientForkEffectType = "scient-fork.provision" | "scient.release-thread-files";

/** Runs the conversation-fork outbox effects for the upstream effect worker. */
export const makeScientForkEffects = Effect.gen(function* () {
  const forks = yield* ConversationForkService;
  const files = yield* ThreadFileRelease;
  return (
    type: ScientForkEffectType,
    threadId: ThreadId,
    willRetry: boolean,
  ): Effect.Effect<void, OrchestrationDispatchCommandError | ThreadFileReleaseDeferred> =>
    type === "scient-fork.provision"
      ? forks.provision(threadId, willRetry)
      : files.release(threadId);
});
