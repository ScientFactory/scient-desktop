import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ThreadId,
  keepAwakeThreadKey,
  type KeepAwakeDocument,
  type KeepAwakeWork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./controller.ts";
import { KeepAwakeStorage, KeepAwakeStorageError } from "./storage.ts";
import { KeepAwakePower } from "./power.ts";
import type { WorkSourceResult } from "./source.ts";

vi.mock("electron", () => ({ powerSaveBlocker: {} }));
const id = ThreadId.make("thread");
const key = keepAwakeThreadKey("environment", id);
const off: KeepAwakeDocument = { settings: { mode: "system" }, threads: [] };
const work: KeepAwakeWork = {
  threadId: id,
  title: "Thread",
  latestRunId: "run-1",
  removed: false,
  unfinished: true,
  runnable: true,
  blockingInput: false,
  finalizing: false,
  ownership: "connected",
  progress: "1",
  reason: "Work is running",
};
const result = (member = work, local = true): WorkSourceResult[] => [
  { local, batch: { environmentId: "environment", groups: [{ threadId: id, members: [member] }] } },
];
const setup = (initial = off) =>
  Effect.gen(function* () {
    const failSave = yield* Ref.make(false);
    const starts = yield* Ref.make(0);
    const stops = yield* Ref.make(0);
    const controller = yield* make.pipe(
      Effect.provideService(KeepAwakeStorage, {
        load: Effect.succeed(initial),
        save: () =>
          Ref.get(failSave).pipe(
            Effect.flatMap((fail) =>
              fail ? Effect.fail(new KeepAwakeStorageError({ cause: "disk full" })) : Effect.void,
            ),
          ),
      }),
      Effect.provideService(KeepAwakePower, {
        notice: undefined,
        start: Ref.updateAndGet(starts, (count) => count + 1),
        stop: () => Ref.update(stops, (count) => count + 1),
      }),
    );
    return { controller, failSave, starts, stops };
  });

it.effect(
  "keeps a failed disable effective and the save error visible until a successful explicit save",
  () =>
    Effect.gen(function* () {
      const { controller, failSave, starts } = yield* setup({
        settings: { mode: "running" },
        threads: [],
      });
      yield* controller.accept(result());
      assert.equal(yield* Ref.get(starts), 1);
      yield* Ref.set(failSave, true);
      const disabled = yield* controller.handle({
        type: "configure",
        settings: { mode: "system" },
      });
      assert.isFalse(disabled.blocking);
      assert.equal(disabled.settings.mode, "system");
      assert.include(disabled.error!, "Could not save");
      yield* TestClock.adjust("30 seconds");
      yield* controller.tick;
      yield* controller.accept(result());
      assert.isNotNull((yield* controller.handle({ type: "get" })).error);
      assert.equal(yield* Ref.get(starts), 1);
      yield* Ref.set(failSave, false);
      assert.isNull(
        (yield* controller.handle({ type: "configure", settings: { mode: "system" } })).error,
      );
    }),
);

it.effect("arms idle work and consumes a short run using the server's run identity", () =>
  Effect.gen(function* () {
    const { controller } = yield* setup();
    yield* controller.handle(
      { type: "choose", key, title: "Thread", choice: "once" },
      { unfinished: false, latestRunId: "run-1" },
    );
    yield* TestClock.adjust("5 hours");
    yield* controller.accept(result({ ...work, runnable: false, unfinished: false }));
    assert.isTrue((yield* controller.handle({ type: "get" })).threads[0]!.once);
    yield* controller.accept(
      result({ ...work, latestRunId: "run-2", runnable: false, unfinished: false }),
    );
    yield* TestClock.adjust("30 seconds");
    yield* controller.accept(
      result({ ...work, latestRunId: "run-2", runnable: false, unfinished: false }),
    );
    assert.isEmpty((yield* controller.handle({ type: "get" })).threads);
  }),
);

it.effect(
  "pauses for input while preserving the batch, then protects slow finalization after cancellation",
  () =>
    Effect.gen(function* () {
      const { controller } = yield* setup();
      yield* controller.handle(
        { type: "choose", key, title: "Thread", choice: "once" },
        { unfinished: true, latestRunId: "run-1" },
      );
      yield* controller.accept(result());
      yield* controller.accept(result({ ...work, runnable: false, blockingInput: true }));
      const paused = yield* controller.handle({ type: "get" });
      assert.isFalse(paused.blocking);
      assert.isTrue(paused.threads[0]!.once);
      yield* controller.accept(result({ ...work, finalizing: true, reason: "Saving results" }));
      yield* TestClock.adjust("3 minutes");
      yield* controller.accept(result({ ...work, finalizing: true, reason: "Saving results" }));
      assert.isTrue((yield* controller.handle({ type: "get" })).blocking);
      yield* controller.accept(result({ ...work, runnable: false, unfinished: false }));
      yield* TestClock.adjust("30 seconds");
      yield* controller.accept(result({ ...work, runnable: false, unfinished: false }));
      assert.isEmpty((yield* controller.handle({ type: "get" })).threads);
    }),
);

it.effect(
  "releases stale observations without resetting the choice and recovers without a renderer",
  () =>
    Effect.gen(function* () {
      const { controller } = yield* setup();
      yield* controller.handle(
        { type: "choose", key, title: "Thread", choice: "once" },
        { unfinished: true, latestRunId: "run-1" },
      );
      yield* controller.accept(result());
      yield* TestClock.adjust("121 seconds");
      yield* controller.tick;
      const stale = yield* controller.handle({ type: "get" });
      assert.isFalse(stale.blocking);
      assert.isTrue(stale.threads[0]!.once);
      yield* controller.accept(result());
      assert.isTrue((yield* controller.handle({ type: "get" })).blocking);
      yield* controller.stop;
      assert.isFalse((yield* controller.handle({ type: "get" })).blocking);
    }),
);

it.effect("does not renew unowned progress from polls and removes deleted thread records", () =>
  Effect.gen(function* () {
    const { controller } = yield* setup({ settings: { mode: "running" }, threads: [] });
    yield* controller.accept(result({ ...work, ownership: "unowned" }));
    yield* TestClock.adjust("121 seconds");
    yield* controller.accept(result({ ...work, ownership: "unowned" }));
    assert.isFalse((yield* controller.handle({ type: "get" })).blocking);
    yield* controller.accept(
      result({ ...work, removed: true, unfinished: false, runnable: false }),
    );
    assert.isEmpty((yield* controller.handle({ type: "get" })).threads);
  }),
);

it.effect("protects remote work only when explicitly selected", () =>
  Effect.gen(function* () {
    const { controller } = yield* setup({ settings: { mode: "running" }, threads: [] });
    yield* controller.accept(result(work, false));
    assert.isFalse((yield* controller.handle({ type: "get" })).blocking);
    yield* controller.handle(
      { type: "choose", key, title: "Thread", choice: "once" },
      { unfinished: true, latestRunId: "run-1" },
    );
    yield* controller.accept(result(work, false));
    assert.isTrue((yield* controller.handle({ type: "get" })).blocking);
  }),
);

it.effect("ignores a late older response so it cannot consume an armed choice", () =>
  Effect.gen(function* () {
    const { controller } = yield* setup();
    yield* controller.handle(
      { type: "choose", key, title: "Thread", choice: "once" },
      { unfinished: false, latestRunId: "run-1" },
    );
    const idle = { ...work, unfinished: false, runnable: false };
    yield* controller.accept(result(idle).map((entry) => ({ ...entry, generation: 2 })));
    yield* controller.accept(
      result({ ...idle, latestRunId: "older-run" }).map((entry) => ({ ...entry, generation: 1 })),
    );
    yield* TestClock.adjust("30 seconds");
    yield* controller.accept(result(idle).map((entry) => ({ ...entry, generation: 3 })));
    assert.isTrue((yield* controller.handle({ type: "get" })).threads[0]!.once);
  }),
);

it.effect(
  "renews a healthy group member despite an unchanged parent and an unavailable other environment",
  () =>
    Effect.gen(function* () {
      const { controller } = yield* setup({ settings: { mode: "running" }, threads: [] });
      const child = { ...work, threadId: ThreadId.make("child"), progress: "child-progress" };
      const group: WorkSourceResult = {
        local: true,
        batch: {
          environmentId: "environment",
          groups: [{ threadId: id, members: [{ ...work, ownership: "unowned" }, child] }],
        },
      };
      yield* controller.accept([group]);
      yield* TestClock.adjust("121 seconds");
      yield* controller.accept([
        { local: true, batch: { environmentId: "unavailable", groups: [] }, error: "Unavailable" },
        group,
      ]);
      assert.isTrue((yield* controller.handle({ type: "get" })).blocking);
      yield* controller.accept([
        {
          ...group,
          batch: {
            ...group.batch,
            groups: [
              {
                threadId: id,
                members: [
                  { ...work, ownership: "unowned" },
                  { ...child, runnable: false },
                ],
              },
            ],
          },
        },
      ]);
      assert.isFalse((yield* controller.handle({ type: "get" })).blocking);
    }),
);
