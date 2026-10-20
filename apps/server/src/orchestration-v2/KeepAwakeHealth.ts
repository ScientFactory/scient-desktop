import type { KeepAwakeExecutionHealth, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { deriveKeepAwakeWork } from "@t3tools/shared/scientKeepAwake";
import * as Effect from "effect/Effect";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";

export const makeKeepAwakeHealth = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManagerV2;
  const worker = yield* OrchestrationEffectWorkerV2;
  return Effect.fn("keepAwake.observeExecutionHealth")(function* (
    projection: OrchestrationV2ThreadProjection,
  ) {
    // Preparing a workspace or saving a checkpoint can be silent and have no provider transport.
    if (worker.isExecutingThread && (yield* worker.isExecutingThread(projection.thread.id))) {
      return "connected" as const;
    }
    if (!sessions.inspectExecution) return "unknown" as const;
    const active = projection.runs.filter((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    );
    const health: KeepAwakeExecutionHealth[] = [];
    for (const run of active) {
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      );
      health.push(
        providerThread === undefined
          ? "unowned"
          : yield* sessions.inspectExecution({
              threadId: projection.thread.id,
              providerThread,
              runOrdinal: run.ordinal,
            }),
      );
    }
    const work = deriveKeepAwakeWork(projection);
    if (active.length === 0 && work.needsAwakeWithoutChildren) {
      // PR watches and scheduled recovery are app-owned; provider teardown cannot disprove them.
      if (
        (projection.thread.pullRequests ?? []).some(
          (pr) => pr.watch !== undefined && pr.source !== "stack-dismissed",
        ) ||
        projection.thread.limitRecovery?.autoResume
      ) {
        health.push("unknown");
      } else if (work.hasRunnableQueue) {
        health.push("unowned");
      } else {
        const providerThread = projection.providerThreads.find(
          (thread) => thread.id === projection.thread.activeProviderThreadId,
        );
        health.push(
          providerThread === undefined
            ? "unknown"
            : yield* sessions.inspectExecution({
                threadId: projection.thread.id,
                providerThread,
              }),
        );
      }
    }
    if (health.includes("connected")) return "connected" as const;
    if (health.includes("unknown") || health.length === 0) return "unknown" as const;
    return "unowned" as const;
  });
});
