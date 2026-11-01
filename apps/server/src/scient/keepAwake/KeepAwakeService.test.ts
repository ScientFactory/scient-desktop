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
