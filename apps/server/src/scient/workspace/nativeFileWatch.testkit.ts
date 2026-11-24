/**
 * For tests that drive a real native file watch. Platform file events can arrive late, or not
 * at all while the OS event service is saturated (macOS `fseventsd`), so every wait here has a
 * deadline on the live clock and a failure that says which side stalled.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

/** Far above normal event latency, far below the 120 s test ceiling. */
const NATIVE_EVENT_DEADLINE_SECONDS = 10;

export const PLATFORM_STALLED =
  "the platform's file events are stalled (on macOS, check fseventsd's CPU). That is the machine, not a wrong result";

/** Native events arrive in real time, whether or not the test runs on a TestClock. */
const onLiveClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Clock.clockWith((clock) => ("withLive" in clock ? TestClock.withLive(effect) : effect));

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
        Effect.timeoutOption(`${NATIVE_EVENT_DEADLINE_SECONDS} seconds`),
        Effect.map(Option.isSome),
        onLiveClock,
      ),
    () => Effect.sync(() => reports.delete(name)),
  );
};

/**
 * Run `change`, then wait until the native watch reports `name`. No report in time means the
 * platform's events stalled, so the failure says so instead of waiting out the test timeout.
 */
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
              `The native watch did not report ${name} within ${NATIVE_EVENT_DEADLINE_SECONDS} s: ${PLATFORM_STALLED}.`,
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
  for (let attempt = 0; attempt < NATIVE_EVENT_DEADLINE_SECONDS; attempt += 1) {
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
      `The native watch did not report any of ${String(NATIVE_EVENT_DEADLINE_SECONDS)} sync files in ${directory} within ${NATIVE_EVENT_DEADLINE_SECONDS} s: ${PLATFORM_STALLED}.`,
    ),
  );
}, Effect.scoped);

/** Start a native watch that calls `onReport` with each reported file name; resolve to its stop. */
export type StartNativeWatch = (
  directory: string,
  onReport: (name: string) => void,
) => Promise<() => Promise<void>>;

/**
 * How long `start`'s watch on `directory` takes to report a fresh file, if it does within the
 * deadline: tells a broken product watch apart from a platform whose file events are slow.
 */
export const platformFileEventLatency = Effect.fn("platformFileEventLatency")(function* (
  directory: string,
  start: StartNativeWatch,
) {
  const reports: NativeWatchReports = new Map();
  yield* Effect.acquireRelease(
    Effect.promise(() => start(directory, (name) => reports.get(name)?.())),
    (stop) => Effect.promise(stop),
  );
  const sync = yield* writeSyncFile(directory);
  const [latency, reported] = yield* reportedInTime(reports, sync.name, sync.write).pipe(
    Effect.timed,
    onLiveClock,
  );
  return reported ? Option.some(latency) : Option.none();
}, Effect.scoped);

/**
 * Await a hint for a change, made after `syncNativeWatch`, that the native watch reports as
 * `reported`. Late, the failure says where it was lost: the product (the change was reported),
 * the platform (only a later sync file was), or a stalled platform (nothing was).
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
  let reported = false;
  const lost = Effect.suspend(() =>
    reported
      ? Effect.die(
          new Error(
            `${input.hint} did not arrive within ${2 * NATIVE_EVENT_DEADLINE_SECONDS} s although the native watch reported ${input.reported}, so the product dropped it.`,
          ),
        )
      : syncNativeWatch(input.reports, input.directory).pipe(
          Effect.andThen(
            Effect.die(
              new Error(
                `The native watch never reported ${input.reported}, though it was armed before the change and reported a file written after it: the platform lost the change. That is the machine, not a wrong result.`,
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
        // The hint's own sync takes up to one deadline, the change up to another.
        Effect.sleep(`${2 * NATIVE_EVENT_DEADLINE_SECONDS} seconds`).pipe(Effect.andThen(lost)),
      ),
    () => Effect.sync(() => input.reports.delete(input.reported)),
  ).pipe(onLiveClock);
};
