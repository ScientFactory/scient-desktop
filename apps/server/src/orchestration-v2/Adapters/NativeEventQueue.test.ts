import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { makeNativeEventQueue } from "./NativeEventQueue.ts";
import {
  makeNativeEventQueueBudget,
  type NativeEventQueueCharge,
} from "./NativeEventQueueBudget.ts";

const fixture = Effect.fnUntraced(function* (failAtWrite?: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "native-queue-test-" });
  const queueScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(queueScope, Exit.void));
  let writes = 0;
  let failAt = failAtWrite;
  const injectedOpen: FileSystem.FileSystem["open"] = (name, options) =>
    fileSystem.open(name, options).pipe(
      Effect.map((file) => {
        const writeAll: FileSystem.File["writeAll"] = (bytes) =>
          Effect.suspend(() => {
            if (++writes === failAt)
              return Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeAll",
                    description: "Injected spill failure",
                  }),
                ),
              );
            return file.writeAll(bytes);
          });
        return new Proxy(file, {
          get: (target, key, receiver) =>
            key === "writeAll" ? writeAll : Reflect.get(target, key, receiver),
        });
      }),
    );
  const storage = new Proxy(fileSystem, {
    get: (target, key, receiver) =>
      key === "open" ? injectedOpen : Reflect.get(target, key, receiver),
  });
  const queue = yield* makeNativeEventQueue({ fileSystem: storage, path, directory }).pipe(
    Scope.provide(queueScope),
  );
  const budget = makeNativeEventQueueBudget({
    maxBytes: 64 * 1024,
    maxItems: 128,
    globalFactor: 4,
  });
  const owner = budget.open(Effect.void, queue.spill);
  const charges: NativeEventQueueCharge[] = [];
  const offered: ProviderAdapterV2Event[] = [];
  const offer = Effect.fnUntraced(function* (index: number) {
    const frame: ProviderAdapterV2Event = {
      type: "authentication.invalidated",
      driver: ProviderDriverKind.make("omp"),
      message: `ordered-receipt-${index}`,
    };
    const result = yield* owner.admit([frame], true, 1, (charge) => queue.offer([frame], charge));
    expect(result.admitted).toBe(true);
    if (!result.charge) return yield* Effect.die("Missing admitted charge");
    charges.push(result.charge);
    offered.push(frame);
  });
  return {
    queue,
    budget,
    offer,
    offered,
    failNext: () => {
      failAt = writes + 1;
    },
    close: Scope.close(queueScope, Exit.void),
    cleanup: () => {
      owner.release();
      charges.forEach((charge) => {
        charge.release();
        charge.release();
      });
    },
    assertRemoved: fileSystem
      .readDirectory(directory)
      .pipe(Effect.map((files) => expect(files).toEqual([]))),
  };
});

it.effect(
  "reclaims thirty resident batches into one cursor and replays after actual file closure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (let index = 0; index < 30; index++) yield* f.offer(index);
      expect(yield* f.queue.queued).toBe(30);
      expect(f.budget.usage.items).toBe(30);
      expect(yield* f.queue.spill).toBe(true);
      expect(yield* f.queue.queued).toBe(1);
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
      yield* f.close;
      yield* f.assertRemoved;
      expect(yield* Stream.runCollect(f.queue.events)).toEqual(f.offered);
      f.cleanup();
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "restores payloads and charges after a partial spill fails, then retries without duplication",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(3);
      for (let index = 0; index < 30; index++) yield* f.offer(index);
      const before = f.budget.usage;
      expect(yield* f.queue.spill).toBe(false);
      expect(yield* f.queue.queued).toBe(30);
      expect(f.budget.usage).toEqual(before);
      expect(yield* f.queue.spill).toBe(true);
      expect(yield* f.queue.queued).toBe(1);
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
      yield* f.close;
      yield* f.assertRemoved;
      expect(yield* Stream.runCollect(f.queue.events)).toEqual(f.offered);
      f.cleanup();
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps disk prefix and charged memory suffix ordered when a later append fails before release",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.offer(0);
      expect(yield* f.queue.spill).toBe(true);
      f.failNext();
      yield* f.offer(1);
      yield* f.offer(2);
      expect(yield* f.queue.queued).toBe(3); // One disk cursor and two retained memory batches.
      expect(f.budget.usage.items).toBe(2);
      yield* f.close;
      yield* f.assertRemoved;
      expect(yield* Stream.runCollect(f.queue.events)).toEqual(f.offered);
      f.cleanup();
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
