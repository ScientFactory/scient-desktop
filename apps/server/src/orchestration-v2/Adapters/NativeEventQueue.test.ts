import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
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
  let reads = 0;
  let handles = 0;
  let failAt = failAtWrite;
  let failAll = false;
  const injectedOpen: FileSystem.FileSystem["open"] = (name, options) =>
    fileSystem.open(name, options).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          handles++;
        }).pipe(
          Effect.andThen(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                handles--;
              }),
            ),
          ),
        ),
      ),
      Effect.map((file) => {
        const writeAll: FileSystem.File["writeAll"] = (bytes) =>
          Effect.suspend(() => {
            if (++writes === failAt || failAll)
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
        const read: FileSystem.File["read"] = (bytes) =>
          Effect.sync(() => {
            reads++;
          }).pipe(Effect.andThen(file.read(bytes)));
        return new Proxy(file, {
          get: (target, key, receiver) =>
            key === "writeAll"
              ? writeAll
              : key === "read"
                ? read
                : Reflect.get(target, key, receiver),
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
  yield* queue.onDispose(Effect.sync(() => owner.release()));
  yield* Effect.addFinalizer(() => queue.consumer.dispose);
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
    reads: () => reads,
    handles: () => handles,
    failAll: () => {
      failAll = true;
    },
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
  "reclaims thirty resident batches into one cursor and incrementally replays after producer sealing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (let index = 0; index < 30; index++) yield* f.offer(index);
      expect(yield* f.queue.queued).toBe(30);
      expect(f.budget.usage.items).toBe(30);
      expect(yield* f.queue.spill).toBe(true);
      expect(yield* f.queue.queued).toBe(1);
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
      yield* f.queue.consumer.retain;
      const readsBefore = f.reads();
      yield* f.close;
      expect(f.handles()).toBe(1);
      expect(f.reads()).toBe(readsBefore);
      const readerScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(readerScope, Exit.void));
      const pull = yield* Stream.toPull(f.queue.events).pipe(Scope.provide(readerScope));
      const first = yield* pull;
      expect(first).toEqual([f.offered[0]]);
      expect(f.reads()).toBe(2); // One framed record, never the remaining twenty-nine.
      const tail = yield* Stream.runCollect(Stream.fromPull(Effect.succeed(pull)));
      expect([...first, ...tail]).toEqual(f.offered);
      yield* Scope.close(readerScope, Exit.void);
      yield* f.assertRemoved;
      expect(f.handles()).toBe(0);
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
      yield* f.queue.consumer.retain;
      const readsBefore = f.reads();
      yield* f.close;
      expect(f.handles()).toBe(1);
      expect(f.reads()).toBe(readsBefore);
      expect(yield* Stream.runCollect(f.queue.events)).toEqual(f.offered);
      yield* f.assertRemoved;
      expect(f.handles()).toBe(0);
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
      f.failAll();
      yield* f.offer(1);
      yield* f.offer(2);
      expect(yield* f.queue.queued).toBe(3); // One disk cursor and two retained memory batches.
      expect(f.budget.usage.items).toBe(2);
      yield* f.queue.consumer.retain;
      const readsBefore = f.reads();
      yield* f.close;
      expect(f.handles()).toBe(1);
      expect(f.reads()).toBe(readsBefore);
      expect(f.budget.usage.items).toBe(2); // Failed sealing keeps actual resident debt.
      // An ended queue cannot publish a new disk cursor: later pressure must
      // leave this suffix charged and available to its real consumer.
      expect(yield* f.queue.spill).toBe(false);
      expect(f.budget.usage.items).toBe(2);
      expect(yield* Stream.runCollect(f.queue.events)).toEqual(f.offered);
      yield* f.assertRemoved;
      expect(f.handles()).toBe(0);
      f.cleanup();
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "closes the retained spool on an actual interrupted blocked reader without decoding its suffix",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (let index = 0; index < 30; index++) yield* f.offer(index);
      yield* f.queue.consumer.retain;
      yield* f.close;
      const entered = yield* Deferred.make<void>();
      const reader = yield* f.queue.events.pipe(
        Stream.runForEach(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      expect(f.reads()).toBe(2);
      expect(f.handles()).toBe(1);
      yield* Fiber.interrupt(reader);
      expect(f.reads()).toBe(2);
      expect(f.handles()).toBe(0);
      yield* f.assertRemoved;
      expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
      yield* f.queue.consumer.dispose;
      expect(f.handles()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "cleans a failed consumer, a retained never-started consumer and an unpublished producer",
  () =>
    Effect.gen(function* () {
      for (const mode of ["failure", "never-started", "unpublished"] as const) {
        const f = yield* fixture();
        yield* f.offer(0);
        if (mode !== "unpublished") yield* f.queue.consumer.retain;
        yield* f.close;
        if (mode === "failure") {
          const exit = yield* f.queue.events.pipe(
            Stream.runForEach(() => Effect.fail("Sink failed")),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
        } else if (mode === "never-started") yield* f.queue.consumer.dispose;
        expect(f.handles()).toBe(0);
        yield* f.assertRemoved;
        expect(f.budget.usage).toEqual({ bytes: 0, items: 0 });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
