import type { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

interface LiveOwner {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly eventPump: { readonly ended: boolean };
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly busyTurns: ReadonlySet<string>;
}
export interface ExecutionInspection {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runOrdinal?: number;
}

export function makeExecutionInspector(
  read: Effect.Effect<ReadonlyMap<string, LiveOwner>>,
  releasing: { readonly has: (runtime: ProviderAdapterV2SessionRuntime) => boolean },
  turnKey: (id: OrchestrationV2ProviderThread["id"], ordinal: number) => string,
) {
  return Effect.fn("KeepAwake.inspectExecution")(function* (input: ExecutionInspection) {
    const absent = input.runOrdinal === undefined ? ("unknown" as const) : ("unowned" as const);
    const id = input.providerThread.providerSessionId;
    const owner = id === null ? undefined : (yield* read).get(String(id));
    if (
      !owner ||
      releasing.has(owner.runtime) ||
      owner.eventPump.ended ||
      owner.runtime.providerSession.status === "error" ||
      owner.runtime.providerSession.status === "stopped" ||
      (input.runOrdinal !== undefined && !owner.attachedThreadIds.has(input.threadId))
    )
      return absent;
    if (input.runOrdinal !== undefined)
      return owner.busyTurns.has(turnKey(input.providerThread.id, input.runOrdinal))
        ? ("connected" as const)
        : ("unowned" as const);
    const probe = owner.runtime.hasPendingBackgroundWorkForThread?.(input.providerThread);
    return probe !== undefined && (yield* probe) ? ("connected" as const) : ("unknown" as const);
  });
}

export function makeExecutionCounter() {
  const counts = new Map<ThreadId, number>();
  return {
    isExecuting: (id: ThreadId) => Effect.sync(() => counts.has(id)),
    track: <A, E, R>(id: ThreadId, work: Effect.Effect<A, E, R>, kind = "execution") =>
      kind === "thread-title.generate"
        ? work
        : Effect.acquireUseRelease(
            Effect.sync(() => counts.set(id, (counts.get(id) ?? 0) + 1)),
            () => work,
            () =>
              Effect.sync(() => {
                const next = (counts.get(id) ?? 1) - 1;
                if (next === 0) counts.delete(id);
                else counts.set(id, next);
              }),
          ),
  };
}
