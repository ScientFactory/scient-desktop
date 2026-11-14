// @effect-diagnostics nodeBuiltinImport:off -- observer tests use isolated host files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComputeRuntimeWriteReport } from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ComputeProjectOutputObserver,
  liveLayer,
  makeComputeProjectOutputObserver,
  type ComputeProjectOutputWatch,
} from "./ComputeProjectOutputObserver.ts";
import { makeProjectWriteWatches, type ProjectWatchBackend } from "./ComputeProjectWriteWatch.ts";

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

const observerLayer = (backend: () => Promise<ProjectWatchBackend>, platform?: NodeJS.Platform) =>
  Layer.effect(
    ComputeProjectOutputObserver,
    Effect.map(HostProcess.Platform, (hostPlatform) =>
      makeComputeProjectOutputObserver(
        makeProjectWriteWatches({ backend, platform: platform ?? hostPlatform }),
      ),
    ),
  );
const unavailableLayer = observerLayer(() => Promise.reject(new Error("no native watch")));

const write = (path: string, contents: string | Uint8Array = "<svg/>") =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents);
  });

function withProject<A, E, R>(
  run: (root: string, watch: ComputeProjectOutputWatch) => Effect.Effect<A, E, R>,
  existing: (root: string) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.acquireUseRelease(
    Effect.promise(async () =>
      NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-project-output-")),
      ),
    ),
    (root) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* existing(root);
          const observer = yield* ComputeProjectOutputObserver;
          const watch = yield* observer.watch(root);
          yield* watch.ready;
          return yield* run(root, watch);
        }),
      ),
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

/** A project as large and deep as the ones the old before/after scan gave up on. */
const largeProject = (root: string) =>
  Effect.promise(async () => {
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
  });

describe("ComputeProjectOutputObserver", () => {
  it.live("retains figures saved twelve folders deep and beside a large environment", () =>
    withProject(
      (root, watch) =>
        Effect.gen(function* () {
          const deep = NodePath.join(
            root,
            ...Array.from({ length: 12 }, () => "deeper"),
            "plot.svg",
          );
          const collection = yield* run(
            watch,
            Effect.all([
              write(deep),
              write(NodePath.join(root, "figures", "plot.png"), PIXEL),
            ]).pipe(Effect.asVoid),
          );
          expect(collection.images.map((image) => image.relativePath)).toEqual([
            `${Array.from({ length: 12 }, () => "deeper").join("/")}/plot.svg`,
            "figures/plot.png",
          ]);
          expect(collection.images[1]).toMatchObject({ mediaType: "image/png", width: 1 });
          expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
          expect(collection.warnings).toEqual([]);
        }),
      largeProject,
    ).pipe(Effect.provide(liveLayer)),
  );

  it.live("says a run in a large, deep project wrote nothing when it wrote nothing", () =>
    withProject(
      (_root, watch) =>
        Effect.gen(function* () {
          const collection = yield* run(watch, Effect.void);
          expect(collection.images).toEqual([]);
          expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
          expect(collection.warnings).toEqual([]);
        }),
      largeProject,
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
          { paths: [fresh], complete: true, spawnedProcess: false },
        );
        expect(second.images).toEqual([]);
      }),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend)));
  });

  it.live("checks every path a runtime reports instead of trusting it", () =>
    withProject((root, watch) =>
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
            complete: true,
            spawnedProcess: false,
          },
        );
        yield* Effect.promise(() => NodeFSP.rm(outside, { recursive: true, force: true }));
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          `${Array.from({ length: 10 }, () => "d").join("/")}/deep.svg`,
          "figures/nested.svg",
        ]);
        expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
      }),
    ).pipe(Effect.provide(unavailableLayer)),
  );

  it.live("adds what a started process wrote to what the runtime saw", () => {
    const scripted = scriptedBackend();
    return withProject((root, watch) =>
      run(
        watch,
        Effect.gen(function* () {
          yield* write(NodePath.join(root, "own.svg"));
          yield* write(NodePath.join(root, "child.svg"));
          scripted.emit(null, [NodePath.join(root, "child.svg")]);
        }),
        { paths: [NodePath.join(root, "own.svg")], complete: true, spawnedProcess: true },
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.images.map((image) => image.relativePath)).toEqual([
              "child.svg",
              "own.svg",
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
          scripted.emit(null, [NodePath.join(root, "made")]);
        }),
      ).pipe(
        Effect.tap((collection) =>
          Effect.sync(() => {
            expect(collection.images.map((image) => image.relativePath)).toEqual([
              "made/now/plot.svg",
            ]);
            expect(collection.capture).toEqual({ coverage: "complete", rejectedCount: 0 });
          }),
        ),
      ),
    ).pipe(Effect.provide(observerLayer(async () => scripted.backend, "linux")));
  });

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
      (root) => Effect.andThen(write(NodePath.join(root, "old.svg")), largeProject(root)),
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
          { paths, complete: true, spawnedProcess: false },
        );
        expect(collection.images).toHaveLength(32);
        expect(collection.capture).toMatchObject({
          coverage: "complete",
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
          { paths, complete: true, spawnedProcess: false },
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
