import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { makeEnvironmentThreadState, type EnvironmentThreadState } from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const CACHED: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

// A warm client resumes from its cursor; replay overflow sends the server to a snapshot,
// which for a deleted thread now fails as missing instead of returning a tombstone.
const makeWarmThread = Effect.fn("ScientThreadsSync.makeWarmThread")(function* () {
  const failures = yield* Queue.unbounded<OrchestrationV2GetThreadProjectionError>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const subscriptions = yield* SubscriptionRef.make(0);
  const afterSequence = yield* Ref.make<number | undefined>(undefined);
  const loaderCalls = yield* Ref.make(0);
  const removed = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
    snapshot: undefined,
    owner: undefined,
  };
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Ref.set(afterSequence, input.afterSequence).pipe(
          Effect.andThen(SubscriptionRef.update(subscriptions, (count) => count + 1)),
          Effect.as(
            Stream.fromQueue(failures).pipe(
              Stream.mapEffect(
                (
                  error,
                ): Effect.Effect<
                  OrchestrationV2ThreadStreamItem,
                  OrchestrationV2GetThreadProjectionError
                > => Effect.fail(error),
              ),
            ),
          ),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({}) as never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID
          ? Option.some({ snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: CACHED })
          : Option.none(),
      ),
    saveThread: () => Effect.void,
    removeThread: (_environmentId, threadId) =>
      Ref.update(removed, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    load: () =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as({ _tag: "unavailable" } as const),
      ),
  });
  const state = yield* makeEnvironmentThreadState(THREAD_ID, resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
  );
  yield* SubscriptionRef.changes(state).pipe(
    Stream.runForEach((value) => Queue.offer(observed, value)),
    Effect.forkScoped,
  );
  // The subscription opened from the cached cursor, so the cached detail is on screen.
  yield* SubscriptionRef.changes(subscriptions).pipe(
    Stream.filter((count) => count >= 1),
    Stream.runHead,
  );
  return { state, failures, observed, afterSequence, loaderCalls, removed, resumeCache };
});

const awaitState = (
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) => Queue.take(observed).pipe(Effect.repeat({ until: predicate }));

describe("EnvironmentThreads (Scient)", () => {
  it.effect("retires a warm thread whose snapshot fallback reads as missing", () =>
    Effect.gen(function* () {
      const warm = yield* makeWarmThread();
      expect(yield* Ref.get(warm.afterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

      yield* Queue.offer(
        warm.failures,
        new OrchestrationV2GetThreadProjectionError({
          threadId: THREAD_ID,
          message: `Failed to load orchestration V2 thread ${THREAD_ID}`,
          reason: "thread_not_found",
        }),
      );
      const state = yield* awaitState(warm.observed, (value) => value.status === "deleted");

      expect(Option.isNone(state.data)).toBe(true);
      expect(Option.isNone(state.error)).toBe(true);
      expect(yield* Ref.get(warm.removed)).toEqual([THREAD_ID]);
      // A remount reads the retained deletion, not the old cached detail.
      expect(warm.resumeCache.snapshot?.state.status).toBe("deleted");
      expect(Option.isNone(warm.resumeCache.snapshot!.state.data)).toBe(true);
      expect(yield* Ref.get(warm.loaderCalls)).toBe(0);
    }),
  );

  it.effect("keeps the cached thread after any other snapshot failure", () =>
    Effect.gen(function* () {
      const warm = yield* makeWarmThread();

      yield* Queue.offer(
        warm.failures,
        new OrchestrationV2GetThreadProjectionError({
          threadId: THREAD_ID,
          message: "Failed to load orchestration V2 thread",
        }),
      );
      const state = yield* awaitState(warm.observed, (value) => Option.isSome(value.error));

      expect(state.status).toBe("cached");
      expect(Option.getOrThrow(state.data)).toEqual(CACHED);
      expect(Option.getOrThrow(state.error)).toBe("Failed to load orchestration V2 thread");
      expect(yield* Ref.get(warm.removed)).toEqual([]);
    }),
  );
});
