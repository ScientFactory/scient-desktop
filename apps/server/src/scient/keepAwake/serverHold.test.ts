import { describe, expect, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as KeepAwake from "../../background/KeepAwake.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Settings from "../../serverSettings.ts";
import * as KeepAwakeService from "./KeepAwakeService.ts";

const threadId = ThreadId.make("thread");
const providerThreadId = ProviderThreadId.make("provider-thread");
const sessionId = ProviderSessionId.make("session");

const shellWith = (kind: "monitor" | "command") =>
  ({
    id: threadId,
    archivedAt: null,
    deletedAt: null,
    status: "idle",
    activityRunStatus: null,
    activityRunStartedAt: null,
    activeProviderThreadId: providerThreadId,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [{ taskId: "task", kind }],
  }) as unknown as OrchestrationV2ThreadShell;

/** Lets the hold's fibers run, then moves past its one-second batching of thread events. */
const settle = Effect.gen(function* () {
  for (let step = 0; step < 5; step++) {
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
  }
});

describe("T3's keep-awake hold with Scient's work", () => {
  it.effect("does not hold for a monitor, and holds once the thread executes", () =>
    Effect.gen(function* () {
      let shell = shellWith("monitor");
      const events = yield* Queue.unbounded<unknown>();
      const spawned = yield* Queue.unbounded<string>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Queue.offer(spawned, (command as unknown as { command: string }).command);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      const work = KeepAwakeService.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStoreV2, {
            listActiveShellIndex: () =>
              Effect.succeed([
                { id: threadId, mayBeLive: true, lineage: { relationshipToParent: null } },
              ] as never),
            getShellSnapshot: () => Effect.sync(() => ({ threads: [shell] }) as never),
            getThreadRecords: () =>
              Effect.succeed({
                providerThreads: [{ id: providerThreadId, providerSessionId: sessionId }],
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProviderSessionManagerV2, { isLive: () => Effect.succeed(true) })),
      );

      yield* Layer.build(
        KeepAwake.layer.pipe(
          Layer.provide(work),
          Layer.provide(
            Layer.mock(OrchestrationEventStore.OrchestrationEventStore, {
              latestApplicationSequence: Effect.succeed(0),
              streamApplicationEvents: () => Stream.fromQueue(events) as never,
            }),
          ),
          Layer.provide(Settings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        ),
      );

      // A monitor only watches: no hold, on the first check or after a thread event.
      yield* settle;
      yield* Queue.offer(events, { sequence: 1, event: { type: "turn-item.updated" } });
      yield* settle;
      expect(yield* Queue.size(spawned)).toBe(0);

      // A shell change that is not a run event, a command in the background, now holds.
      shell = shellWith("command");
      yield* Queue.offer(events, { sequence: 2, event: { type: "turn-item.updated" } });
      yield* settle;
      expect(yield* Queue.take(spawned)).toBe("caffeinate");
    }),
  );
});
