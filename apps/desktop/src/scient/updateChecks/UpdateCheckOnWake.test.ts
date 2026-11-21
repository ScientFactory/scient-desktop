import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../../updates/updateMachine.ts";
import { checkedRecently, listen } from "./UpdateCheckOnWake.ts";

describe("checkedRecently", () => {
  it("counts checks from the last 15 minutes", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    assert.isTrue(checkedRecently("2026-11-21T11:50:00Z", now));
    assert.isFalse(checkedRecently("2026-11-21T11:44:00Z", now));
    assert.isFalse(checkedRecently(null, now));
    assert.isFalse(checkedRecently("not a date", now));
    // A clock set back after a check does not block checks.
    assert.isFalse(checkedRecently("2026-11-21T12:05:00Z", now));
  });
});

describe("listen", () => {
  it.effect("checks once, 30 seconds after the computer wakes", () =>
    Effect.gen(function* () {
      const resumeListeners: Array<() => void> = [];
      const checks = yield* Ref.make<ReadonlyArray<string>>([]);
      const checkedAt = yield* Ref.make<string | null>(null);
      const state = createInitialDesktopUpdateState(
        "1.0.0",
        { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
        "latest",
      );
      const layer = Layer.mergeAll(
        Layer.mock(ElectronPowerMonitor.ElectronPowerMonitor, {
          onSimpleEvent: (eventName, listener) =>
            Effect.sync(() => {
              if (eventName === "resume") resumeListeners.push(listener);
            }),
        }),
        Layer.mock(DesktopUpdates.DesktopUpdates, {
          getState: Effect.map(Ref.get(checkedAt), (at) => ({ ...state, checkedAt: at })),
          check: (reason) =>
            Effect.gen(function* () {
              yield* Ref.update(checks, (all) => [...all, reason]);
              yield* Ref.set(checkedAt, DateTime.formatIso(yield* DateTime.now));
              return { checked: true, state };
            }),
        }),
      );
      const wake = Effect.sync(() => resumeListeners.forEach((listener) => listener()));

      yield* listen.pipe(Effect.provide(layer));
      yield* wake;
      yield* TestClock.adjust("20 seconds");
      yield* wake;
      assert.deepStrictEqual(yield* Ref.get(checks), []);
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(yield* Ref.get(checks), ["wake"]);

      // A second wake soon after finds the recent check and skips.
      yield* TestClock.adjust("5 minutes");
      yield* wake;
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Ref.get(checks), ["wake"]);

      yield* TestClock.adjust("20 minutes");
      yield* wake;
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Ref.get(checks), ["wake", "wake"]);
    }),
  );
});
