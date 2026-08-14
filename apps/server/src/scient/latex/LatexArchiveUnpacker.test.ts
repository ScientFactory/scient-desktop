import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../processRunner.ts";
import { LatexArchiveUnpacker, make, tinyTexUnpackArguments } from "./LatexArchiveUnpacker.ts";

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const harness = (respond: () => Effect.Effect<ProcessRunner.ProcessRunOutput>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
    const layer = Layer.effect(LatexArchiveUnpacker, make).pipe(
      Layer.provide(
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) =>
              Ref.update(calls, (previous) => [...previous, input]).pipe(Effect.andThen(respond())),
          }),
        ),
      ),
    );
    return { layer, calls };
  });

describe("tinyTexUnpackArguments", () => {
  it("hands tar the archive and the directory to expand it into", () => {
    expect(
      tinyTexUnpackArguments({
        archivePath: "/staging/install-1/TinyTeX-1-windows.exe",
        destination: "/staging/install-1/payload",
        archive: "seven-zip-sfx",
      }),
    ).toEqual([
      "-x",
      "-f",
      "/staging/install-1/TinyTeX-1-windows.exe",
      "-C",
      "/staging/install-1/payload",
    ]);
  });
});

describe("LatexArchiveUnpacker", () => {
  it.effect("expands a pinned bundle through tar", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() => Effect.succeed(output()));
      yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        yield* unpacker.unpack({
          archivePath: "/staging/a.exe",
          destination: "/staging/payload",
          archive: "seven-zip-sfx",
        });
      }).pipe(Effect.provide(layer));

      const [call] = yield* Ref.get(calls);
      expect(call?.command).toBe("tar");
      expect(call?.args).toContain("/staging/a.exe");
    }),
  );

  it.effect("refuses a container format the manifest never declared", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() => Effect.succeed(output()));
      const failure = yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        return yield* unpacker.unpack({
          archivePath: "/staging/a.dmg",
          destination: "/staging/payload",
          // A future manifest entry this build has no reader for.
          archive: "apple-disk-image" as never,
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.reason).toBe("unsupported-archive");
      // Nothing was spawned for a format Scient cannot read.
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.effect("carries tar's own complaint into the failure", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness(() =>
        Effect.succeed(
          output({ code: ChildProcessSpawner.ExitCode(1), stderr: "Unrecognized archive format" }),
        ),
      );
      const failure = yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        return yield* unpacker.unpack({
          archivePath: "/staging/a.exe",
          destination: "/staging/payload",
          archive: "seven-zip-sfx",
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.reason).toBe("unpack-failed");
      expect(failure.detail).toContain("Unrecognized archive format");
    }),
  );

  it.effect("treats a wedged expansion as a failure rather than waiting forever", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness(() =>
        Effect.succeed(output({ code: null, timedOut: true })),
      );
      const failure = yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        return yield* unpacker.unpack({
          archivePath: "/staging/a.exe",
          destination: "/staging/payload",
          archive: "seven-zip-sfx",
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.reason).toBe("unpack-failed");
      expect(failure.detail).toContain("too long");
    }),
  );
});
