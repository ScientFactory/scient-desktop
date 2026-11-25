import { assert, describe, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { KeepAwakeService, layer } from "./KeepAwakeService.ts";

const threadId = ThreadId.make("thread");
const providerThreadId = ProviderThreadId.make("provider-thread");
const sessionId = ProviderSessionId.make("session");

const runningThread = (startedAtMs: number) =>
  ({
    id: threadId,
    archivedAt: null,
    deletedAt: null,
    status: "running",
    activityRunStatus: "running",
    activityRunStartedAt: DateTime.makeUnsafe(startedAtMs),
    activeProviderThreadId: providerThreadId,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
  }) as unknown as OrchestrationV2ThreadShell;

const work = (shell: OrchestrationV2ThreadShell, sessionLive: boolean) =>
  Effect.gen(function* () {
    const service = yield* KeepAwakeService;
    return yield* service.work;
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStoreV2, {
            listActiveShellIndex: () =>
              Effect.succeed([
                { id: threadId, mayBeLive: true, lineage: { relationshipToParent: null } },
              ] as never),
            getShellSnapshot: () => Effect.succeed({ threads: [shell] } as never),
            getThreadRecords: () =>
              Effect.succeed({
                providerThreads: [{ id: providerThreadId, providerSessionId: sessionId }],
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderSessionManagerV2, { isLive: () => Effect.succeed(sessionLive) }),
        ),
      ),
    ),
  );

const LONG_AGO = -60 * 60 * 1000;

describe("KeepAwakeService", () => {
  it.effect("counts a long silent run while its provider session lives", () =>
    Effect.gen(function* () {
      const result = yield* work(runningThread(LONG_AGO), true);
      assert.deepEqual(result, { working: [threadId], waiting: [] });
    }),
  );

  it.effect("stops counting a saved run with no session behind it", () =>
    Effect.gen(function* () {
      const result = yield* work(runningThread(LONG_AGO), false);
      assert.deepEqual(result, { working: [], waiting: [threadId] });
    }),
  );

  it.effect("counts a run that is still starting its session", () =>
    Effect.gen(function* () {
      const result = yield* work(runningThread(0), false);
      assert.deepEqual(result, { working: [threadId], waiting: [] });
    }),
  );
});

// The server hold asks only whether anything works; it must answer as `work` would, with as few
// owner reads as possible.
const shellFor = (id: string, overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    ...runningThread(LONG_AGO),
    id: ThreadId.make(id),
    activeProviderThreadId: ProviderThreadId.make(`provider-${id}`),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const observeMany = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  live: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    let ownerReads = 0;
    const provide = <A, E>(effect: Effect.Effect<A, E, KeepAwakeService>) =>
      effect.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mock(ProjectionStoreV2, {
                listActiveShellIndex: () =>
                  Effect.succeed(
                    shells.map((shell) => ({
                      id: shell.id,
                      mayBeLive: true,
                      lineage: { relationshipToParent: null },
                    })) as never,
                  ),
                getShellSnapshot: () => Effect.succeed({ threads: shells } as never),
                getThreadRecords: (id: ThreadId) =>
                  Effect.sync(() => {
                    ownerReads++;
                    return {
                      providerThreads: [
                        {
                          id: ProviderThreadId.make(`provider-${id}`),
                          providerSessionId: ProviderSessionId.make(`session-${id}`),
                        },
                      ],
                    } as never;
                  }),
              }),
            ),
            Layer.provide(
              Layer.mock(ProviderSessionManagerV2, {
                isLive: (session: ProviderSessionId) => Effect.succeed(live.has(session)),
              }),
            ),
          ),
        ),
      );
    const full = yield* provide(
      Effect.gen(function* () {
        return yield* (yield* KeepAwakeService).work;
      }),
    );
    const fullReads = ownerReads;
    ownerReads = 0;
    const any = yield* provide(
      Effect.gen(function* () {
        return yield* (yield* KeepAwakeService).anyWorking;
      }),
    );
    return { full, fullReads, any, anyReads: ownerReads };
  });

describe("KeepAwakeService.anyWorking", () => {
  it.effect("answers exactly as work would, for every mix of threads", () =>
    Effect.gen(function* () {
      const finished = shellFor("finished", {
        activityRunStatus: null,
        activityRunStartedAt: null,
      });
      const asking = shellFor("asking", {
        pendingRuntimeRequest: { kind: "approval", blocking: true },
      });
      const cases: ReadonlyArray<
        readonly [string, ReadonlyArray<OrchestrationV2ThreadShell>, ReadonlyArray<string>]
      > = [
        ["nothing", [], []],
        ["an owned run", [shellFor("a")], ["session-a"]],
        ["a run without its session", [shellFor("a")], []],
        ["a starting run", [shellFor("a", { activityRunStartedAt: DateTime.makeUnsafe(0) })], []],
        ["unowned then owned", [shellFor("a"), shellFor("b")], ["session-b"]],
        ["finished and asking only", [finished, asking], ["session-finished", "session-asking"]],
      ];
      for (const [name, shells, live] of cases) {
        const result = yield* observeMany(shells, new Set(live));
        assert.strictEqual(result.any, result.full.working.length > 0, name);
      }
    }),
  );

  it.effect("stops at the first owned thread instead of reading every owner", () =>
    Effect.gen(function* () {
      const shells = Array.from({ length: 8 }, (_, index) => shellFor(`t${String(index)}`));
      const result = yield* observeMany(shells, new Set(shells.map((s) => `session-${s.id}`)));
      assert.strictEqual(result.fullReads, 8);
      assert.isTrue(result.any);
      assert.strictEqual(result.anyReads, 1);
    }),
  );

  it.effect("answers for a starting run without reading any owner", () =>
    Effect.gen(function* () {
      const shells = [
        ...Array.from({ length: 7 }, (_, index) => shellFor(`t${String(index)}`)),
        shellFor("new", { activityRunStartedAt: DateTime.makeUnsafe(0) }),
      ];
      const result = yield* observeMany(shells, new Set());
      assert.isTrue(result.any);
      assert.strictEqual(result.anyReads, 0);
    }),
  );
});
