import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  acquireFixtureResource,
  awaitFixtureRelease,
  stopOwnedFixtureProcess,
} from "../test/connectedFixture";

describe("connected fixture acquisition ownership", () => {
  it.effect(
    "joins a late acquisition before cancelling and releases it before earlier resources",
    () =>
      Effect.gen(function* () {
        const late = Promise.withResolvers<string>();
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const released: string[] = [];
        let returned = false;
        const opening = Effect.gen(function* () {
          yield* acquireFixtureResource(
            async () => "directory",
            (resource) =>
              Effect.sync(() => {
                released.push(resource);
              }),
          );
          yield* acquireFixtureResource(
            () => {
              Deferred.doneUnsafe(started, Effect.void);
              return late.promise;
            },
            (resource) =>
              Effect.sync(() => {
                released.push(resource);
              }),
          );
          returned = true;
        });
        // This child scope models the fixture lifetime independently of the test's scope.
        const fiber = yield* Effect.forkChild(Effect.scoped(opening), { startImmediately: true });
        yield* Deferred.await(started);
        const cancellation = yield* Effect.forkChild(
          Fiber.interrupt(fiber).pipe(Effect.andThen(Deferred.succeed(cancelled, undefined))),
          { startImmediately: true },
        );
        assert.isFalse(yield* Deferred.isDone(cancelled));
        assert.deepStrictEqual(released, []);
        late.resolve("browser");
        yield* Fiber.join(cancellation);
        assert.isTrue(yield* Deferred.isDone(cancelled));
        assert.isFalse(returned);
        assert.deepStrictEqual(released, ["browser", "directory"]);
      }),
  );

  it.effect("releases earlier resources when a later acquisition rejects", () =>
    Effect.gen(function* () {
      const released: string[] = [];
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireFixtureResource(
            async () => "directory",
            (resource) =>
              Effect.sync(() => {
                released.push(resource);
              }),
          );
          return yield* acquireFixtureResource(
            () => Promise.reject(new Error("Synthetic acquisition failure")),
            () =>
              Effect.sync(() => {
                released.push("unacquired browser");
              }),
          );
        }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.deepStrictEqual(released, ["directory"]);
    }),
  );
});

function setupProcess(
  exitCode: number | null = null,
  onSignal?: (signal: "SIGTERM" | "SIGKILL", emitExit: () => void, listeners: number) => void,
) {
  const listeners = new Set<() => void>();
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const emitExit = () => {
    for (const listener of listeners) {
      listeners.delete(listener);
      listener();
    }
  };
  const stdio = () => ({
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  });
  const child = {
    exitCode,
    signalCode: null,
    stdout: stdio(),
    stderr: stdio(),
    once(_event: "exit", listener: () => void) {
      listeners.add(listener);
    },
    off(_event: "exit", listener: () => void) {
      listeners.delete(listener);
    },
    kill(signal: "SIGTERM" | "SIGKILL") {
      signals.push(signal);
      onSignal?.(signal, emitExit, listeners.size);
      return true;
    },
  };
  return { child, signals, listeners, emitExit };
}

function setupRelease(released = false, releaseDuringSubscribe = false) {
  const changes = new Set<() => void>();
  const failures = new Set<(cause: unknown) => void>();
  let closed = false;
  let checks = 0;
  const source = {
    exists() {
      checks += 1;
      return released;
    },
    subscribe(changed: () => void, failed: (cause: unknown) => void) {
      changes.add(changed);
      failures.add(failed);
      if (releaseDuringSubscribe) released = true;
      return () => {
        changes.delete(changed);
        failures.delete(failed);
        closed = true;
      };
    },
  };
  return {
    source,
    changes,
    failures,
    closed: () => closed,
    checks: () => checks,
    release() {
      released = true;
      for (const changed of changes) changed();
    },
  };
}

describe("owned connected fixture leader retirement", () => {
  it.effect("does not signal an already exited leader", () =>
    Effect.gen(function* () {
      const { child, signals, listeners } = setupProcess(0);
      yield* stopOwnedFixtureProcess(child);
      assert.deepStrictEqual(signals, []);
      assert.strictEqual(listeners.size, 0);
    }),
  );

  it.effect("subscribes before SIGTERM and settles on its actual exit receipt", () =>
    Effect.gen(function* () {
      const { child, signals, listeners } = setupProcess(null, (_signal, exit, count) => {
        assert.strictEqual(count, 1);
        exit();
      });
      yield* stopOwnedFixtureProcess(child);
      yield* TestClock.adjust("13 seconds");
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      assert.strictEqual(listeners.size, 0);
      assert.isTrue(child.stdout.destroyed);
      assert.isTrue(child.stderr.destroyed);
    }),
  );

  it.effect("escalates at ten seconds, not before, and still requires an exit receipt", () =>
    Effect.gen(function* () {
      const { child, signals, listeners, emitExit } = setupProcess();
      const fiber = yield* Effect.forkChild(stopOwnedFixtureProcess(child), {
        startImmediately: true,
      });
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      yield* TestClock.adjust(9999);
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.strictEqual(listeners.size, 1);
      emitExit();
      yield* Fiber.join(fiber);
      assert.strictEqual(listeners.size, 0);
      assert.isTrue(child.stdout.destroyed);
      assert.isTrue(child.stderr.destroyed);
    }),
  );

  it.effect("fails at the original thirteen-second deadline without an exit receipt", () =>
    Effect.gen(function* () {
      const { child, signals, listeners } = setupProcess();
      const fiber = yield* Effect.forkChild(stopOwnedFixtureProcess(child).pipe(Effect.flip), {
        startImmediately: true,
      });
      yield* TestClock.adjust("13 seconds");
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure.message, "Owned fixture leader did not exit");
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.strictEqual(listeners.size, 0);
      assert.isTrue(child.stdout.destroyed);
      assert.isTrue(child.stderr.destroyed);
    }),
  );

  it.effect("removes listeners, stdio and both deadlines on interruption", () =>
    Effect.gen(function* () {
      const { child, signals, listeners } = setupProcess();
      const fiber = yield* Effect.forkChild(stopOwnedFixtureProcess(child), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("13 seconds");
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      assert.strictEqual(listeners.size, 0);
      assert.isTrue(child.stdout.destroyed);
      assert.isTrue(child.stderr.destroyed);
    }),
  );
});

describe("controlled ACP private release receipts", () => {
  it.effect("observes a release that already exists and closes its subscription", () =>
    Effect.gen(function* () {
      const receipt = setupRelease(true);
      yield* awaitFixtureRelease(receipt.source);
      assert.strictEqual(receipt.checks(), 1);
      assert.isTrue(receipt.closed());
      assert.strictEqual(receipt.changes.size, 0);
    }),
  );

  it.effect("observes a release after subscription", () =>
    Effect.gen(function* () {
      const receipt = setupRelease();
      const fiber = yield* Effect.forkChild(awaitFixtureRelease(receipt.source), {
        startImmediately: true,
      });
      assert.strictEqual(receipt.checks(), 1);
      receipt.release();
      yield* Fiber.join(fiber);
      assert.strictEqual(receipt.checks(), 2);
      assert.isTrue(receipt.closed());
    }),
  );

  it.effect("does not settle on a change without the actual release predicate", () =>
    Effect.gen(function* () {
      const receipt = setupRelease();
      const settled = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        awaitFixtureRelease(receipt.source).pipe(
          Effect.andThen(Deferred.succeed(settled, undefined)),
        ),
        { startImmediately: true },
      );
      for (const changed of receipt.changes) changed();
      assert.isFalse(yield* Deferred.isDone(settled));
      assert.strictEqual(receipt.checks(), 2);
      receipt.release();
      yield* Fiber.join(fiber);
      assert.isTrue(receipt.closed());
    }),
  );

  it.effect("rechecks a release created during registration", () =>
    Effect.gen(function* () {
      const receipt = setupRelease(false, true);
      yield* awaitFixtureRelease(receipt.source);
      assert.strictEqual(receipt.checks(), 1);
      assert.isTrue(receipt.closed());
    }),
  );

  it.effect("closes the subscription when the held turn is cancelled", () =>
    Effect.gen(function* () {
      const receipt = setupRelease();
      const fiber = yield* Effect.forkChild(awaitFixtureRelease(receipt.source), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(fiber);
      assert.isTrue(receipt.closed());
      assert.strictEqual(receipt.changes.size, 0);
      assert.strictEqual(receipt.failures.size, 0);
    }),
  );

  it.effect("surfaces watcher failure and closes its subscription", () =>
    Effect.gen(function* () {
      const receipt = setupRelease();
      const fiber = yield* Effect.forkChild(awaitFixtureRelease(receipt.source).pipe(Effect.flip), {
        startImmediately: true,
      });
      for (const failed of receipt.failures) failed(new Error("Synthetic watcher failure"));
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure.message, "Synthetic watcher failure");
      assert.isTrue(receipt.closed());
    }),
  );

  it.effect("surfaces subscription setup failure", () =>
    Effect.gen(function* () {
      const receipt = setupRelease();
      const failure = yield* awaitFixtureRelease({
        ...receipt.source,
        subscribe() {
          throw new Error("Synthetic subscription setup failure");
        },
      }).pipe(Effect.flip);
      assert.strictEqual(failure.message, "Synthetic subscription setup failure");
    }),
  );
});
