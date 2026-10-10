import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { artworkRasterSize, makeLatexArtworkRaster } from "./latexArtworkRaster.ts";

describe("native artwork allocation guard", () => {
  it("uses page points and the requested pixel density", () => {
    expect(artworkRasterSize("Page    1 size: 72.5 x 36 pts\nPage    1 rot: 0\n", 2)).toEqual({
      widthPoints: 72.5,
      heightPoints: 36,
      width: 194,
      height: 96,
    });
    expect(artworkRasterSize("Page size: 72 x 36 pts\nPage rot: 90\n", 3)).toEqual({
      widthPoints: 36,
      heightPoints: 72,
      width: 144,
      height: 288,
    });
  });

  it.each([
    ["Page size: 100000 x 100000 pts\nPage rot: 0", 2],
    ["Page size: 0 x 36 pts\nPage rot: 0", 2],
    ["Page size: 72 x 36 pts\nPage rot: 45", 2],
    ["Page size: 72 x 36 pts", 2],
    ["Page size: 7.2.3 x 36 pts\nPage rot: 0", 2],
    ["Page size: 72 x 36 pts\nPage rot: 0", 4],
    ["Page size: 72 x 36 pts\nPage rot: 0", Number.NaN],
  ])("rejects unbounded or uncertain geometry before paint", (text, ratio) => {
    expect(artworkRasterSize(String(text), Number(ratio))).toBeNull();
  });
});

it.live(
  "bounds a successful process whose output stream never closes and releases its owner",
  () =>
    Effect.gen(function* () {
      let canceled = 0;
      const process = Layer.succeed(
        ExecutionProcess,
        ExecutionProcess.of({
          start: () =>
            Effect.succeed({
              exitCode: Effect.succeed(0),
              output: Stream.never,
              cancel: Effect.sync(() => {
                canceled++;
              }),
            }),
        }),
      );
      const renderer = makeLatexArtworkRaster.pipe(
        Effect.provide(
          Layer.mergeAll(
            process,
            Layer.succeed(SpawnExecutableResolution, () => "/synthetic/native-tool"),
            NodeServices.layer,
          ),
        ),
      );
      const result = yield* renderer.pipe(
        Effect.flatMap((render) =>
          render({
            pdfPath: "/synthetic/picture.pdf",
            pngPrefix: "/synthetic/pixels",
            cwd: "/synthetic",
            environment: {},
            ratio: 2,
          }),
        ),
        Effect.timeoutOption("4 seconds"),
      );
      expect(Option.isSome(result)).toBe(true);
      expect(Option.getOrThrow(result)).toBeNull();
      expect(canceled).toBe(1);
    }),
  10_000,
);
