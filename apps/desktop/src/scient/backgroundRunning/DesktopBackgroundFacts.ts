/**
 * DesktopBackgroundFacts - how Scient running with no window is used and where it fails, as
 * `app.background.summary` and `app.background.event` facts in the update-facts journal (same
 * analytics gate and delivery). Only closed values and coarse time buckets reach the journal.
 * @module DesktopBackgroundFacts
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { analyticsPlatform } from "../startupTiming/DesktopStartupTiming.ts";
import * as DesktopUpdateFacts from "../updateOutcomes/DesktopUpdateFacts.ts";

const SUMMARY_INTERVAL = "24 hours";

export type ReturnVia = "tray" | "dock" | "second-launch" | "other";
export type QuitPrompt = "none" | "confirmed" | "cancelled";
export type TrayFailure = "no-icon" | "error";

/** How the person asked for a window; a window opened any other way reports `other`. */
export const CurrentReturnVia = Context.Reference<ReturnVia>(
  "@t3tools/desktop/scient/backgroundRunning/CurrentReturnVia",
  { defaultValue: () => "other" },
);

/** Windowless time, from minutes after a window closes to days left running. */
export function windowlessBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return "under-1m";
  if (ms < 600_000) return "1-10m";
  if (ms < 3_600_000) return "10-60m";
  if (ms < 21_600_000) return "1-6h";
  if (ms < 86_400_000) return "6-24h";
  if (ms < 3 * 86_400_000) return "1-3d";
  if (ms < 7 * 86_400_000) return "3-7d";
  return "over-7d";
}

export class DesktopBackgroundFacts extends Context.Service<
  DesktopBackgroundFacts,
  {
    /** The last window closed and Scient keeps running with none. */
    readonly windowlessStarted: Effect.Effect<void>;
    /**
     * A window was asked for (`CurrentReturnVia` says how) or opened. `shown` and `not-shown` end
     * the windowless period, if there is one; `pending` means a window may still follow (the
     * backend is not ready yet), and the window that follows reports the way it was asked for.
     */
    readonly windowRequested: (outcome: "shown" | "not-shown" | "pending") => Effect.Effect<void>;
    /** The tray's Quit completely: the Quit that follows reports `via: tray`. */
    readonly trayQuitChosen: Effect.Effect<void>;
    /** What Quit's running-work check decided; a cancelled Quit leaves Scient windowless. */
    readonly quitDecided: (prompt: QuitPrompt) => Effect.Effect<void>;
    readonly trayFailed: (reason: TrayFailure) => Effect.Effect<void>;
    /** A cancelled Quit with no window showed the connecting splash. */
    readonly splashFallback: Effect.Effect<void>;
    /** The primary backend became ready again while windowless; no window opens by itself. */
    readonly backendRestarted: Effect.Effect<void>;
    readonly settingChanged: (input: {
      readonly enabled: boolean;
      readonly previous: boolean | null;
    }) => Effect.Effect<void>;
    /** A summary now and one a day while Scient runs; `choice` reads the stored setting. */
    readonly summaries: (
      choice: Effect.Effect<boolean | null>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/scient/backgroundRunning/DesktopBackgroundFacts") {}

export const make = Effect.fn("DesktopBackgroundFacts.make")(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly record: (
    name: "app.background.summary" | "app.background.event",
    properties: DesktopUpdateFacts.DesktopUpdateFactProperties,
  ) => Effect.Effect<void>;
}) {
  const platform = analyticsPlatform(input.platform);
  const windowlessSince = yield* Ref.make(Option.none<number>());
  // Since the last summary: windowless periods begun, and windowless time in periods that ended.
  const period = yield* Ref.make({ startedAt: yield* Clock.currentTimeMillis, count: 0, ms: 0 });
  const trayQuit = yield* Ref.make(false);
  const pendingVia = yield* Ref.make(Option.none<ReturnVia>());

  const event = (kind: string, properties: DesktopUpdateFacts.DesktopUpdateFactProperties = {}) =>
    input.record("app.background.event", { kind, platform, ...properties });

  /** Ends the windowless period; its length, or none when Scient was not windowless. */
  const endWindowless = Effect.gen(function* () {
    const since = yield* Ref.getAndSet(windowlessSince, Option.none());
    if (Option.isNone(since)) return Option.none<number>();
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(period, (current) => ({
      ...current,
      ms: current.ms + now - Math.max(since.value, current.startedAt),
    }));
    return Option.some(now - since.value);
  });

  const summary = Effect.fn("DesktopBackgroundFacts.summary")(function* (
    reason: "launch" | "daily",
    choice: boolean | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const since = yield* Ref.get(windowlessSince);
    const { startedAt, count, ms } = yield* Ref.getAndSet(period, {
      startedAt: now,
      count: 0,
      ms: 0,
    });
    // A period still under way adds its time within this summary's span.
    const ongoing = Option.match(since, {
      onNone: () => 0,
      onSome: (at) => now - Math.max(at, startedAt),
    });
    yield* input.record("app.background.summary", {
      reason,
      platform,
      enabled: DesktopAppSettings.keepsRunningInBackground(
        { keepRunningInBackground: choice },
        input.platform,
      ),
      setBy: choice === null ? "default" : "person",
      ...(reason === "daily"
        ? { windowlessCount: count, windowlessTimeBucket: windowlessBucket(ms + ongoing) }
        : {}),
    });
  });

  return DesktopBackgroundFacts.of({
    windowlessStarted: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const started = yield* Ref.modify(windowlessSince, (since) =>
        Option.isSome(since) ? [false, since] : [true, Option.some(now)],
      );
      if (!started) return;
      yield* Ref.set(pendingVia, Option.none());
      yield* Ref.update(period, (current) => ({ ...current, count: current.count + 1 }));
    }),
    windowRequested: Effect.fn("DesktopBackgroundFacts.windowRequested")(function* (outcome) {
      const current = yield* CurrentReturnVia;
      if (outcome === "pending") {
        if (Option.isSome(yield* Ref.get(windowlessSince))) {
          yield* Ref.set(pendingVia, Option.some(current));
        }
        return;
      }
      const via = Option.getOrElse(yield* Ref.getAndSet(pendingVia, Option.none()), () => current);
      const length = yield* endWindowless;
      if (Option.isNone(length)) return;
      yield* event(outcome === "shown" ? "window-returned" : "window-not-shown", {
        via,
        windowlessBucket: windowlessBucket(length.value),
      });
    }),
    trayQuitChosen: Ref.set(trayQuit, true),
    quitDecided: Effect.fn("DesktopBackgroundFacts.quitDecided")(function* (prompt) {
      const via = (yield* Ref.getAndSet(trayQuit, false)) ? "tray" : "other";
      const now = yield* Clock.currentTimeMillis;
      const length =
        prompt === "cancelled"
          ? Option.map(yield* Ref.get(windowlessSince), (since) => now - since)
          : yield* endWindowless;
      if (Option.isNone(length)) return;
      yield* event("quit", {
        via,
        quitPrompt: prompt,
        windowlessBucket: windowlessBucket(length.value),
      });
    }),
    trayFailed: Effect.fn("DesktopBackgroundFacts.trayFailed")(function* (reason) {
      yield* event("tray-failed", { reason });
    }),
    splashFallback: event("splash-fallback"),
    backendRestarted: event("backend-restarted"),
    settingChanged: Effect.fn("DesktopBackgroundFacts.settingChanged")(function* ({
      enabled,
      previous,
    }) {
      yield* event("setting-changed", {
        enabled,
        previousSetBy: previous === null ? "default" : "person",
      });
    }),
    summaries: Effect.fn("DesktopBackgroundFacts.summaries")(function* (choice) {
      yield* summary("launch", yield* choice);
      yield* Effect.sleep(SUMMARY_INTERVAL).pipe(
        Effect.andThen(choice),
        Effect.flatMap((current) => summary("daily", current)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  });
});

export const layer = Layer.effect(
  DesktopBackgroundFacts,
  Effect.gen(function* () {
    const facts = yield* DesktopUpdateFacts.DesktopUpdateFacts;
    return yield* make({
      platform: (yield* DesktopEnvironment.DesktopEnvironment).platform,
      record: facts.record,
    });
  }),
);
