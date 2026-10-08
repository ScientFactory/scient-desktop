import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../../processRunner.ts";
import { PandocArchiveUnpacker, make, pandocTarCommand } from "./PandocArchiveUnpacker.ts";

const output = (): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Which `tar` runs is a platform decision, so the platform and the file system are pinned. */
const unpackOn = (platform: NodeJS.Platform, present: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
    const layer = Layer.effect(PandocArchiveUnpacker, make).pipe(
      Layer.provide(
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) =>
              Ref.update(calls, (previous) => [...previous, input]).pipe(Effect.as(output())),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(HostProcessPlatform, platform)),
      Layer.provide(Layer.succeed(HostProcessEnvironment, { SystemRoot: "C:\\Windows" })),
      Layer.provide(FileSystem.layerNoop({ exists: (path) => Effect.succeed(present.has(path)) })),
    );
    const result = yield* Effect.gen(function* () {
      const unpacker = yield* PandocArchiveUnpacker;
      return yield* unpacker
        .unpack({
          archivePath: "/staging/pandoc.zip",
          destination: "/staging/payload",
          archive: "zip",
        })
        .pipe(Effect.result);
    }).pipe(Effect.provide(layer));
    return { result, calls: yield* Ref.get(calls) };
  });

describe("pandocTarCommand", () => {
  it("uses the system bsdtar wherever the release is a zip", () => {
    expect(pandocTarCommand("darwin", {})).toBe("/usr/bin/tar");
    expect(pandocTarCommand("win32", { SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\tar.exe",
    );
    expect(pandocTarCommand("linux", {})).toBe("tar");
  });
});

describe("PandocArchiveUnpacker", () => {
  it.effect("expands the macOS zip with /usr/bin/tar, not a GNU tar earlier on PATH", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* unpackOn("darwin", new Set(["/usr/bin/tar"]));
      expect(result._tag).toBe("Success");
      expect(calls.map((call) => call.command)).toEqual(["/usr/bin/tar"]);
      expect(calls[0]?.args).toEqual(["-x", "-f", "/staging/pandoc.zip", "-C", "/staging/payload"]);
    }),
  );

  it.effect("refuses without running anything when the pinned tar is missing", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* unpackOn("darwin", new Set());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("unpacker-unavailable");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("keeps the PATH tar on Linux, whose release is a tarball", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* unpackOn("linux", new Set());
      expect(result._tag).toBe("Success");
      expect(calls.map((call) => call.command)).toEqual(["tar"]);
    }),
  );
});
