// @effect-diagnostics nodeBuiltinImport:off -- observer tests use isolated host files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ComputeRuntimeWriteReport } from "@scientfactory/compute";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ComputeProjectOutputObserver,
  liveLayer,
  makeComputeProjectOutputObserver,
  type ComputeProjectOutputWatch,
} from "./ComputeProjectOutputObserver.ts";
import { makeProjectWriteWatches, type ProjectWatchBackend } from "./ComputeProjectWriteWatch.ts";
import {
  PLATFORM_STALLED,
  platformFileEventLatency,
  type StartNativeWatch,
} from "../workspace/nativeFileWatch.testkit.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3V8AAAAASUVORK5CYII=",
  "base64",
);

type Callback = Parameters<ProjectWatchBackend["subscribe"]>[1];

/** Reports only what a test emits, plus the sync files the watch writes to flush itself. */
function scriptedBackend() {
  let callback: Callback | null = null;
  const backend: ProjectWatchBackend = {
    subscribe: async (directory, onEvents) => {
      callback = onEvents;
      // @effect-diagnostics-next-line globalTimers:off -- stands in for a native watch thread.
      const timer = setInterval(() => {
        void NodeFSP.readdir(directory).then((names) => {
          for (const name of names)
            if (name.startsWith(".scient-compute-sync-"))
              onEvents(null, [{ path: NodePath.join(directory, name), type: "create" }]);
        });
      }, 5);
      return { unsubscribe: async () => clearInterval(timer) };
    },
  };
  return {
    backend,
    emit: (error: Error | null, paths: ReadonlyArray<string> = [], type = "create") =>
      callback?.(
        error,
        paths.map((path) => ({ path, type })),
      ),
  };
}

/** A scripted backend stands in for one that reports lost events, unless told it is inotify. */
const observerLayer = (
  backend: () => Promise<ProjectWatchBackend>,
  platform: NodeJS.Platform = "darwin",
) =>
  Layer.succeed(
    ComputeProjectOutputObserver,
    makeComputeProjectOutputObserver(makeProjectWriteWatches({ backend, platform })),
  );
const unavailableLayer = observerLayer(() => Promise.reject(new Error("no native watch")));

// The real watch cannot rule out lost events on Linux.
const watchedCoverage =
  HostProcess.Platform.defaultValue() === "linux"
    ? ({ coverage: "partial", coverageReason: "watch-unverifiable", rejectedCount: 0 } as const)
    : ({ coverage: "complete", rejectedCount: 0 } as const);

const write = (path: string, contents: string | Uint8Array = "<svg/>") =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents);
  });

const makeRoot = async () =>
  NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-project-output-")));

const withWatch = <A, E, R>(
  root: string,
  run: (root: string, watch: ComputeProjectOutputWatch) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const observer = yield* ComputeProjectOutputObserver;
      const watch = yield* observer.watch(root);
      yield* watch.ready;
      return yield* run(root, watch);
    }),
  );

function withProject<A, E, R>(
  run: (root: string, watch: ComputeProjectOutputWatch) => Effect.Effect<A, E, R>,
  existing: (root: string) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.acquireUseRelease(
    Effect.promise(makeRoot),
    (root) => Effect.andThen(existing(root), withWatch(root, run)),
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
}

const run = (
  watch: ComputeProjectOutputWatch,
  body: Effect.Effect<void>,
  writes?: ComputeRuntimeWriteReport,
  maximumBytes = 8 * 1024 * 1024,
) =>
  Effect.gen(function* () {
    const observation = yield* watch.begin;
    yield* body;
    return yield* watch.collect(observation, { maximumBytes }, writes);
  });

/**
 * FSEvents reports system-wide loss when any process churns files, and such a run is rightly
 * partial; a real-watch test asserts on the first run that the OS reported no loss for.
 */
const runWithoutReportedLoss = (watch: ComputeProjectOutputWatch, body: Effect.Effect<void>) =>
  Effect.gen(function* () {
    for (let attempt = 1; ; attempt += 1) {
      const collection = yield* run(watch, body);
      if (collection.capture?.coverageReason !== "watch-overflow" || attempt === 3)
        return collection;
    }
  });

/** How long ComputeProjectWriteWatch waits for each of its sync files. */
const WATCH_SYNC_WAIT = Duration.seconds(1);

/** The project watch's own backend, which can lag behind other native watches. */
const startProjectWatchBackend: StartNativeWatch = async (directory, onReport) => {
  const backend = await import("@parcel/watcher");
  const subscription = await backend.subscribe(directory, (_error, events) => {
    for (const event of events) onReport(NodePath.basename(event.path));
  });
  return () => subscription.unsubscribe();
};

/**
 * The real watch is unavailable when its sync files do not come back in time, as when macOS's
 * fseventsd is saturated. The observer then rightly falls back to a scan, so this says whether
 * the machine or the watch is at fault instead of failing on the coverage it reports.
 */
const expectRealWatchAvailable = (root: string, coverageReason: string | undefined) =>
  coverageReason !== "watch-unavailable"
    ? Effect.void
    : platformFileEventLatency(root, startProjectWatchBackend).pipe(
        Effect.provide(NodeServices.layer),
        Effect.map(
          Option.match({
            onNone: () =>
              expect.fail(`The platform file watch was unavailable: ${PLATFORM_STALLED}.`),
            onSome: (latency) =>
              expect.fail(
                // Latency varies from one sync file to the next, so only a clear margin convicts.
                Duration.isGreaterThan(latency, Duration.divideUnsafe(WATCH_SYNC_WAIT, 2))
                  ? `The platform file watch was unavailable: it took ${Duration.format(latency)} to report a new file, too close to the ${Duration.format(WATCH_SYNC_WAIT)} the project watch waits for one. That is the machine (on macOS, check fseventsd's CPU), not a wrong result.`
                  : `The project watch was unavailable although its native watch reported a new file in ${Duration.format(latency)}, well within the ${Duration.format(WATCH_SYNC_WAIT)} it waits, so the project watch is broken.`,
              ),
          }),
        ),
      );

/** A project as large and deep as the ones the old before/after scan gave up on. */
async function fillLargeProject(root: string) {
  const environment = NodePath.join(root, "venv", "lib", "site-packages");
  await NodeFSP.mkdir(environment, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "venv", "pyvenv.cfg"), "home = /usr/bin\n");
  for (let start = 0; start < 5_000; start += 250)
    await Promise.all(
      Array.from({ length: 250 }, (_, offset) =>
        NodeFSP.writeFile(NodePath.join(environment, `module-${start + offset}.py`), ""),
      ),
    );
  await NodeFSP.mkdir(NodePath.join(root, ...Array.from({ length: 12 }, () => "nested")), {
    recursive: true,
  });
}

// Made once, ahead of the real-watch runs: creating or deleting thousands of files can make
// FSEvents report system-wide event loss, which those runs would then rightly call partial.
const largeProjects: string[] = [];
beforeAll(async () => {
  for (const _ of [0, 1]) {
    const root = await makeRoot();
    await fillLargeProject(root);
    largeProjects.push(root);
  }
});
afterAll(async () => {
  for (const root of largeProjects) await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("ComputeProjectOutputObserver", () => {
  it.live("retains figures saved twelve folders deep and beside a large environment", () =>
    withWatch(largeProjects[0]!, (root, watch) =>
      Effect.gen(function* () {
        const deep = NodePath.join(root, ...Array.from({ length: 12 }, () => "deeper"), "plot.svg");
        const collection = yield* runWithoutReportedLoss(
          watch,
          Effect.all([write(deep), write(NodePath.join(root, "figures", "plot.png"), PIXEL)]).pipe(
            Effect.asVoid,
          ),
        );
        yield* expectRealWatchAvailable(root, collection.capture?.coverageReason);
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          `${Array.from({ length: 12 }, () => "deeper").join("/")}/plot.svg`,
          "figures/plot.png",
        ]);
        expect(collection.images[1]).toMatchObject({ mediaType: "image/png", width: 1 });
        expect(collection.capture).toEqual(watchedCoverage);
        expect(collection.warnings).toEqual([]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.live("says a run in a large, deep project wrote nothing when it wrote nothing", () =>
    withWatch(largeProjects[1]!, (root, watch) =>
      Effect.gen(function* () {
        const collection = yield* runWithoutReportedLoss(watch, Effect.void);
        yield* expectRealWatchAvailable(root, collection.capture?.coverageReason);
        expect(collection.images).toEqual([]);
        expect(collection.capture).toEqual(watchedCoverage);
        expect(collection.warnings).toEqual([]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.live("ignores late news of a file changed before the run, and one already shown", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const startedAt = clock.currentTimeMillisUnsafe() + 1_000;
        const begin = watch.begin.pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => startedAt,
          }),
        );
        yield* write(NodePath.join(root, "old.svg"));
        const observation = yield* begin;
        const fresh = NodePath.join(root, "new.svg");
        yield* write(fresh);
        yield* Effect.promise(() =>
          NodeFSP.utimes(fresh, (startedAt + 1_000) / 1_000, (startedAt + 1_000) / 1_000),
        );
        // The watch delivers in batches, so old.svg's change can arrive after the run began.
        scripted.emit(null, [NodePath.join(root, "old.svg"), fresh]);
        const first = yield* watch.collect(observation, { maximumBytes: 1024 * 1024 });
        expect(first.images.map((image) => image.relativePath)).toEqual(["new.svg"]);
        const second = yield* watch.collect(
          yield* begin,
          { maximumBytes: 1024 * 1024 },
          { paths: [fresh] },
        );
        expect(second.images).toEqual([]);
      }),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend)));
  });

  it.live("checks every path a runtime reports instead of trusting it", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-outside-")),
        );
        const deep = NodePath.join(root, ...Array.from({ length: 10 }, () => "d"), "deep.svg");
        const collection = yield* run(
          watch,
          Effect.all([
            write(deep),
            write(NodePath.join(outside, "elsewhere.svg")),
            write(NodePath.join(root, ".cache", "hidden.svg")),
            write(NodePath.join(root, "figures", "nested.svg")),
            write(NodePath.join(root, "notes.txt"), "not a figure"),
            Effect.promise(() =>
              NodeFSP.symlink(
                NodePath.join(outside, "elsewhere.svg"),
                NodePath.join(root, "linked.svg"),
              ),
            ),
          ]).pipe(Effect.asVoid),
          {
            paths: [
              deep,
              NodePath.join(outside, "elsewhere.svg"),
              NodePath.join(root, ".cache", "hidden.svg"),
              NodePath.join(root, "linked.svg"),
              NodePath.join(root, "figures", "nested.svg"),
              NodePath.join(root, "notes.txt"),
              NodePath.join(root, "never-written.svg"),
              "relative.svg",
            ],
          },
        );
        yield* Effect.promise(() => NodeFSP.rm(outside, { recursive: true, force: true }));
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          `${Array.from({ length: 10 }, () => "d").join("/")}/deep.svg`,
          "figures/nested.svg",
        ]);
        expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
      }),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend)));
  });

  it.live("still reads the watch when the runtime reported what it wrote", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      run(
        watch,
        Effect.gen(function* () {
          yield* write(NodePath.join(root, "own.svg"));
          // Writes through a handle opened in an earlier cell, or by a child process.
          yield* write(NodePath.join(root, "unseen.svg"));
          scripted.emit(null, [NodePath.join(root, "unseen.svg")]);
        }),
        { paths: [NodePath.join(root, "own.svg")] },
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.images.map((image) => image.relativePath)).toEqual([
              "own.svg",
              "unseen.svg",
            ]);
            expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
          }),
        ),
      ),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend)));
  });

  it.live("finds files in a folder inotify saw created but never reported into", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      run(
        watch,
        Effect.gen(function* () {
          yield* write(NodePath.join(root, "made", "now", "plot.svg"));
          yield* write(NodePath.join(root, "plots.svg", "figure.svg"));
          scripted.emit(null, [NodePath.join(root, "made"), NodePath.join(root, "plots.svg")]);
        }),
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.images.map((image) => image.relativePath)).toEqual([
              "made/now/plot.svg",
              "plots.svg/figure.svg",
            ]);
            expect(collection.capture).toEqual({
              coverage: "partial",
              coverageReason: "watch-unverifiable",
              rejectedCount: 0,
            });
          }),
        ),
      ),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend, "linux")));
  });

  it.live("reports partial coverage when a created folder is too large to search", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      run(
        watch,
        Effect.gen(function* () {
          const batch = NodePath.join(root, "batch");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(batch);
            await Promise.all(
              Array.from({ length: 1_025 }, (_, index) =>
                NodeFSP.mkdir(NodePath.join(batch, `run-${String(index)}`)),
              ),
            );
          });
          yield* write(NodePath.join(batch, "run-7", "plot.svg"));
          scripted.emit(null, [batch]);
        }),
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.capture).toMatchObject({
              coverage: "partial",
              coverageReason: "scan-entry-limit",
            });
            expect(collection.warnings).toContain(
              "Some project files could not be checked (entry limit).",
            );
          }),
        ),
      ),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend, "linux")));
  });

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "reports partial coverage when a created folder cannot be read",
    () => {
      const scripted = scriptedBackend();
      const locked = (root: string) => NodePath.join(root, "locked");
      return withProject((root, watch) =>
        run(
          watch,
          Effect.gen(function* () {
            yield* write(NodePath.join(locked(root), "plot.svg"));
            yield* Effect.promise(() => NodeFSP.chmod(locked(root), 0o000));
            scripted.emit(null, [locked(root)]);
          }),
        ).pipe(
          Effect.tap((collection) =>
            Effect.sync(() => {
              expect(collection.capture).toMatchObject({
                coverage: "partial",
                coverageReason: "scan-unreadable",
              });
            }),
          ),
          Effect.ensuring(Effect.promise(() => NodeFSP.chmod(locked(root), 0o700))),
        ),
      ).pipe(Effect.provide(observerLayer(async () => scripted.backend, "linux")));
    },
  );

  it.live("falls back to a scan and reports partial coverage when the watch lost events", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      run(
        watch,
        Effect.gen(function* () {
          yield* write(NodePath.join(root, "results", "lost.svg"));
          scripted.emit(new Error("Events were dropped by the kernel."));
        }),
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.images.map((image) => image.relativePath)).toEqual([
              "results/lost.svg",
            ]);
            expect(collection.capture).toEqual({
              coverage: "partial",
              coverageReason: "watch-overflow",
              rejectedCount: 0,
            });
          }),
        ),
      ),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend)));
  });

  it.live("scans for files changed since the run began when no watch is available", () =>
    withProject(
      (root, watch) =>
        Effect.gen(function* () {
          // The run starts later than the old file's times; the new file is written after it.
          const clock = yield* Clock.Clock;
          const startedAt = clock.currentTimeMillisUnsafe() + 5_000;
          const observation = yield* watch.begin.pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              currentTimeMillisUnsafe: () => startedAt,
            }),
          );
          const fresh = NodePath.join(root, "nested", "nested", "fresh.svg");
          yield* write(fresh);
          yield* Effect.promise(() =>
            NodeFSP.utimes(fresh, (startedAt + 1_000) / 1_000, (startedAt + 1_000) / 1_000),
          );
          const collection = yield* watch.collect(observation, { maximumBytes: 1024 * 1024 });
          expect(collection.images.map((image) => image.relativePath)).toEqual([
            "nested/nested/fresh.svg",
          ]);
          expect(collection.capture).toEqual({
            coverage: "partial",
            coverageReason: "watch-unavailable",
            rejectedCount: 0,
          });
        }),
      (root) =>
        Effect.andThen(
          write(NodePath.join(root, "old.svg")),
          Effect.promise(() => fillLargeProject(root)),
        ),
    ).pipe(Effect.provide(unavailableLayer)),
  );

  it.live("bounds the number of retained figures per execution", () =>
    withProject((root, watch) =>
      Effect.gen(function* () {
        const paths = Array.from({ length: 34 }, (_, index) =>
          NodePath.join(root, `figure-${String(index).padStart(3, "0")}.svg`),
        );
        const collection = yield* run(
          watch,
          Effect.forEach(paths, (path) => write(path), { discard: true }),
          { paths },
        );
        expect(collection.images).toHaveLength(32);
        expect(collection.capture).toMatchObject({
          rejectedCount: 2,
          rejectionReason: "image-limit",
        });
        expect(collection.warnings.some((warning) => warning.includes("first 32"))).toBe(true);
      }),
    ).pipe(Effect.provide(unavailableLayer)),
  );

  it.live("does not read figures beyond the coordinator's remaining output budget", () =>
    withProject((root, watch) =>
      Effect.gen(function* () {
        const paths = [NodePath.join(root, "a.svg"), NodePath.join(root, "b.svg")];
        const collection = yield* run(
          watch,
          Effect.forEach(paths, (path) => write(path), { discard: true }),
          { paths },
          6,
        );
        expect(collection.images.map((image) => image.relativePath)).toEqual(["a.svg"]);
        expect(collection.capture).toMatchObject({
          rejectedCount: 1,
          rejectionReason: "output-limit",
        });
        expect(collection.warnings.some((warning) => warning.includes("output limit"))).toBe(true);
      }),
    ).pipe(Effect.provide(unavailableLayer)),
  );
});
