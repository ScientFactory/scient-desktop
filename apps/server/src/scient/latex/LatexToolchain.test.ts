import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { LatexToolchain, make, parseLatexToolchainVersion } from "./LatexToolchain.ts";
import { encodeManagedLatexInstallRecord, managedLatexPaths } from "./managedLatexInstall.ts";
import { TinyTexManifestRef, type TinyTexManifest } from "./tinytexManifest.ts";

// Verbatim engine banners; the parser must survive their prose, not a fixture.
const LATEXMK_BANNER = "\nLatexmk, John Collins, 27 Jan. 2023. Version 4.79\n";
const TECTONIC_BANNER = "Tectonic 0.15.0\n";
const COMPILER_NAMES = ["pdflatex", "xelatex", "lualatex"] as const;
const PDFLATEX_BANNER = "pdfTeX 3.141592653-2.6-1.40.28 (TeX Live 2026)\n";
const XELATEX_BANNER = "XeTeX 3.141592653-2.6-0.999997 (TeX Live 2026)\n";
const LUALATEX_BANNER = "This is LuaHBTeX, Version 1.22.0 (TeX Live 2026)\n";

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const spawnFailure = (command: string) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command,
      argumentCount: 1,
      cause: new Error("spawn ENOENT"),
    }),
  );

/** Only the win32-x64 slot matters here: the tests pin the platform and architecture to match. */
const MANAGED_EXECUTABLE_RELATIVE_PATH = "TinyTeX/bin/windows/latexmk.exe";
const testManifest: TinyTexManifest = {
  version: "2026.08",
  assets: {
    "win32-x64": {
      fileName: "TinyTeX-1-windows.exe",
      url: "https://github.com/rstudio/tinytex-releases/releases/download/v2026.08/TinyTeX-1-windows.exe",
      sha256: "0".repeat(64),
      sizeBytes: 1,
      archive: "seven-zip-sfx",
      executableRelativePath: MANAGED_EXECUTABLE_RELATIVE_PATH,
    },
    "win32-arm64": null,
    "darwin-x64": null,
    "darwin-arm64": null,
    "linux-x64": null,
    "linux-arm64": null,
  },
};

/**
 * Wires the probe over a fake process runner and an empty state directory, so
 * a test decides both what PATH answers and whether a managed install is there.
 */
const harness = (
  respond: (
    command: string,
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  options: { readonly managedInstall?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-probe-" });
    const config = ServerConfig.layerTest(baseDir, baseDir);
    const latexDir = path.join(baseDir, "userdata", "latex");
    const paths = managedLatexPaths({ latexDir, join: path.join });
    const installRoot = path.join(paths.managedRoot, "tinytex-2026.08");
    const managedExecutable = path.join(installRoot, MANAGED_EXECUTABLE_RELATIVE_PATH);

    if (options.managedInstall === true) {
      yield* fileSystem.makeDirectory(path.dirname(managedExecutable), { recursive: true });
      yield* fileSystem.writeFileString(managedExecutable, "");
      const contents = yield* encodeManagedLatexInstallRecord({
        schemaVersion: 1,
        version: "2026.08",
        installedAtEpochMs: 1,
        root: installRoot,
      });
      yield* fileSystem.makeDirectory(paths.managedRoot, { recursive: true });
      yield* fileSystem.writeFileString(paths.statePath, contents);
    }

    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(calls, (previous) => [...previous, input.command]).pipe(
          Effect.andThen(respond(input.command, input)),
        ),
    });
    return {
      layer: Layer.effect(LatexToolchain, make).pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
        Layer.provide(Layer.succeed(HostProcessEnvironment, { Path: "C:\\system" })),
        Layer.provide(
          Layer.succeed(SpawnExecutableResolution, (command, _platform, environment) => {
            const binDirectory = environment.Path?.split(";")[0];
            return COMPILER_NAMES.some((compiler) => compiler === command) &&
              binDirectory !== undefined &&
              binDirectory !== "C:\\system"
              ? path.join(binDirectory, `${command}.exe`)
              : command;
          }),
        ),
        Layer.provide(Layer.succeed(HostProcessArchitecture, "x64")),
        Layer.provide(Layer.succeed(TinyTexManifestRef, testManifest)),
      ),
      calls,
      /** Absolute path of the engine a managed install would leave behind. */
      managedExecutable,
    };
  });

/** PATH has nothing; anything else the probe spawns is the managed copy. */
const onlyManagedResponds = (command: string) => {
  if (command === "latexmk" || command === "tectonic") return spawnFailure(command);
  const banner = command.endsWith("pdflatex.exe")
    ? PDFLATEX_BANNER
    : command.endsWith("xelatex.exe")
      ? XELATEX_BANNER
      : command.endsWith("lualatex.exe")
        ? LUALATEX_BANNER
        : LATEXMK_BANNER;
  return Effect.succeed(output(banner));
};

describe("parseLatexToolchainVersion", () => {
  it("reads the version out of each engine's own banner", () => {
    expect(parseLatexToolchainVersion("latexmk", LATEXMK_BANNER)).toBe("4.79");
    expect(parseLatexToolchainVersion("tectonic", TECTONIC_BANNER)).toBe("0.15.0");
  });

  it("falls back to a loose version and tolerates an unreadable banner", () => {
    expect(parseLatexToolchainVersion("tectonic", "tectonic-cli 0.14.1 (custom build)")).toBe(
      "0.14.1",
    );
    expect(parseLatexToolchainVersion("latexmk", "no version here")).toBeNull();
  });
});

describe("LatexToolchain", () => {
  it.effect("prefers latexmk and reports its version", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) =>
        command === "latexmk" ? Effect.succeed(output(LATEXMK_BANNER)) : spawnFailure(command),
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("latexmk");
      expect(status.executable).toBe("latexmk");
      expect(status.version).toBe("4.79");
      expect(status.source).toBe("system");
      expect(status.compilers).toEqual(
        COMPILER_NAMES.map((compiler) => ({
          compiler,
          available: false,
          executable: null,
          version: null,
        })),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats a spawn failure as an absent candidate and falls through to tectonic", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness((command) =>
        command === "tectonic" ? Effect.succeed(output(TECTONIC_BANNER)) : spawnFailure(command),
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("tectonic");
      expect(status.version).toBe("0.15.0");
      expect(status.source).toBe("system");
      expect(yield* Ref.get(calls)).toEqual(["latexmk", "tectonic"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports no toolchain when neither engine can be spawned", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) => spawnFailure(command));
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status).toMatchObject({ kind: null, executable: null, version: null });
      expect(status.source).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("falls back to the distribution Scient installed and says where it came from", () =>
    Effect.gen(function* () {
      const { layer, managedExecutable } = yield* harness(onlyManagedResponds, {
        managedInstall: true,
      });
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("latexmk");
      expect(status.executable).toBe(managedExecutable);
      expect(status.source).toBe("scient-managed");
      expect(status.compilers).toEqual(
        COMPILER_NAMES.map((compiler, index) => ({
          compiler,
          available: true,
          executable: managedExecutable.replace(/latexmk\.exe$/u, `${compiler}.exe`),
          version: ["1.40.28", "0.999997", "1.22.0"][index],
        })),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ignores a recorded install whose engine is no longer on disk", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { layer, managedExecutable } = yield* harness(onlyManagedResponds, {
        managedInstall: true,
      });
      yield* fileSystem.remove(managedExecutable, { force: true });
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status).toMatchObject({ kind: null, executable: null });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("spawns one probe for concurrent callers that all find no cached answer", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() =>
        // Yield inside the probe so the second caller really is in flight
        // while the first one is still shelling out.
        Effect.yieldNow.pipe(Effect.as(output(LATEXMK_BANNER))),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const [first, second] = yield* Effect.all(
          [toolchain.probe(false), toolchain.probe(false)],
          {
            concurrency: "unbounded",
          },
        );
        // One spawn sequence, one answer: the loser of the gate read the cache.
        expect(yield* Ref.get(calls)).toEqual(["latexmk", ...COMPILER_NAMES]);
        expect(second.probedAtEpochMs).toBe(first.probedAtEpochMs);
        expect(second.kind).toBe("latexmk");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports each compiler independently instead of trusting latexmk", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) => {
        if (command === "latexmk") return Effect.succeed(output(LATEXMK_BANNER));
        if (command === "pdflatex") return Effect.succeed(output(PDFLATEX_BANNER));
        if (command === "xelatex") return spawnFailure(command);
        return Effect.succeed({ ...output(LUALATEX_BANNER), timedOut: true });
      });
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.compilers).toEqual([
          { compiler: "pdflatex", available: true, executable: "pdflatex", version: "1.40.28" },
          { compiler: "xelatex", available: false, executable: null, version: null },
          { compiler: "lualatex", available: false, executable: null, version: null },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not present standalone compilers as available through Tectonic", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) =>
        command === "latexmk"
          ? spawnFailure(command)
          : Effect.succeed(output(command === "tectonic" ? TECTONIC_BANNER : XELATEX_BANNER)),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.kind).toBe("tectonic");
        expect(status.compilers).toEqual(
          COMPILER_NAMES.map((compiler) => ({
            compiler,
            available: false,
            executable: null,
            version: null,
          })),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refreshes a missing compiler without waiting for the cached driver to expire", () =>
    Effect.gen(function* () {
      const installed = yield* Ref.make(false);
      const { layer } = yield* harness((command) =>
        Effect.gen(function* () {
          if (command === "latexmk") return output(LATEXMK_BANNER);
          if (!(yield* Ref.get(installed))) return yield* spawnFailure(command);
          if (command === "xelatex") return output(XELATEX_BANNER);
          if (command === "lualatex") return output(LUALATEX_BANNER);
          return output(PDFLATEX_BANNER);
        }),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const first = yield* toolchain.probe(false);
        expect(first.compilers.every((compiler) => !compiler.available)).toBe(true);
        yield* Ref.set(installed, true);
        const cached = yield* toolchain.probe(false);
        expect(cached.compilers).toEqual(first.compilers);
        const refreshed = yield* toolchain.probe(true);
        expect(refreshed.compilers).toEqual([
          { compiler: "pdflatex", available: true, executable: "pdflatex", version: "1.40.28" },
          { compiler: "xelatex", available: true, executable: "xelatex", version: "0.999997" },
          { compiler: "lualatex", available: true, executable: "lualatex", version: "1.22.0" },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports a missing managed compiler even when managed latexmk runs", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness(
        (command) =>
          command.endsWith("latexmk.exe")
            ? Effect.succeed(output(LATEXMK_BANNER))
            : spawnFailure(command),
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.source).toBe("scient-managed");
        expect(status.compilers).toEqual(
          COMPILER_NAMES.map((compiler) => ({
            compiler,
            available: false,
            executable: null,
            version: null,
          })),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("serves a cached answer inside the TTL and re-probes once it lapses", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() => Effect.succeed(output(LATEXMK_BANNER)));
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const first = yield* toolchain.probe(false);
        yield* TestClock.adjust(Duration.minutes(1));
        const cached = yield* toolchain.probe(false);
        expect(cached.probedAtEpochMs).toBe(first.probedAtEpochMs);
        expect(yield* Ref.get(calls)).toHaveLength(4);

        yield* TestClock.adjust(Duration.minutes(6));
        const refreshed = yield* toolchain.probe(false);
        expect(refreshed.probedAtEpochMs).toBeGreaterThan(first.probedAtEpochMs);
        expect(yield* Ref.get(calls)).toHaveLength(8);

        yield* toolchain.probe(true);
        expect(yield* Ref.get(calls)).toHaveLength(12);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
