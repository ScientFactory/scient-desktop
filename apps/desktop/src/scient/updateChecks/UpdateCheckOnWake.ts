import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";

// The network usually needs a moment after the computer wakes.
const WAKE_CHECK_DELAY = Duration.seconds(30);
// Waking twice in a short while checks once.
const WAKE_CHECK_MIN_SPACING = Duration.minutes(15);

function isRecent(lastMillis: number, nowMillis: number): boolean {
  const elapsed = nowMillis - lastMillis;
  return elapsed >= 0 && elapsed < Duration.toMillis(WAKE_CHECK_MIN_SPACING);
}

export function checkedRecently(checkedAt: string | null, nowMillis: number): boolean {
  const last = checkedAt === null ? Number.NaN : Date.parse(checkedAt);
  return !Number.isNaN(last) && isRecent(last, nowMillis);
}

/**
 * Checks for updates shortly after the computer wakes. Timers barely advance while it sleeps, so
 * the regular poll can be most of an interval away when someone opens their laptop. A wake before
 * the updater is configured checks nothing.
 */
export const listen: Effect.Effect<
  void,
  never,
  DesktopUpdates.DesktopUpdates | ElectronPowerMonitor.ElectronPowerMonitor | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const wakes = yield* Queue.sliding<void>(1);
  // A check that finds the release already offered leaves checkedAt as it was, so the last wake
  // check counts too.
  const lastWakeCheckAt = yield* Ref.make(Number.NEGATIVE_INFINITY);

  yield* powerMonitor.onSimpleEvent("resume", () => {
    Queue.offerUnsafe(wakes, undefined);
  });

  const checkAfterWake = Effect.gen(function* () {
    yield* Queue.take(wakes);
    yield* Effect.sleep(WAKE_CHECK_DELAY);
    // A wake during the delay is covered by this check.
    yield* Queue.clear(wakes);
    const state = yield* updates.getState;
    const now = yield* Clock.currentTimeMillis;
    if (checkedRecently(state.checkedAt, now)) return;
    if (isRecent(yield* Ref.get(lastWakeCheckAt), now)) return;
    yield* Ref.set(lastWakeCheckAt, now);
    yield* updates.check("wake");
  });

  yield* checkAfterWake.pipe(
    // An unexpected failure ends one check, not checking after later wakes.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("update check after wake failed", Cause.pretty(cause)),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(listen);
