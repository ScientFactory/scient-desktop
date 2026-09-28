// @effect-diagnostics nodeBuiltinImport:off -- Checks the output and scratch directories on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { PandocManagedTool } from "./PandocManagedTool.ts";
import type { PandocCommand } from "./pandocProcess.ts";
import {
  MAX_WORD_SOURCE_BYTES,
  PandocWordConverter,
  SCIENT_PANDOC_READER,
  layer,
} from "./PandocWordConverter.ts";
import { fakePandoc, makeBundle, managedToolLayer } from "./pandocTestSupport.ts";

const run = <A, E>(
  toolLayer: (scratchRoot: string) => Layer.Layer<PandocManagedTool>,
  body: (input: {
    readonly converter: PandocWordConverter["Service"];
    readonly directory: string;
    readonly scratchRoot: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-word-unit-" });
    const scratchRoot = NodePath.join(directory, "scratch");
    return yield* Effect.gen(function* () {
      const converter = yield* PandocWordConverter;
      return yield* body({ converter, directory, scratchRoot });
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide(toolLayer(scratchRoot)), Layer.provide(NodeServices.layer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const withCommand = (command: PandocCommand | null) => (scratchRoot: string) =>
  managedToolLayer({ command, scratchRoot });

describe("PandocWordConverter", () => {
  it.live("rejects oversized UTF-8 input before starting Pandoc or writing an output", () =>
    run(withCommand(null), ({ converter, directory, scratchRoot }) =>
      Effect.gen(function* () {
        const outputPath = NodePath.join(directory, "oversized.docx");
        const error = yield* converter
          .convert({
            bundle: makeBundle({ markdown: "é".repeat(Math.floor(MAX_WORD_SOURCE_BYTES / 2) + 1) }),
            outputPath,
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("too-large");
        expect(NodeFS.existsSync(outputPath)).toBe(false);
        expect(NodeFS.existsSync(scratchRoot)).toBe(false);
      }),
    ),
  );
  it("reads Scient's profiles with CommonMark and only the profiles' extensions", () => {
    expect(SCIENT_PANDOC_READER.startsWith("commonmark_x-")).toBe(true);
    for (const off of ["attributes", "raw_attribute", "fenced_divs", "smart", "subscript"]) {
      expect(SCIENT_PANDOC_READER).toContain(`-${off}`);
    }
  });

  it.live("is unavailable, with the install size, until Pandoc is installed", () =>
    run(withCommand(null), ({ converter, directory }) =>
      Effect.gen(function* () {
        const availability = yield* converter.availability;
        expect(availability).toEqual({
          available: false,
          reason: "Word export needs Pandoc (40 MB download).",
          installable: true,
        });
        const error = yield* converter
          .convert({
            bundle: makeBundle({ markdown: "# Hi" }),
            outputPath: NodePath.join(directory, "x.docx"),
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("unavailable");
        expect(error.message).toContain("needs Pandoc");
      }),
    ),
  );

  it.live("reports an unsupported platform as unavailable without an install offer", () =>
    run(
      (scratchRoot) =>
        Layer.succeed(
          PandocManagedTool,
          PandocManagedTool.of({
            canInstall: false,
            install: Effect.die("not used"),
            status: Effect.succeed({
              version: "3.11",
              installed: false,
              canInstall: false,
              unavailableReason: "Pandoc 3.11 is not available for win32-arm64.",
              downloadBytes: null,
              install: {
                state: "idle",
                bytesReceived: null,
                totalBytes: null,
                failureReason: null,
                updatedAtEpochMs: 0,
              },
            }),
            command: Effect.succeed(null),
            scratchRoot,
          }),
        ),
      ({ converter }) =>
        Effect.gen(function* () {
          expect(yield* converter.availability).toEqual({
            available: false,
            reason: "Pandoc 3.11 is not available for win32-arm64.",
            installable: false,
          });
        }),
    ),
  );

  it.live("maps Pandoc failures to user messages and leaves no file behind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pidDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-word-pid-",
      });
      const fake = fakePandoc(NodePath.join(pidDirectory, "pid"));
      const outcomes = yield* Effect.forEach(
        [
          ["exit:64", "failed", "could not read"],
          ["exit:61", "failed", "fetch a resource"],
          ["exit:251", "too-large", "memory"],
          ["exit:2", "failed", "could not write"],
        ] as const,
        ([mode, reason, text]) =>
          run(withCommand(fake(mode)), ({ converter, directory, scratchRoot }) =>
            Effect.gen(function* () {
              const outputPath = NodePath.join(directory, "out.docx");
              const error = yield* converter
                .convert({ bundle: makeBundle({ markdown: "# Hi" }), outputPath })
                .pipe(Effect.flip);
              expect(error.reason, mode).toBe(reason);
              expect(error.message, mode).toContain(text);
              expect(NodeFS.existsSync(outputPath)).toBe(false);
              expect(NodeFS.existsSync(`${outputPath}.partial`)).toBe(false);
              expect(NodeFS.readdirSync(scratchRoot)).toEqual([]);
              return mode;
            }),
          ),
      );
      expect(outcomes).toHaveLength(4);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
