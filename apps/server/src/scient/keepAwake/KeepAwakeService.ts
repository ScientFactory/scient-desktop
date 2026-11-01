import type { KeepAwakeWork, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { summarizeWork, threadWork } from "./work.ts";

/** Long enough for a run to prepare its worktree and open a provider session. */
const START_GRACE_MS = 5 * 60 * 1000;

export class KeepAwakeWorkError extends Schema.TaggedError<KeepAwakeWorkError>()(
  "KeepAwakeWorkError",
  { cause: Schema.Defect() },
) {}

export class KeepAwakeService extends Context.Service<
  KeepAwakeService,
  { readonly work: Effect.Effect<KeepAwakeWork, KeepAwakeWorkError> }
>()("t3/scient/keepAwake/KeepAwakeService") {}

export const layer = Layer.effect(
  KeepAwakeService,
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;

    /** A saved run can outlive whatever ran it. A provider session ends, on its idle timeout at most. */
    const hasOwner = Effect.fn("KeepAwakeService.hasOwner")(function* (
      shell: OrchestrationV2ThreadShell,
      now: number,
    ) {
      const startedAt = shell.activityRunStartedAt ?? null;
      if (startedAt !== null && now - DateTime.toEpochMillis(startedAt) < START_GRACE_MS)
        return true;
      const { providerThreads } = yield* store.getThreadRecords(shell.id, ["providerThreads"]);
      const session = providerThreads.find(
        (thread) => thread.id === shell.activeProviderThreadId,
      )?.providerSessionId;
      return session != null && (yield* sessions.isLive(session));
    });

    return KeepAwakeService.of({
      work: Effect.gen(function* () {
        const index = yield* store.listActiveShellIndex();
        const threadIds = index.filter((entry) => entry.mayBeLive).map((entry) => entry.id);
        if (threadIds.length === 0) return { working: [], waiting: [] };
        const { threads } = yield* store.getShellSnapshot({ threadIds });
        const now = yield* Clock.currentTimeMillis;
        const work = yield* Effect.forEach(threads, (shell) =>
          Effect.gen(function* () {
            const state = threadWork(shell);
            if (state !== "executing") return { threadId: shell.id, work: state };
            const owned = yield* hasOwner(shell, now);
            return {
              threadId: shell.id,
              work: owned ? ("working" as const) : ("waiting" as const),
            };
          }),
        );
        return summarizeWork(work, new Map(index.map((entry) => [entry.id, entry.lineage])));
      }).pipe(Effect.mapError((cause) => new KeepAwakeWorkError({ cause }))),
    });
  }),
);
