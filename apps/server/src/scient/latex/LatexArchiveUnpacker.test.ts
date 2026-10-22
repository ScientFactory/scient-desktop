// @effect-diagnostics nodeBuiltinImport:off -- Detecting the OS unpacker has to
// happen at collection time, before any Effect runtime exists, so the real-archive
// suite can skip itself; the fixture archive is written by that same unpacker.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../../processRunner.ts";
import {
  LatexArchiveUnpacker,
  layer as unpackerLayer,
  make,
  selfExtractorComplaint,
  sevenZipSelfExtractArguments,
  tinyTexUnpackArguments,
  windowsSystemTarPath,
} from "./LatexArchiveUnpacker.ts";

// Whether these cases can run at all is decided at collection time, where no
// Effect runtime exists to read the platform from; the port itself takes it injected.
// oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip, before any Effect runtime exists.
const HOST_IS_WINDOWS = process.platform === "win32";

/** The unpacker this computer would really spawn, resolved the way the port does. */
const SYSTEM_UNPACKER = HOST_IS_WINDOWS ? windowsSystemTarPath(process.env) : "tar";
const SYSTEM_UNPACKER_PRESENT = HOST_IS_WINDOWS
  ? NodeFS.existsSync(SYSTEM_UNPACKER)
  : NodeChildProcess.spawnSync(SYSTEM_UNPACKER, ["--version"], { stdio: "ignore" }).status === 0;

const REAL_UNPACK_TIMEOUT_MS = 30_000;

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

/**
 * The platform is pinned per test rather than inherited: which `tar` this port
 * spawns is a platform decision, and a suite that read the host's platform
 * would assert something different on every developer's machine.
 */
const harness = (
  respond: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<ProcessRunner.ProcessRunOutput>,
  options: { readonly platform?: NodeJS.Platform; readonly systemRoot?: string } = {},
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
    const layer = Layer.effect(LatexArchiveUnpacker, make).pipe(
      Layer.provide(
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) =>
              Ref.update(calls, (previous) => [...previous, input]).pipe(
                Effect.andThen(respond(input)),
              ),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "linux")),
      Layer.provide(
        Layer.succeed(
          HostProcess.Environment,
          options.systemRoot === undefined ? {} : { SystemRoot: options.systemRoot },
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    return { layer, calls };
  });

const unpackFixture = {
  archivePath: "/staging/a.exe",
  destination: "/staging/payload",
  archive: "seven-zip-sfx",
} as const;

/** The fixture in a real staging directory, for cases that clear the destination. */
const stagedFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-staged-" });
  return {
    archivePath: path.join(staging, "TinyTeX-1-windows.exe"),
    destination: path.join(staging, "payload"),
    archive: "seven-zip-sfx",
  } as const;
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

describe("sevenZipSelfExtractArguments", () => {
  it("extracts in full, answers yes to every prompt, and names the destination in one argument", () => {
    expect(
      sevenZipSelfExtractArguments({
        archivePath: "C:\\Users\\me and you\\staging\\TinyTeX-1-windows.exe",
        destination: "C:\\Users\\me and you\\staging\\payload",
        archive: "seven-zip-sfx",
      }),
    ).toEqual(["x", "-y", "-oC:\\Users\\me and you\\staging\\payload"]);
  });
});

describe("selfExtractorComplaint", () => {
  it("prefers what 7-Zip said on stderr over its banner, and leads with the exit code", () => {
    expect(
      selfExtractorComplaint({
        code: 2,
        stdout: "7-Zip SFX 26.02 (x86)\r\n\r\nExtracting archive\r\n",
        stderr: "ERROR: Data Error : TinyTeX\\bin\\windows\\pdftex.exe\r\n",
      }),
    ).toBe("exit 2, ERROR: Data Error : TinyTeX\\bin\\windows\\pdftex.exe");
    expect(selfExtractorComplaint({ code: 7, stdout: "Command Line Error:\n", stderr: "" })).toBe(
      "exit 7, Command Line Error:",
    );
    expect(selfExtractorComplaint({ code: 8, stdout: "", stderr: "" })).toBe("exit 8");
  });
});

describe("windowsSystemTarPath", () => {
  it("addresses the OS bsdtar rather than whatever tar PATH offers", () => {
    expect(windowsSystemTarPath({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\tar.exe",
    );
    // A machine that does not say where Windows lives still gets the usual place.
    expect(windowsSystemTarPath({})).toBe("C:\\Windows\\System32\\tar.exe");
  });
});

describe("LatexArchiveUnpacker", () => {
  it.effect("expands a pinned bundle through tar", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() => Effect.succeed(output()));
      yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        yield* unpacker.unpack(unpackFixture);
      }).pipe(Effect.provide(layer));

      const [call] = yield* Ref.get(calls);
      expect(call?.command).toBe("tar");
      expect(call?.args).toContain("/staging/a.exe");
    }),
  );

  it.effect.skipIf(!HOST_IS_WINDOWS)(
    "spawns the bsdtar Windows ships instead of trusting PATH",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Git for Windows and MSYS2 both put a GNU tar on PATH that cannot read
        // the 7-Zip stub, so the install must not resolve `tar` through it.
        const systemRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-latex-system-root-",
        });
        const systemTar = windowsSystemTarPath({ SystemRoot: systemRoot });
        yield* fileSystem.makeDirectory(path.dirname(systemTar), { recursive: true });
        yield* fileSystem.writeFileString(systemTar, "");

        const { layer, calls } = yield* harness(() => Effect.succeed(output()), {
          platform: "win32",
          systemRoot,
        });
        yield* Effect.gen(function* () {
          const unpacker = yield* LatexArchiveUnpacker;
          yield* unpacker.unpack(unpackFixture);
        }).pipe(Effect.provide(layer));

        const [call] = yield* Ref.get(calls);
        expect(call?.command).toBe(systemTar);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("lets the bundle unpack itself when this computer has no system tar", () =>
    Effect.gen(function* () {
      const fixture = yield* stagedFixture;
      const { layer, calls } = yield* harness(() => Effect.succeed(output()), {
        platform: "win32",
        systemRoot: "Z:\\scient-latex-no-such-windows",
      });
      yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        yield* unpacker.unpack(fixture);
      }).pipe(Effect.provide(layer));

      // A bare `tar` from PATH is never tried: the only spawn is the bundle itself.
      expect((yield* Ref.get(calls)).map((call) => [call.command, call.args])).toEqual([
        [fixture.archivePath, ["x", "-y", `-o${fixture.destination}`]],
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("says so when neither the system tar nor the bundle can unpack it", () =>
    Effect.gen(function* () {
      const fixture = yield* stagedFixture;
      const { layer } = yield* harness(
        () =>
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(2),
              stdout:
                "7-Zip SFX 26.02 (x86)\r\n\r\nERROR: There is not enough space on the disk.\r\n",
            }),
          ),
        { platform: "win32", systemRoot: "Z:\\scient-latex-no-such-windows" },
      );
      const failure = yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        return yield* unpacker.unpack(fixture);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.reason).toBe("unpack-failed");
      // The final failure leads; tar's follows.
      expect(failure.detail).toMatch(
        /^The download's own extractor failed: exit 2, ERROR: There is not enough space on the disk\. Before that, This computer has no Z:\\scient-latex-no-such-windows\\System32\\tar\.exe/u,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("clears what a failing system tar left and lets the bundle unpack itself", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const systemRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-latex-system-root-",
      });
      const systemTar = windowsSystemTarPath({ SystemRoot: systemRoot });
      yield* fileSystem.makeDirectory(path.dirname(systemTar), { recursive: true });
      yield* fileSystem.writeFileString(systemTar, "");
      const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-sfx-" });
      const destination = path.join(staging, "payload");
      const leftover = path.join(destination, "TinyTeX", "half-written.tfm");
      yield* fileSystem.makeDirectory(path.dirname(leftover), { recursive: true });
      yield* fileSystem.writeFileString(leftover, "");
      const archivePath = path.join(staging, "TinyTeX-1-windows.exe");

      const leftoverWhenExtracting = yield* Ref.make<boolean | null>(null);
      const { layer, calls } = yield* harness(
        (input) =>
          input.command === systemTar
            ? // Windows 10's bsdtar: it reads the 7-Zip headers, then cannot decode LZMA.
              Effect.succeed(
                output({
                  code: ChildProcessSpawner.ExitCode(1),
                  stderr: "tar.exe: Error opening archive: Unrecognized archive format",
                }),
              )
            : fileSystem.exists(leftover).pipe(
                Effect.orElseSucceed(() => true),
                Effect.flatMap((present) => Ref.set(leftoverWhenExtracting, present)),
                Effect.as(output()),
              ),
        { platform: "win32", systemRoot },
      );
      yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        yield* unpacker.unpack({ archivePath, destination, archive: "seven-zip-sfx" });
      }).pipe(Effect.provide(layer));

      expect((yield* Ref.get(calls)).map((call) => call.command)).toEqual([systemTar, archivePath]);
      expect(yield* Ref.get(leftoverWhenExtracting)).toBe(false);
      expect(yield* fileSystem.exists(destination)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never runs the download outside Windows", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() =>
        Effect.succeed(output({ code: ChildProcessSpawner.ExitCode(2), stderr: "tar: bad" })),
      );
      const failure = yield* Effect.gen(function* () {
        const unpacker = yield* LatexArchiveUnpacker;
        return yield* unpacker.unpack(unpackFixture);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.detail).toContain("tar: bad");
      expect((yield* Ref.get(calls)).map((call) => call.command)).toEqual(["tar"]);
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
        return yield* unpacker.unpack(unpackFixture);
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
        return yield* unpacker.unpack(unpackFixture);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.reason).toBe("unpack-failed");
      expect(failure.detail).toContain("too long");
    }),
  );
});

/**
 * The stubs above prove which command is spawned and what is made of its exit
 * code; only this proves that spawning it works at all — that the resolved
 * unpacker exists, accepts the argv this lane builds, and leaves the archive's
 * entries on disk where the installer then looks for the engine.
 */
describe.skipIf(!SYSTEM_UNPACKER_PRESENT)("LatexArchiveUnpacker against the real tar", () => {
  it.live(
    "expands an archive through the command the port resolves",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-latex-real-unpack-",
        });
        const source = path.join(root, "source", "TinyTeX", "bin");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.writeFileString(path.join(source, "latexmk.txt"), "engine");

        const archivePath = path.join(root, "fixture.tar");
        const written = NodeChildProcess.spawnSync(
          SYSTEM_UNPACKER,
          ["-c", "-f", archivePath, "-C", path.join(root, "source"), "."],
          { stdio: "ignore", timeout: REAL_UNPACK_TIMEOUT_MS },
        );
        expect(written.error).toBeUndefined();
        expect(written.status).toBe(0);

        const destination = path.join(root, "payload");
        yield* fileSystem.makeDirectory(destination, { recursive: true });
        yield* Effect.gen(function* () {
          const unpacker = yield* LatexArchiveUnpacker;
          // The kind only decides whether Scient will read the bundle at all;
          // tar sniffs the container itself, which is why both pinned formats
          // take the same flags and a plain tar exercises the same path.
          yield* unpacker.unpack({ archivePath, destination, archive: "tar-xz" });
        }).pipe(Effect.provide(unpackerLayer));

        expect(
          yield* fileSystem.readFileString(path.join(destination, "TinyTeX", "bin", "latexmk.txt")),
        ).toBe("engine");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    REAL_UNPACK_TIMEOUT_MS,
  );
});
