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
/** A requested window not shown by then counts as a failed attempt; the period stays open. */
export const RETURN_TIMEOUT = "2 minutes";

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

/**
 * A windowless period. `request` counts the requests for a window made during it; `settled` says
 * the latest one has already been counted as failed (or there is none), so it counts once.
 */
interface Episode {
  readonly id: number;
  readonly since: number;
  readonly via: Option.Option<ReturnVia>;
  readonly request: number;
  readonly settled: boolean;
}

/** The windowless period, its length and the tray choice when Quit was requested. */
export interface QuitSnapshot {
  readonly episode: Option.Option<Episode>;
  readonly length: number;
  readonly via: "tray" | "other";
}

export class DesktopBackgroundFacts extends Context.Service<
  DesktopBackgroundFacts,
  {
    /** The last window closed and Scient keeps running with none. */
    readonly windowlessStarted: Effect.Effect<void>;
    /**
     * The person asked for a window (`CurrentReturnVia` says how). If none shows within
     * `RETURN_TIMEOUT`, the attempt counts as `window-not-shown`.
     */
    readonly windowRequested: Effect.Effect<void>;
    /** An app window was shown: ends the windowless period as `window-returned`. */
    readonly windowShown: Effect.Effect<void>;
    /** A request for a window failed (no window, or its page failed to load); the period goes on. */
    readonly windowNotShown: Effect.Effect<void>;
    /** The tray's Quit completely: the Quit that follows reports `via: tray`. */
    readonly trayQuitChosen: Effect.Effect<void>;
    /** A Quit request ignored because one is under way: its tray choice must not carry over. */
    readonly quitIgnored: Effect.Effect<void>;
    readonly quitStarted: Effect.Effect<QuitSnapshot>;
    /**
     * What Quit's running-work check decided. A cancelled Quit leaves Scient windowless; a Quit
     * that goes on also sends the windowless time since the last summary.
     */
    readonly quitDecided: (snapshot: QuitSnapshot, prompt: QuitPrompt) => Effect.Effect<void>;
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
  const scope = yield* Effect.scope;
  const platform = analyticsPlatform(input.platform);
  const episodeRef = yield* Ref.make(Option.none<Episode>());
  let nextEpisode = 0;
  // Since the last summary: windowless periods begun, and windowless time in periods that ended.
  const period = yield* Ref.make({ startedAt: yield* Clock.currentTimeMillis, count: 0, ms: 0 });
  const trayQuit = yield* Ref.make(false);
  const choiceRef = yield* Ref.make<Effect.Effect<boolean | null>>(Effect.succeed(null));

  const event = (kind: string, properties: DesktopUpdateFacts.DesktopUpdateFactProperties = {}) =>
    input.record("app.background.event", { kind, platform, ...properties });

  /** Ends the period if it is still `id`, counting its time into the next summary. */
  const endEpisode = Effect.fn("DesktopBackgroundFacts.endEpisode")(function* (id: number) {
    const ended = yield* Ref.modify(episodeRef, (current) =>
      Option.isSome(current) && current.value.id === id
        ? [current, Option.none<Episode>()]
        : [Option.none<Episode>(), current],
    );
    if (Option.isNone(ended)) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(period, (current) => ({
      ...current,
      ms: current.ms + now - Math.max(ended.value.since, current.startedAt),
    }));
  });

  /** Counts the outstanding request as failed, once, when `matches` the period it belongs to. */
  const settle = Effect.fn("DesktopBackgroundFacts.settle")(function* (
    matches: (episode: Episode) => boolean,
  ) {
    const settled = yield* Ref.modify(episodeRef, (current) => {
      if (Option.isNone(current) || current.value.settled || !matches(current.value)) {
        return [Option.none<Episode>(), current];
      }
      const next = { ...current.value, settled: true };
      return [Option.some(next), Option.some(next)];
    });
    if (Option.isNone(settled)) return;
    yield* event("window-not-shown", {
      via: Option.getOrElse(settled.value.via, () => "other" as const),
      windowlessBucket: windowlessBucket((yield* Clock.currentTimeMillis) - settled.value.since),
    });
  });

  const summary = Effect.fn("DesktopBackgroundFacts.summary")(function* (
    reason: "launch" | "daily" | "quit",
  ) {
    const choice = yield* yield* Ref.get(choiceRef);
    const now = yield* Clock.currentTimeMillis;
    const episode = yield* Ref.get(episodeRef);
    const { startedAt, count, ms } = yield* Ref.getAndSet(period, {
      startedAt: now,
      count: 0,
      ms: 0,
    });
    // A period still under way adds its time within this summary's span.
    const ongoing = Option.match(episode, {
      onNone: () => 0,
      onSome: ({ since }) => now - Math.max(since, startedAt),
    });
    // At Quit, only an interval with windowless time is worth a fact.
    if (reason === "quit" && count === 0 && ms + ongoing === 0) return;
    yield* input.record("app.background.summary", {
      reason,
      platform,
      enabled: DesktopAppSettings.keepsRunningInBackground(
        { keepRunningInBackground: choice },
        input.platform,
      ),
      setBy: choice === null ? "default" : "person",
      ...(reason === "launch"
        ? {}
        : { windowlessCount: count, windowlessTimeBucket: windowlessBucket(ms + ongoing) }),
    });
  });

  return DesktopBackgroundFacts.of({
    windowlessStarted: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const id = nextEpisode;
      const started = yield* Ref.modify(episodeRef, (current) =>
        Option.isSome(current)
          ? [false, current]
          : [true, Option.some({ id, since: now, via: Option.none(), request: 0, settled: true })],
      );
      if (!started) return;
      nextEpisode += 1;
      yield* Ref.update(period, (current) => ({ ...current, count: current.count + 1 }));
    }),
    windowRequested: Effect.gen(function* () {
      const via = yield* CurrentReturnVia;
      const requested = yield* Ref.modify(episodeRef, (current) => {
        if (Option.isNone(current)) return [Option.none<Episode>(), current];
        const next = {
          ...current.value,
          via: Option.some(via),
          request: current.value.request + 1,
          settled: false,
        };
        return [Option.some(next), Option.some(next)];
      });
      if (Option.isNone(requested)) return;
      const { id, request } = requested.value;
      // Unless the request was settled or a later one made, it did not bring a window back.
      yield* Effect.sleep(RETURN_TIMEOUT).pipe(
        Effect.andThen(settle((current) => current.id === id && current.request === request)),
        Effect.forkIn(scope),
      );
    }).pipe(Effect.withSpan("DesktopBackgroundFacts.windowRequested")),
    windowShown: Effect.gen(function* () {
      const episode = yield* Ref.get(episodeRef);
      if (Option.isNone(episode)) return;
      yield* endEpisode(episode.value.id);
      yield* event("window-returned", {
        via: Option.getOrElse(episode.value.via, () => "other" as const),
        windowlessBucket: windowlessBucket((yield* Clock.currentTimeMillis) - episode.value.since),
      });
    }).pipe(Effect.withSpan("DesktopBackgroundFacts.windowShown")),
    windowNotShown: settle(() => true).pipe(
      Effect.withSpan("DesktopBackgroundFacts.windowNotShown"),
    ),
    trayQuitChosen: Ref.set(trayQuit, true),
    quitIgnored: Ref.set(trayQuit, false),
    quitStarted: Effect.gen(function* () {
      const via = (yield* Ref.getAndSet(trayQuit, false)) ? ("tray" as const) : ("other" as const);
      const episode = yield* Ref.get(episodeRef);
      const now = yield* Clock.currentTimeMillis;
      const length = Option.match(episode, { onNone: () => 0, onSome: (e) => now - e.since });
      return { episode, via, length };
    }),
    quitDecided: Effect.fn("DesktopBackgroundFacts.quitDecided")(function* (snapshot, prompt) {
      if (Option.isSome(snapshot.episode)) {
        if (prompt !== "cancelled") yield* endEpisode(snapshot.episode.value.id);
        yield* event("quit", {
          via: snapshot.via,
          quitPrompt: prompt,
          windowlessBucket: windowlessBucket(snapshot.length),
        });
      }
      if (prompt !== "cancelled") yield* summary("quit");
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
      yield* Ref.set(choiceRef, choice);
      yield* summary("launch");
      yield* Effect.sleep(SUMMARY_INTERVAL).pipe(
        Effect.andThen(summary("daily")),
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
