// @effect-diagnostics nodeBuiltinImport:off -- observer tests use isolated host files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";

import {
  ComputeProjectOutputObserver,
  liveLayer,
  type ComputeProjectOutputObservation,
} from "./ComputeProjectOutputObserver.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3V8AAAAASUVORK5CYII=",
  "base64",
);

const begin = (root: string) =>
  ComputeProjectOutputObserver.pipe(Effect.flatMap((observer) => observer.begin(root)));
const collect = (observation: ComputeProjectOutputObservation, maximumBytes = 8 * 1024 * 1024) =>
  ComputeProjectOutputObserver.pipe(
    Effect.flatMap((observer) => observer.collect(observation, { maximumBytes })),
  );

function withProject<A, E, R>(
  run: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-project-output-"))),
    run,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
}

describe("ComputeProjectOutputObserver", () => {
  it.effect("bounds observation with the injected clock and reports the coverage gap", () =>
    withProject((root) =>
      Effect.gen(function* () {
        const observation = yield* begin(root);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "figure.svg"), "<svg/>"));
        const clock = yield* Clock.Clock;
        let now = 0;
        const collection = yield* collect(observation).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => {
              now += 2_000;
              return now;
            },
          }),
        );
        expect(collection.images).toEqual([]);
        expect(collection.warnings).toEqual([
          "Some project files could not be checked (time limit).",
        ]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("collects new and changed SVG/PNG files with project provenance", () =>
    withProject((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "unchanged.svg"), "<svg/>"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "changed.svg"), "<svg/>"),
        );
        const observation = yield* begin(root);

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "changed.svg"), "<svg><circle/></svg>"),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "results")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "results", "pixel.png"), PIXEL),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "notes.txt"), "not a figure"),
        );

        const collection = yield* collect(observation);
        expect(collection.warnings).toEqual([]);
        expect(collection.images).toHaveLength(2);
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          "changed.svg",
          "results/pixel.png",
        ]);
        expect(collection.images[0]).toMatchObject({
          mediaType: "image/svg+xml",
          width: null,
          height: null,
        });
        expect(collection.images[1]).toMatchObject({
          mediaType: "image/png",
          width: 1,
          height: 1,
        });
        expect(collection.images.every((image) => image.contentHash.startsWith("sha256:"))).toBe(
          true,
        );
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("does not follow links or inspect hidden dependency directories", () =>
    withProject((root) =>
      Effect.gen(function* () {
        const observation = yield* begin(root);
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, ".cache")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, ".cache", "hidden.svg"), "<svg/>"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "visible.svg"), "<svg/>"),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "figures")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "figures", "nested.svg"), "<svg/>"),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(root, "visible.svg"), NodePath.join(root, "linked.svg")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(root, "figures"), NodePath.join(root, "linked-figures")),
        );

        const collection = yield* collect(observation);
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          "figures/nested.svg",
          "visible.svg",
        ]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("bounds the number of retained figures per execution", () =>
    withProject((root) =>
      Effect.gen(function* () {
        const observation = yield* begin(root);
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 34 }, (_, index) =>
              NodeFSP.writeFile(
                NodePath.join(root, `figure-${String(index).padStart(3, "0")}.svg`),
                "<svg/>",
              ),
            ),
          ),
        );

        const collection = yield* collect(observation);
        expect(collection.images).toHaveLength(32);
        expect(collection.warnings.some((warning) => warning.includes("first 32"))).toBe(true);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("does not read figures beyond the coordinator's remaining output budget", () =>
    withProject((root) =>
      Effect.gen(function* () {
        const observation = yield* begin(root);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "a.svg"), "<svg/>"));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "b.svg"), "<svg/>"));

        const collection = yield* collect(observation, 6);
        expect(collection.images.map((image) => image.relativePath)).toEqual(["a.svg"]);
        expect(collection.warnings.some((warning) => warning.includes("output limit"))).toBe(true);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("fails closed when the project inventory cannot be observed completely", () =>
    withProject((root) =>
      Effect.gen(function* () {
        for (let start = 0; start < 4_097; start += 128) {
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: Math.min(128, 4_097 - start) }, (_, offset) =>
                NodeFSP.writeFile(
                  NodePath.join(root, `entry-${String(start + offset).padStart(4, "0")}.txt`),
                  "",
                ),
              ),
            ),
          );
        }
        const observation = yield* begin(root);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "figure.svg"), "<svg/>"));

        const collection = yield* collect(observation);
        expect(collection.images).toEqual([]);
        expect(collection.warnings).toEqual([
          "Some project files could not be checked (entry limit).",
        ]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("retains verified root changes even when an unrelated subtree exceeds the budget", () =>
    withProject((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "large")));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "known.svg"), "<svg/>"));
        for (let start = 0; start < 4100; start += 128) {
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: Math.min(128, 4100 - start) }, (_, offset) =>
                NodeFSP.writeFile(NodePath.join(root, "large", `${start + offset}.txt`), ""),
              ),
            ),
          );
        }
        const observation = yield* begin(root);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "known.svg"), "<svg><circle/></svg>"),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "new.svg"), "<svg/>"));
        const collection = yield* collect(observation);
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          "known.svg",
          "new.svg",
        ]);
        expect(collection.warnings).toEqual([
          "Some project files could not be checked (entry limit).",
        ]);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("does not mistake an unobserved pre-existing image for a new output", () =>
    withProject((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "unobserved")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "unobserved", "old.svg"), "<svg/>"),
        );
        const observation = yield* begin(root);
        const baseline = observation.baseline!;
        const partial = {
          ...observation,
          baseline: {
            ...baseline,
            files: new Map(),
            directories: new Map([["", baseline.directories.get("")!]]),
            warnings: ["Some project files could not be checked (entry limit)."],
          },
        };
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(root, "new", "nested"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "new", "nested", "new.svg"), "<svg/>"),
        );
        const collection = yield* collect(partial);
        expect(collection.images.map((image) => image.relativePath)).toEqual([
          "new/nested/new.svg",
        ]);
        expect(collection.warnings).toHaveLength(1);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );

  it.effect("reports depth gaps without claiming any figures were generated or lost", () =>
    withProject((root) =>
      Effect.gen(function* () {
        const deep = NodePath.join(root, ...Array.from({ length: 9 }, () => "nested"));
        yield* Effect.promise(() => NodeFSP.mkdir(deep, { recursive: true }));
        const observation = yield* begin(root);
        const unchanged = yield* collect(observation);
        expect(unchanged.images).toEqual([]);
        expect(unchanged.warnings).toEqual([
          "Some project files could not be checked (depth limit).",
        ]);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(deep, "unseen.svg"), "<svg/>"));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "seen.svg"), "<svg/>"));
        const collection = yield* collect(observation);
        expect(collection.images.map((image) => image.relativePath)).toEqual(["seen.svg"]);
        expect(collection.warnings).toEqual(unchanged.warnings);
      }),
    ).pipe(Effect.provide(liveLayer)),
  );
});
