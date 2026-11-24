/**
 * For tests that drive a real native file watch. Platform file events can arrive late, or not
 * at all while the OS event service is saturated (macOS `fseventsd`), so every wait here has a
 * deadline on the live clock, and a failure says what was and was not observed.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

/** Far above normal event latency, far below the 120 s test ceiling. */
const DEADLINE_SECONDS = 10;

/** Where to look when native events do not arrive. */
const SLOW_EVENTS = "on macOS, a saturated fseventsd delays every native event";

/** Native events arrive in real time, whether or not the test runs on a TestClock. */
const onLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Clock.clockWith((clock) => ("withLive" in clock ? TestClock.withLive(effect) : effect));

/** Wait for `effect` up to the deadline on the live clock; then fail with "No `what` within 10 s". */
export const within =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOption(`${DEADLINE_SECONDS} seconds`),
      onLiveClock,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error(`No ${what} within ${DEADLINE_SECONDS} s.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

/**
 * Waiters keyed by file name as the native watch reports it. A test's `node:fs` `watch` mock
 * resolves them from its callback: `reports.get(String(filename))?.()`.
 */
export type NativeWatchReports = Map<string, () => void>;

/** Run `change`; whether the native watch then reports `name` in time. */
const reportedInTime = <E, R>(
  reports: NativeWatchReports,
  name: string,
  change: Effect.Effect<unknown, E, R>,
) => {
  const seen = Promise.withResolvers<void>();
  return Effect.acquireUseRelease(
    Effect.sync(() => reports.set(name, seen.resolve)),
    () =>
      change.pipe(
        Effect.andThen(Effect.promise(() => seen.promise)),
        Effect.timeoutOption(`${DEADLINE_SECONDS} seconds`),
        Effect.map(Option.isSome),
        onLiveClock,
      ),
    () => Effect.sync(() => reports.delete(name)),
  );
};

/** Run `change`, then wait until the native watch reports `name`. */
export const awaitNativeReport = <E, R>(
  reports: NativeWatchReports,
  name: string,
  change: Effect.Effect<unknown, E, R>,
) =>
  reportedInTime(reports, name, change).pipe(
    Effect.flatMap((reported) =>
      reported
        ? Effect.void
        : Effect.die(
            new Error(
              `The native watch did not report ${name} within ${DEADLINE_SECONDS} s (${SLOW_EVENTS}).`,
            ),
          ),
    ),
  );

let syncCount = 0;

const writeSyncFile = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    syncCount += 1;
    const name = `.scient-test-watch-sync-${String(syncCount)}`;
    return { name, write: fileSystem.writeFileString(path.join(directory, name), "") };
  });

/**
 * Wait until the native watch is armed and has reported every earlier change. Node starts a
 * macOS watch after `watch` returns, so a change made at once can be missed, and FSEvents can
 * deliver a write made just before the watch started late; changes arrive in order, though.
 * So this writes a fresh sync file each second until one is reported.
 */
export const syncNativeWatch = Effect.fn("syncNativeWatch")(function* (
  reports: NativeWatchReports,
  directory: string,
) {
  const seen = Promise.withResolvers<void>();
  const names: string[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => names.forEach((name) => reports.delete(name))),
  );
  for (let attempt = 0; attempt < DEADLINE_SECONDS; attempt += 1) {
    const sync = yield* writeSyncFile(directory);
    names.push(sync.name);
    reports.set(sync.name, seen.resolve);
    yield* sync.write;
    const reported = yield* Effect.promise(() => seen.promise).pipe(
      Effect.timeoutOption("1 second"),
      onLiveClock,
    );
    if (Option.isSome(reported)) return;
  }
  return yield* Effect.die(
    new Error(
      `The native watch reported none of ${String(DEADLINE_SECONDS)} sync files written to ${directory} over ${DEADLINE_SECONDS} s (${SLOW_EVENTS}).`,
    ),
  );
}, Effect.scoped);

/** Start a native watch that calls `onReport` with each reported file name; resolve to its stop. */
export type StartNativeWatch = (
  directory: string,
  onReport: (name: string) => void,
) => Promise<() => Promise<void>>;

/** How long a fresh watch from `start` on `directory` takes to report a new file, if it does in time. */
export const platformFileEventLatency = Effect.fn("platformFileEventLatency")(function* (
  directory: string,
  start: StartNativeWatch,
) {
  const reports: NativeWatchReports = new Map();
  yield* Effect.acquireRelease(
    Effect.promise(() => start(directory, (name) => reports.get(name)?.())).pipe(
      within(`subscription to ${directory}`),
    ),
    (stop) => Effect.promise(stop).pipe(within(`unsubscribe from ${directory}`)),
  );
  const sync = yield* writeSyncFile(directory);
  const [latency, reported] = yield* reportedInTime(reports, sync.name, sync.write).pipe(
    Effect.timed,
    onLiveClock,
  );
  return reported ? Option.some(latency) : Option.none();
}, Effect.scoped);

/**
 * Await a hint for a change that the native watch reports as `reported`. Late, the failure says
 * whether the native watch reported it and, if not, whether it reported a file written after.
 */
export const awaitWatchHint = <A, E, R>(
  input: {
    readonly hint: string;
    readonly reported: string;
    readonly reports: NativeWatchReports;
    readonly directory: string;
  },
  hint: Effect.Effect<A, E, R>,
) => {
  // The hint's own sync takes up to one deadline, the change up to another.
  const late = `${input.hint} did not arrive within ${2 * DEADLINE_SECONDS} s`;
  let reported = false;
  const missed = Effect.suspend(() =>
    reported
      ? Effect.die(new Error(`${late}; the native watch reported ${input.reported}.`))
      : writeSyncFile(input.directory).pipe(
          Effect.flatMap((sync) => reportedInTime(input.reports, sync.name, sync.write)),
          Effect.flatMap((later) =>
            Effect.die(
              new Error(
                `${late}; the native watch did not report ${input.reported}, and ${later ? "did" : "did not"} report a sync file written after that.`,
              ),
            ),
          ),
        ),
  );
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      input.reports.set(input.reported, () => {
        reported = true;
      }),
    ),
    () =>
      // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- the fallback must run while the watch is still open, and timeoutOrElse closes it first.
      Effect.raceFirst(
        hint,
        Effect.sleep(`${2 * DEADLINE_SECONDS} seconds`).pipe(Effect.andThen(missed)),
      ),
    () => Effect.sync(() => input.reports.delete(input.reported)),
  ).pipe(onLiveClock);
};
