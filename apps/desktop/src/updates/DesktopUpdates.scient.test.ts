import * as NodeModule from "node:module";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdateFacts from "../scient/updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness, type UpdatesHarnessOptions } from "./updatesTestHarness.ts";

const requireFromUpdater = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
);
const { newError } = requireFromUpdater("builder-util-runtime") as {
  newError: (message: string, code: string) => Error;
};

type Recorded = { readonly name: string; readonly properties: Record<string, unknown> };

/** The updater with a journal that keeps what it was given. */
function recordingHarness(options: UpdatesHarnessOptions = {}) {
  const recorded: Recorded[] = [];
  const harness = makeHarness(options);
  const facts = Layer.succeed(
    DesktopUpdateFacts.DesktopUpdateFacts,
    DesktopUpdateFacts.DesktopUpdateFacts.of({
      record: (name, properties) => Effect.sync(() => void recorded.push({ name, properties })),
      deliveries: () => Stream.empty,
      sourceReady: () => Effect.void,
      sourceRemoved: () => Effect.void,
      acknowledge: () => Effect.void,
    }),
  );
  const outcomes = (step: string) =>
    recorded
      .filter((fact) => fact.name === "app.update.outcome" && fact.properties.step === step)
      .map((fact) => fact.properties);
  return {
    harness,
    outcomes,
    layer: Layer.merge(TestClock.layer(), harness.layer.pipe(Layer.provide(facts))),
  };
}

describe("DesktopUpdates outcomes", () => {
  it.effect("records one outcome for a check the updater reports twice", () => {
    const offline = newError(
      "Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED",
      "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    );
    // electron-updater emits `error` and also rejects the check's promise.
    const { harness, outcomes, layer } = recordingHarness({
      checkForUpdates: Effect.suspend(() => {
        harness.emit("error", offline);
        return Effect.fail(
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
            channel: "latest",
            cause: offline,
          }),
        );
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("menu");
        yield* flushCallbacks;
        const checks = outcomes("check");
        assert.lengthOf(checks, 1);
        assert.include(checks[0], { outcome: "failed", failureClass: "network", trigger: "user" });
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("records one failed install after the handoff, however many paths report it", () => {
    const refused = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    const { harness, outcomes, layer } = recordingHarness({
      quitAndInstall: Effect.suspend(() => {
        harness.emit("error", refused);
        return Effect.fail(
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: "latest",
            isSilent: true,
            isForceRunAfter: true,
            cause: refused,
          }),
        );
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* updates.install;
        yield* flushCallbacks;
        const installs = outcomes("install");
        assert.deepEqual(
          installs.map((install) => install.outcome),
          ["handoff-attempted", "failed"],
        );
        assert.include(installs[1], {
          failureClass: "permission",
          targetVersion: "1.2.4",
          attemptRef: installs[0]?.attemptRef,
        });
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("reports an install that did not apply once, not at every launch", () =>
    Effect.gen(function* () {
      const record = JSON.stringify({
        fromVersion: "1.2.3",
        targetVersion: "1.2.4",
        startedAt: 0,
        attemptRef: "0123456789abcdef",
      });
      const first = recordingHarness({ installRecord: record });
      yield* Effect.scoped(
        DesktopUpdates.DesktopUpdates.pipe(Effect.flatMap((updates) => updates.configure)),
      ).pipe(Effect.provide(first.layer));
      assert.deepEqual(first.outcomes("apply"), [
        {
          step: "apply",
          outcome: "not-applied",
          targetVersion: "1.2.4",
          packageKind: "zip",
          attemptRef: "0123456789abcdef",
          durationMs: 0,
        },
      ]);
      const kept = [...first.harness.installRecords.values()][0];
      assert.isDefined(kept);

      const second = recordingHarness({ installRecord: kept });
      yield* Effect.scoped(
        DesktopUpdates.DesktopUpdates.pipe(Effect.flatMap((updates) => updates.configure)),
      ).pipe(Effect.provide(second.layer));
      assert.include(kept, '"outcomeReported":true');
      assert.lengthOf(second.outcomes("apply"), 0);
    }),
  );

  it.effect("keeps polling after a poll fails unexpectedly", () => {
    let checks = 0;
    const { harness, layer } = recordingHarness({
      checkForUpdates: Effect.suspend(() =>
        ++checks === 2 ? Effect.die(new Error("unexpected poll failure")) : Effect.void,
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("15 seconds");
        yield* TestClock.adjust("4 hours");
        assert.equal(harness.checkCount(), 2);
        yield* TestClock.adjust("4 hours");
        assert.equal(harness.checkCount(), 3);
      }),
    ).pipe(Effect.provide(layer));
  });
});
