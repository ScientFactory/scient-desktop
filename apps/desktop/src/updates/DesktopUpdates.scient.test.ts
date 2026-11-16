import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect("a late download cannot replace the currently offered release", () => {
  const harness = makeHarness();
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-available", { version: "1.2.5" });
      const { changes } = yield* updates.subscribe;
      harness.emit("update-downloaded", { version: "1.2.4" });
      harness.emit("update-downloaded", { version: "1.2.5" });
      yield* Stream.runHead(Stream.filter(changes, (state) => state.downloadedVersion === "1.2.5"));
      assert.notInclude(
        harness.sentStates.map((state) => state.downloadedVersion),
        "1.2.4",
      );
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.5");
      assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
      assert.equal(harness.quitAndInstalls(), 0);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("late update events cannot change the release reserved for installation", () =>
  Effect.gen(function* () {
    const stopping = yield* Deferred.make<void>();
    const releaseStop = yield* Deferred.make<void>();
    const harness = makeHarness({
      stopBackend: Deferred.succeed(stopping, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStop)),
      ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
        yield* Deferred.await(stopping);
        harness.emit("update-available", { version: "1.2.5" });
        harness.emit("update-downloaded", { version: "1.2.5" });
        harness.emit("download-progress", { percent: 25 });
        harness.emit("update-not-available");
        yield* Deferred.succeed(releaseStop, undefined);
        const result = yield* Fiber.join(install);
        assert.isTrue(result.accepted);
        assert.equal(result.state.downloadedVersion, "1.2.4");
        assert.equal(result.state.status, "preparing");
        assert.equal(harness.quitAndInstalls(), 1);
        assert.deepEqual(
          [...harness.installRecords.values()].map((record) => JSON.parse(record).targetVersion),
          ["1.2.4"],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  }),
);

it.effect(
  "prepares only after consent and keeps backends usable until native readiness and both saves",
  () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      const nativeReady = yield* Deferred.make<void>();
      let stopped = false;
      let saves = 0;
      const preparedVersions: string[] = [];
      const harness = makeHarness({
        saveBeforeInstall: Effect.sync(() => {
          saves += 1;
          return true;
        }),
        prepareUpdate: (version) =>
          Effect.sync(() => {
            preparedVersions.push(version);
          }).pipe(
            Effect.andThen(Deferred.succeed(preparing, undefined)),
            Effect.andThen(Deferred.await(nativeReady)),
          ),
        stopBackend: Effect.sync(() => {
          stopped = true;
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const desktop = yield* DesktopState.DesktopState;
          yield* updates.configure;
          const { changes } = yield* updates.subscribe;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Stream.runHead(changes);
          assert.deepEqual(preparedVersions, []);
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
          yield* Deferred.await(preparing);
          assert.equal((yield* updates.getState).status, "preparing");
          assert.isFalse(yield* Ref.get(desktop.quitting));
          assert.isFalse(stopped);
          assert.equal(saves, 1);
          assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
          harness.emit("error", new Error("duplicate native error event"));
          assert.isTrue(yield* updates.isInstallActive);
          yield* Deferred.succeed(nativeReady, undefined);
          assert.isTrue((yield* Fiber.join(install)).accepted);
          assert.equal(saves, 2);
          assert.isTrue(stopped);
          assert.deepEqual(preparedVersions, ["1.2.4"]);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
);

it.effect(
  "native preparation timeout leaves the app running and allows retry of the authorized version",
  () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      let attempts = 0;
      let stops = 0;
      const harness = makeHarness({
        prepareUpdate: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void;
          }),
        stopBackend: Effect.sync(() => {
          stops += 1;
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const desktop = yield* DesktopState.DesktopState;
          yield* updates.configure;
          const { changes } = yield* updates.subscribe;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Stream.runHead(changes);
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
          yield* Deferred.await(preparing);
          yield* TestClock.adjust("5 minutes");
          const failed = yield* Fiber.join(install);
          assert.isTrue(failed.failed);
          assert.equal(failed.state.errorContext, "install");
          assert.equal(stops, 0);
          assert.isFalse(yield* Ref.get(desktop.quitting));
          assert.isFalse(yield* updates.isActionActive);
          assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
          assert.equal(attempts, 2);
          assert.equal(stops, 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
);

it.effect.each([1, 2])(
  "a failed workspace save at barrier %s prevents native handoff and backend shutdown",
  (failedSave) => {
    let saves = 0;
    let preparations = 0;
    let stops = 0;
    const harness = makeHarness({
      saveBeforeInstall: Effect.sync(() => {
        saves += 1;
        return saves !== failedSave;
      }),
      prepareUpdate: () =>
        Effect.sync(() => {
          preparations += 1;
        }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktop = yield* DesktopState.DesktopState;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const failed = yield* updates.installPrepared("1.2.4");
        assert.isTrue(failed.failed);
        assert.equal(preparations, failedSave - 1);
        assert.equal(stops, 0);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse(yield* Ref.get(desktop.quitting));
        assert.isFalse(yield* updates.isActionActive);
        assert.equal(failed.state.errorContext, "install");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  },
);

it.effect(
  "a terminal native error requires a fresh download and new consent without touching running backends",
  () => {
    let attempts = 0;
    let stops = 0;
    let lastRejectedCheck = 0;
    let downloadedAfterFreshCheck = false;
    const harness = makeHarness({
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
      downloadUpdate: Effect.sync(() => {
        downloadedAfterFreshCheck = harness.checkCount() > lastRejectedCheck;
        harness.emit("update-downloaded", { version: "1.2.4" });
      }),
      prepareUpdate: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1 || !downloadedAfterFreshCheck
            ? Effect.fail(
                new ElectronUpdater.ElectronUpdaterPrepareUpdateError({
                  channel: "latest",
                  cause: new Error("signature refused"),
                  retryDownload: true,
                }),
              )
            : Effect.void;
        }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const failed = yield* updates.installPrepared("1.2.4");
        assert.isTrue(failed.failed);
        assert.isNull(failed.state.downloadedVersion);
        assert.equal(failed.state.errorContext, "download");
        assert.equal(stops, 0);
        assert.equal(harness.quitAndInstalls(), 0);
        lastRejectedCheck = harness.checkCount();
        yield* TestClock.adjust("1 minute");
        yield* Stream.runHead(
          changes.pipe(Stream.filter((state) => state.status === "downloaded")),
        );
        assert.equal(attempts, 1);
        assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
        assert.equal(stops, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  },
);

it.effect("releases the final workspace lock when an install is interrupted before shutdown", () =>
  Effect.gen(function* () {
    const locking = yield* Deferred.make<void>();
    let released = false;
    let stopped = false;
    const harness = makeHarness({
      lockBeforeInstall: Deferred.succeed(locking, undefined).pipe(Effect.andThen(Effect.never)),
      releaseAfterInstallFailure: Effect.sync(() => {
        released = true;
      }),
      stopBackend: Effect.sync(() => {
        stopped = true;
      }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktop = yield* DesktopState.DesktopState;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Stream.runHead(changes);
        const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkChild);
        yield* Deferred.await(locking);
        assert.isTrue(yield* Ref.get(desktop.quitting));
        yield* Fiber.interrupt(install);
        assert.isTrue(released);
        assert.isFalse(stopped);
        assert.isFalse(yield* Ref.get(desktop.quitting));
        assert.isFalse(yield* updates.isActionActive);
        assert.equal((yield* updates.getState).status, "downloaded");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  }),
);
