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
  {
    /** Every thread's work, with the parents it reports to: the desktop's per-thread holds. */
    readonly work: Effect.Effect<KeepAwakeWork, KeepAwakeWorkError>;
    /**
     * Whether `work` would list any thread as working, the server hold's whole question. It stops
     * at the first owned thread: start grace needs no read, and owner reads go one at a time.
     * A read it never reaches can't fail it: a known working thread already answers yes.
     */
    readonly anyWorking: Effect.Effect<boolean, KeepAwakeWorkError>;
  }
>()("t3/scient/keepAwake/KeepAwakeService") {}

export const layer = Layer.effect(
  KeepAwakeService,
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;

    const inStartGrace = (shell: OrchestrationV2ThreadShell, now: number) => {
      const startedAt = shell.activityRunStartedAt ?? null;
      return startedAt !== null && now - DateTime.toEpochMillis(startedAt) < START_GRACE_MS;
    };
    /** A saved run can outlive whatever ran it. A provider session ends, on its idle timeout at most. */
    const hasOwner = Effect.fn("KeepAwakeService.hasOwner")(function* (
      shell: OrchestrationV2ThreadShell,
      now: number,
    ) {
      if (inStartGrace(shell, now)) return true;
      const { providerThreads } = yield* store.getThreadRecords(shell.id, ["providerThreads"]);
      const session = providerThreads.find(
        (thread) => thread.id === shell.activeProviderThreadId,
      )?.providerSessionId;
      return session != null && (yield* sessions.isLive(session));
    });

    const observe = Effect.gen(function* () {
      const index = yield* store.listActiveShellIndex();
      const threadIds = index.filter((entry) => entry.mayBeLive).map((entry) => entry.id);
      if (threadIds.length === 0) return { index, threads: [], now: 0 };
      const { threads } = yield* store.getShellSnapshot({ threadIds });
      return { index, threads, now: yield* Clock.currentTimeMillis };
    });

    return KeepAwakeService.of({
      anyWorking: Effect.gen(function* () {
        const { threads, now } = yield* observe;
        const executing = threads.filter((shell) => threadWork(shell) === "executing");
        if (executing.some((shell) => inStartGrace(shell, now))) return true;
        for (const shell of executing) if (yield* hasOwner(shell, now)) return true;
        return false;
      }).pipe(Effect.mapError((cause) => new KeepAwakeWorkError({ cause }))),
      work: Effect.gen(function* () {
        const { index, threads, now } = yield* observe;
        if (threads.length === 0) return { working: [], waiting: [] };
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
