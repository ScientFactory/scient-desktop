import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  LatexToolchain,
  latexDriverBinDirectory,
  latexDriverLabel,
  latexProbeFailureReason,
  make,
  parseLatexToolchainVersion,
  windowsLatexmkFolders,
  withoutHomeDirectory,
} from "./LatexToolchain.ts";
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
  options: {
    readonly managedInstall?: boolean;
    /** Host environment; the default has a PATH with nothing on it. */
    readonly environment?: NodeJS.ProcessEnv;
    /** Where the bare `latexmk` resolves, as Node's PATH search would answer. */
    readonly latexmkOnPath?: string;
  } = {},
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
        Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
        Layer.provide(
          Layer.succeed(HostProcess.Environment, options.environment ?? { Path: "C:\\system" }),
        ),
        Layer.provide(
          Layer.succeed(SpawnExecutableResolution, (command, _platform, environment) => {
            if (command === "latexmk" && options.latexmkOnPath !== undefined) {
              return options.latexmkOnPath;
            }
            const binDirectory = environment.Path?.split(";")[0];
            return COMPILER_NAMES.some((compiler) => compiler === command) &&
              binDirectory !== undefined &&
              binDirectory !== "C:\\system"
              ? path.join(binDirectory, `${command}.exe`)
              : command;
          }),
        ),
        Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
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

  it.effect(
    "selects explicitly requested Tectonic without replacing the system latexmk default",
    () =>
      Effect.gen(function* () {
        const { layer, calls } = yield* harness((command) =>
          Effect.succeed(
            output(
              command === "latexmk"
                ? LATEXMK_BANNER
                : command === "tectonic"
                  ? TECTONIC_BANNER
                  : command === "pdflatex"
                    ? PDFLATEX_BANNER
                    : command === "xelatex"
                      ? XELATEX_BANNER
                      : LUALATEX_BANNER,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          expect((yield* toolchain.probe(false)).kind).toBe("latexmk");
          expect((yield* toolchain.probe(false, "tectonic")).kind).toBe("tectonic");
          yield* toolchain.probe(false, "tectonic");
          expect((yield* toolchain.probe(false)).kind).toBe("latexmk");
          expect((yield* Ref.get(calls)).filter((command) => command === "tectonic")).toHaveLength(
            1,
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not substitute latexmk when an explicit Tectonic driver is absent", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) =>
        command === "tectonic"
          ? spawnFailure(command)
          : Effect.succeed(
              output(
                command === "latexmk"
                  ? LATEXMK_BANNER
                  : command === "pdflatex"
                    ? PDFLATEX_BANNER
                    : command === "xelatex"
                      ? XELATEX_BANNER
                      : LUALATEX_BANNER,
              ),
            ),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        expect((yield* toolchain.probe(false, "tectonic")).kind).toBeNull();
        expect((yield* toolchain.probe(false)).kind).toBe("latexmk");
      }).pipe(Effect.provide(layer));
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

  it.effect("keeps a fully capable system distribution ahead of an existing managed install", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(
        (command) => {
          if (command === "latexmk") return Effect.succeed(output(LATEXMK_BANNER));
          if (command === "pdflatex") return Effect.succeed(output(PDFLATEX_BANNER));
          if (command === "xelatex") return Effect.succeed(output(XELATEX_BANNER));
          if (command === "lualatex") return Effect.succeed(output(LUALATEX_BANNER));
          return onlyManagedResponds(command);
        },
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status).toMatchObject({
          kind: "latexmk",
          executable: "latexmk",
          source: "system",
        });
        expect(status.compilers.every((compiler) => compiler.available)).toBe(true);
        expect(yield* Ref.get(calls)).toEqual(["latexmk", ...COMPILER_NAMES]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps system Tectonic as the default after optional compilers are installed", () =>
    Effect.gen(function* () {
      const { layer, managedExecutable } = yield* harness(
        (command) => {
          if (command === "latexmk") return spawnFailure(command);
          if (command === "tectonic") return Effect.succeed(output(TECTONIC_BANNER));
          return onlyManagedResponds(command);
        },
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status).toMatchObject({
          kind: "tectonic",
          executable: "tectonic",
          source: "system",
        });
        expect(status.compilers).toEqual(
          COMPILER_NAMES.map((compiler, index) => ({
            compiler,
            available: true,
            executable: managedExecutable.replace(/latexmk\.exe$/u, `${compiler}.exe`),
            version: ["1.40.28", "0.999997", "1.22.0"][index],
          })),
        );
        expect(yield* toolchain.probe(false, "lualatex")).toMatchObject({
          kind: "latexmk",
          executable: managedExecutable,
          source: "scient-managed",
        });
        expect(yield* toolchain.probe(false, "xelatex")).toMatchObject({
          kind: "tectonic",
          executable: "tectonic",
          source: "system",
        });
        expect(yield* toolchain.probe(false)).toEqual(status);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "keeps partial system TeX as the default and uses TinyTeX only for a missing compiler",
    () =>
      Effect.gen(function* () {
        const { layer, managedExecutable } = yield* harness(
          (command) => {
            if (command === "latexmk") return Effect.succeed(output(LATEXMK_BANNER));
            if (command === "pdflatex") return Effect.succeed(output(PDFLATEX_BANNER));
            if (command === "xelatex" || command === "lualatex") return spawnFailure(command);
            return onlyManagedResponds(command);
          },
          { managedInstall: true },
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          const status = yield* toolchain.probe(false);
          expect(status).toMatchObject({
            kind: "latexmk",
            executable: "latexmk",
            source: "system",
          });
          expect(status.compilers).toEqual([
            { compiler: "pdflatex", available: true, executable: "pdflatex", version: "1.40.28" },
            ...(["xelatex", "lualatex"] as const).map((compiler, index) => ({
              compiler,
              available: true,
              executable: managedExecutable.replace(/latexmk\.exe$/u, `${compiler}.exe`),
              version: ["0.999997", "1.22.0"][index],
            })),
          ]);
          expect(yield* toolchain.probe(false, "pdflatex")).toMatchObject({
            executable: "latexmk",
            source: "system",
          });
          expect(yield* toolchain.probe(false, "lualatex")).toMatchObject({
            executable: managedExecutable,
            source: "scient-managed",
          });
          expect(yield* toolchain.probe(false)).toEqual(status);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports a managed addition without hiding an existing system compiler", () =>
    Effect.gen(function* () {
      const { layer, managedExecutable } = yield* harness(
        (command) => {
          if (command === "latexmk" || command.endsWith("latexmk.exe")) {
            return Effect.succeed(output(LATEXMK_BANNER));
          }
          if (command === "pdflatex") return Effect.succeed(output(PDFLATEX_BANNER));
          if (command.endsWith("xelatex.exe")) return Effect.succeed(output(XELATEX_BANNER));
          return spawnFailure(command);
        },
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.source).toBe("system");
        expect(status.compilers).toEqual([
          { compiler: "pdflatex", available: true, executable: "pdflatex", version: "1.40.28" },
          {
            compiler: "xelatex",
            available: true,
            executable: managedExecutable.replace(/latexmk\.exe$/u, "xelatex.exe"),
            version: "0.999997",
          },
          { compiler: "lualatex", available: false, executable: null, version: null },
        ]);
        expect(yield* toolchain.probe(false, "xelatex")).toMatchObject({
          executable: managedExecutable,
          source: "scient-managed",
        });
        expect(yield* toolchain.probe(false, "pdflatex")).toMatchObject({
          executable: "latexmk",
          source: "system",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "falls back to system Tectonic when the recorded managed driver fails verification",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* harness(
          (command) =>
            command === "tectonic"
              ? Effect.succeed(output(TECTONIC_BANNER))
              : spawnFailure(command),
          { managedInstall: true },
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          const status = yield* toolchain.probe(false);
          expect(status).toMatchObject({ kind: "tectonic", source: "system" });
          expect(status.compilers.every((compiler) => !compiler.available)).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("resolves managed compilers ahead of working but different system compilers", () =>
    Effect.gen(function* () {
      const { layer, managedExecutable } = yield* harness(
        (command) => {
          if (COMPILER_NAMES.some((compiler) => compiler === command)) {
            return Effect.succeed(output("system compiler 9.9.9"));
          }
          return onlyManagedResponds(command);
        },
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.source).toBe("scient-managed");
        expect(status.compilers).toEqual(
          COMPILER_NAMES.map((compiler, index) => ({
            compiler,
            available: true,
            executable: managedExecutable.replace(/latexmk\.exe$/u, `${compiler}.exe`),
            version: ["1.40.28", "0.999997", "1.22.0"][index],
          })),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  const failures = [
    { name: "nonzero exit", code: 1, timedOut: false, stderr: "" },
    { name: "timeout despite a successful exit", code: 0, timedOut: true, stderr: "" },
    {
      name: "Windows missing-command shim",
      code: 9009,
      timedOut: false,
      stderr: "'latexmk' is not recognized as an internal or external command.",
    },
  ];
  it.effect.each(failures)(
    "rejects a driver with $name even when it prints a valid banner",
    (failure) =>
      Effect.gen(function* () {
        const { layer } = yield* harness((command) =>
          command === "latexmk"
            ? Effect.succeed({
                ...output(LATEXMK_BANNER),
                code: ChildProcessSpawner.ExitCode(failure.code),
                timedOut: failure.timedOut,
                stderr: failure.stderr,
              })
            : Effect.succeed(output(TECTONIC_BANNER)),
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          expect(yield* toolchain.probe(false)).toMatchObject({
            kind: "tectonic",
            executable: "tectonic",
            version: "0.15.0",
            source: "system",
          });
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(failures)("does not advertise a managed distribution with $name", (failure) =>
    Effect.gen(function* () {
      const { layer } = yield* harness(
        (command) =>
          command === "latexmk" || command === "tectonic"
            ? spawnFailure(command)
            : Effect.succeed({
                ...output(LATEXMK_BANNER),
                code: ChildProcessSpawner.ExitCode(failure.code),
                timedOut: failure.timedOut,
                stderr: failure.stderr,
              }),
        { managedInstall: true },
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status).toMatchObject({ kind: null, executable: null, version: null });
        expect(status.source).toBeUndefined();
        expect(status.compilers.every((compiler) => !compiler.available)).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "rejects failed compiler banners while retaining successful unversioned compilers",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* harness((command) => {
          if (command === "latexmk") return Effect.succeed(output(LATEXMK_BANNER));
          if (command === "pdflatex") {
            return Effect.succeed({
              ...output(PDFLATEX_BANNER),
              code: ChildProcessSpawner.ExitCode(1),
            });
          }
          if (command === "xelatex") {
            return Effect.succeed({
              ...output(XELATEX_BANNER),
              code: ChildProcessSpawner.ExitCode(9009),
              stderr: "'xelatex' is not recognized as an internal or external command.",
            });
          }
          return Effect.succeed(output("Custom Lua compiler, version unavailable"));
        });
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          const status = yield* toolchain.probe(false);
          expect(status.kind).toBe("latexmk");
          expect(status.compilers).toEqual([
            { compiler: "pdflatex", available: false, executable: null, version: null },
            { compiler: "xelatex", available: false, executable: null, version: null },
            { compiler: "lualatex", available: true, executable: "lualatex", version: null },
          ]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads driver and compiler versions from stderr-only successful probes", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) => {
        const banner =
          command === "latexmk"
            ? LATEXMK_BANNER
            : command === "pdflatex"
              ? PDFLATEX_BANNER
              : command === "xelatex"
                ? XELATEX_BANNER
                : LUALATEX_BANNER;
        return Effect.succeed({ ...output(""), stderr: banner });
      });
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const status = yield* toolchain.probe(false);
        expect(status.version).toBe("4.79");
        expect(status.compilers).toEqual([
          { compiler: "pdflatex", available: true, executable: "pdflatex", version: "1.40.28" },
          { compiler: "xelatex", available: true, executable: "xelatex", version: "0.999997" },
          { compiler: "lualatex", available: true, executable: "lualatex", version: "1.22.0" },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "publishes refreshed driver and compiler facts together rather than a partial snapshot",
    () =>
      Effect.gen(function* () {
        const refreshing = yield* Ref.make(false);
        const compilerStarted = yield* Deferred.make<void>();
        const releaseCompiler = yield* Deferred.make<void>();
        const { layer, calls } = yield* harness((command) =>
          Effect.gen(function* () {
            const isRefreshing = yield* Ref.get(refreshing);
            if (command === "latexmk") {
              return output(isRefreshing ? LATEXMK_BANNER.replace("4.79", "4.80") : LATEXMK_BANNER);
            }
            if (!isRefreshing) return yield* spawnFailure(command);
            if (command === "xelatex") {
              yield* Deferred.succeed(compilerStarted, undefined);
              yield* Deferred.await(releaseCompiler);
              return output(XELATEX_BANNER);
            }
            return yield* spawnFailure(command);
          }),
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          const initial = yield* toolchain.probe(false);
          yield* TestClock.adjust(Duration.millis(5 * 60 * 1_000 - 1));
          yield* Ref.set(refreshing, true);
          const refresh = yield* Effect.forkChild(toolchain.probe(true));
          yield* Deferred.await(compilerStarted);
          const duringRefresh = yield* toolchain.probe(false);
          expect(duringRefresh).toEqual(initial);
          expect(duringRefresh.compilers.every((compiler) => !compiler.available)).toBe(true);
          yield* TestClock.adjust(Duration.millis(1));
          const waitingForRefresh = yield* Effect.forkChild(toolchain.probe(false));
          yield* Effect.yieldNow;
          expect(waitingForRefresh.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(releaseCompiler, undefined);
          const completed = yield* Fiber.join(refresh);
          expect(completed.version).toBe("4.80");
          expect(completed.compilers).toEqual([
            { compiler: "pdflatex", available: false, executable: null, version: null },
            { compiler: "xelatex", available: true, executable: "xelatex", version: "0.999997" },
            { compiler: "lualatex", available: false, executable: null, version: null },
          ]);
          expect(yield* toolchain.probe(false)).toEqual(completed);
          expect(yield* Fiber.join(waitingForRefresh)).toEqual(completed);
          expect(yield* Ref.get(calls)).toEqual([
            "latexmk",
            ...COMPILER_NAMES,
            "latexmk",
            ...COMPILER_NAMES,
          ]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect(
    "expires a cached absence at the TTL boundary and shares one complete rediscovery",
    () =>
      Effect.gen(function* () {
        const installed = yield* Ref.make(false);
        const { layer, calls } = yield* harness((command) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(installed))) return yield* spawnFailure(command);
            yield* Effect.yieldNow;
            if (command === "latexmk") return output(LATEXMK_BANNER);
            if (command === "pdflatex") return output(PDFLATEX_BANNER);
            if (command === "xelatex") return output(XELATEX_BANNER);
            return output(LUALATEX_BANNER);
          }),
        );
        yield* Effect.gen(function* () {
          const toolchain = yield* LatexToolchain;
          const absent = yield* toolchain.probe(false);
          expect(absent.kind).toBeNull();
          yield* Ref.set(installed, true);
          yield* TestClock.adjust(Duration.millis(5 * 60 * 1_000 - 1));
          expect(yield* toolchain.probe(false)).toEqual(absent);
          yield* TestClock.adjust(Duration.millis(1));
          const [first, second] = yield* Effect.all(
            [toolchain.probe(false), toolchain.probe(false)],
            { concurrency: "unbounded" },
          );
          expect(second).toEqual(first);
          expect(first).toMatchObject({ kind: "latexmk", source: "system" });
          expect(first.compilers.every((compiler) => compiler.available)).toBe(true);
          expect(yield* Ref.get(calls)).toEqual([
            "latexmk",
            "tectonic",
            "latexmk",
            ...COMPILER_NAMES,
          ]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.provide(TestClock.layer())),
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

// MiKTeX's own words when its `latexmk.exe` has no Perl to run under.
const MIKTEX_NO_PERL =
  "Sorry, but latexmk.exe did not succeed for the following reason:\r\n\r\n" +
  "  MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'.\r\n\r\n" +
  "Remedy:\r\n\r\n  Make sure 'perl' is installed on your system.\r\n";
const MIKTEX_NO_PERL_REASON =
  "MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'.";

const failed = (stderr: string, code = 1): ProcessRunner.ProcessRunOutput => ({
  ...output(""),
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
});

/** Two `latexmk.exe` on PATH, MiKTeX's first, as on a computer with both distributions. */
const twoDistributions = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-two-" });
  const miktex = path.join(root, "MiKTeX", "miktex", "bin", "x64");
  const texlive = path.join(root, "texlive", "2024", "bin", "windows");
  for (const folder of [miktex, texlive]) {
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* fileSystem.writeFileString(path.join(folder, "latexmk.exe"), "");
  }
  return {
    root,
    miktex,
    texlive,
    miktexLatexmk: path.join(miktex, "latexmk.exe"),
    texliveLatexmk: path.join(texlive, "latexmk.exe"),
  };
});

describe("latexmk fallback", () => {
  it.effect("uses the next latexmk on PATH when the first one does not run", () =>
    Effect.gen(function* () {
      const machine = yield* twoDistributions;
      const environment = { Path: `${machine.miktex};${machine.texlive}` };
      const seen: Array<ProcessRunner.ProcessRunInput> = [];
      const { layer, calls } = yield* harness(
        (command, input) => {
          seen.push(input);
          if (command === "latexmk" || command === machine.miktexLatexmk) {
            return Effect.succeed(failed(MIKTEX_NO_PERL));
          }
          if (command === machine.texliveLatexmk) return Effect.succeed(output(LATEXMK_BANNER));
          return spawnFailure(command);
        },
        { environment, latexmkOnPath: machine.miktexLatexmk },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status).toMatchObject({
        kind: "latexmk",
        executable: machine.texliveLatexmk,
        version: "4.79",
        source: "system",
      });
      expect(status.unusable).toBeUndefined();
      // By name first, then every copy by its own path, so the one reported is the one run.
      expect((yield* Ref.get(calls)).slice(0, 3)).toEqual([
        "latexmk",
        machine.miktexLatexmk,
        machine.texliveLatexmk,
      ]);
      // TeX Live's latexmk must drive TeX Live's engines, not MiKTeX's.
      const texliveProbe = seen.find((input) => input.command === machine.texliveLatexmk);
      expect(texliveProbe?.env?.Path?.split(";")[0]).toBe(machine.texlive);
      expect(latexDriverBinDirectory(status, yield* Path.Path)).toBe(machine.texlive);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("finds a default install folder that PATH does not list", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const localAppData = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-latex-local-",
      });
      const miktex = path.join(localAppData, "Programs", "MiKTeX", "miktex", "bin", "x64");
      yield* fileSystem.makeDirectory(miktex, { recursive: true });
      yield* fileSystem.writeFileString(path.join(miktex, "latexmk.exe"), "");
      const { layer } = yield* harness(
        (command) =>
          command === path.join(miktex, "latexmk.exe")
            ? Effect.succeed(output(LATEXMK_BANNER))
            : spawnFailure(command),
        { environment: { Path: "C:\\system", LOCALAPPDATA: localAppData } },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("latexmk");
      expect(status.executable).toBe(path.join(miktex, "latexmk.exe"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("names every latexmk that exists but did not run, when none did", () =>
    Effect.gen(function* () {
      const machine = yield* twoDistributions;
      const { layer } = yield* harness(
        (command) => {
          if (command === "latexmk" || command === machine.miktexLatexmk) {
            return Effect.succeed(failed(MIKTEX_NO_PERL));
          }
          if (command === machine.texliveLatexmk) {
            return Effect.succeed({ ...failed(""), code: null, timedOut: true });
          }
          if (command === "tectonic") {
            return Effect.succeed(
              failed("error while loading shared libraries: libgraphite2.so.3"),
            );
          }
          return spawnFailure(command);
        },
        {
          environment: { Path: `${machine.miktex};${machine.texlive}` },
          latexmkOnPath: machine.miktexLatexmk,
        },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBeNull();
      expect(status.unusable).toEqual([
        { executable: machine.miktexLatexmk, reason: MIKTEX_NO_PERL_REASON },
        {
          executable: machine.texliveLatexmk,
          reason: "It did not answer within 10 seconds.",
        },
        // A Tectonic that is there but broken is named too, not called missing.
        {
          executable: "tectonic",
          reason: "error while loading shared libraries: libgraphite2.so.3",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a working first latexmk exactly as before, without looking further", () =>
    Effect.gen(function* () {
      const machine = yield* twoDistributions;
      const { layer, calls } = yield* harness(
        (command) =>
          command === "latexmk" ? Effect.succeed(output(LATEXMK_BANNER)) : spawnFailure(command),
        {
          environment: { Path: `${machine.miktex};${machine.texlive}` },
          latexmkOnPath: machine.miktexLatexmk,
        },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.executable).toBe("latexmk");
      expect(latexDriverBinDirectory(status, yield* Path.Path)).toBeNull();
      expect((yield* Ref.get(calls)).filter((command) => command.includes("latexmk"))).toEqual([
        "latexmk",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not report a latexmk that is not installed as unusable", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) => spawnFailure(command));
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));
      expect(status.kind).toBeNull();
      expect(status.unusable).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("latexProbeFailureReason", () => {
  const base = { stdout: "", stderr: "", code: 1, timedOut: false, timeoutSeconds: 10 };

  it("skips a launcher's introduction and reads its cause", () => {
    expect(latexProbeFailureReason({ ...base, stderr: MIKTEX_NO_PERL })).toBe(
      MIKTEX_NO_PERL_REASON,
    );
  });

  it("says how a silent or slow probe ended, and bounds a long line", () => {
    expect(latexProbeFailureReason(base)).toBe("It exited with code 1.");
    expect(latexProbeFailureReason({ ...base, timedOut: true, code: null })).toBe(
      "It did not answer within 10 seconds.",
    );
    const reason = latexProbeFailureReason({ ...base, stdout: "x".repeat(500) });
    expect(reason).toHaveLength(240);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("windowsLatexmkFolders", () => {
  const join = (...segments: ReadonlyArray<string>) => segments.join("\\").replace(/\\+/gu, "\\");

  it("lists MiKTeX's folders, then TeX Live's newest year first in all its layouts", () => {
    expect(
      windowsLatexmkFolders({
        environment: {
          localappdata: "C:\\Users\\me\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
          SystemDrive: "D:",
        },
        texliveYears: ["2023", "texmf-local", "2024"],
        join,
      }),
    ).toEqual([
      "C:\\Users\\me\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64",
      "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
      "D:\\texlive\\2024\\bin\\windows",
      "D:\\texlive\\2024\\bin\\win64",
      "D:\\texlive\\2024\\bin\\win32",
      "D:\\texlive\\2023\\bin\\windows",
      "D:\\texlive\\2023\\bin\\win64",
      "D:\\texlive\\2023\\bin\\win32",
    ]);
  });

  it("looks for nothing it has no variable for", () => {
    expect(windowsLatexmkFolders({ environment: {}, texliveYears: ["2024"], join })).toEqual([]);
  });
});

describe("latexmk discovery lifecycle", () => {
  it.effect("keeps discovering after the caller that started it gives up", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { layer, calls } = yield* harness((command) =>
        command === "latexmk"
          ? Deferred.await(release).pipe(Effect.as(output(LATEXMK_BANNER)))
          : spawnFailure(command),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const impatient = yield* Effect.forkChild(toolchain.probe(false));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(impatient);
        yield* Deferred.succeed(release, undefined);

        // The next caller reads what the abandoned discovery found, without another spawn.
        const status = yield* toolchain.probe(false);
        expect(status.kind).toBe("latexmk");
        expect((yield* Ref.get(calls)).filter((command) => command === "latexmk")).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never strands discovery, wherever a caller is cancelled", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) =>
        command === "latexmk" ? Effect.succeed(output(LATEXMK_BANNER)) : spawnFailure(command),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        // Interrupt after every number of scheduler turns up to a whole
        // discovery: before it claims, while it runs, after it finished.
        for (let turns = 0; turns < 40; turns += 1) {
          const caller = yield* Effect.forkChild(toolchain.probe(true));
          for (let turn = 0; turn < turns; turn += 1) yield* Effect.yieldNow;
          yield* Fiber.interrupt(caller).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => Effect.die("interrupt hung"),
            }),
          );
          const status = yield* toolchain
            .probe(true)
            .pipe(
              Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("stranded") }),
            );
          expect(status.kind).toBe("latexmk");
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("releases a waiting caller when the service shuts down mid-discovery", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const { layer } = yield* harness((command) =>
        command === "latexmk"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.as(output(LATEXMK_BANNER)),
            )
          : spawnFailure(command),
      );
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, serviceScope);
      const waiting = yield* Effect.forkChild(
        LatexToolchain.use((toolchain) => toolchain.probe(false)).pipe(
          Effect.provideContext(context),
        ),
      );
      yield* Deferred.await(started);
      yield* Scope.close(serviceScope, Exit.void);
      const exit = yield* Fiber.await(waiting).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("still waiting") }),
      );
      // Ended, one way or another, instead of hanging on a worker that is gone.
      expect(Exit.isSuccess(exit)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("releases a waiting caller when the service shuts down before discovery starts", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness((command) =>
        command === "latexmk" ? Effect.succeed(output(LATEXMK_BANNER)) : spawnFailure(command),
      );
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, serviceScope);
      const toolchain = Context.get(context, LatexToolchain);
      const waiting = yield* Effect.forkChild(toolchain.probe(false));
      // One turn: the caller claims discovery and schedules its worker; the
      // scope closes before the worker's first step.
      yield* Effect.yieldNow;
      yield* Scope.close(serviceScope, Exit.void);
      const exit = yield* Fiber.await(waiting).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("still waiting") }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(yield* Ref.get(calls)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("counts the cache's age from when a slow discovery finished", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness((command) =>
        command === "latexmk"
          ? Effect.sleep(Duration.minutes(4)).pipe(Effect.as(output(LATEXMK_BANNER)))
          : spawnFailure(command),
      );
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const first = yield* Effect.forkChild(toolchain.probe(false));
        yield* TestClock.adjust(Duration.minutes(4));
        yield* Fiber.join(first);
        // Two minutes on: six after discovery began, two after it finished.
        yield* TestClock.adjust(Duration.minutes(2));
        yield* toolchain.probe(false);
        expect((yield* Ref.get(calls)).filter((command) => command === "latexmk")).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("follows a relative PATH entry the way spawning by name would", () =>
    Effect.gen(function* () {
      const machine = yield* twoDistributions;
      const path = yield* Path.Path;
      const relative = path.relative(process.cwd(), machine.texlive);
      const { layer } = yield* harness(
        (command) => {
          if (command === "latexmk") return Effect.succeed(failed(MIKTEX_NO_PERL));
          if (command === machine.texliveLatexmk) return Effect.succeed(output(LATEXMK_BANNER));
          return spawnFailure(command);
        },
        { environment: { Path: relative } },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));
      expect(status.executable).toBe(machine.texliveLatexmk);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("redacts the home folder before cutting a long line", () =>
    Effect.gen(function* () {
      const home = "C:\\Users\\Dana Levi";
      // The 240-character cut would fall inside the home folder.
      const line = `${"x".repeat(232)} ${home}\\AppData\\x.log`;
      const { layer } = yield* harness(
        (command) => (command === "latexmk" ? Effect.succeed(failed(line)) : spawnFailure(command)),
        { environment: { Path: "C:\\system", USERPROFILE: home } },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));
      expect(status.unusable?.[0]?.reason).not.toContain("Dana");
      expect(status.unusable?.[0]?.reason).toContain(" ~\\App");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("writes the user's home folder as ~ in what a driver said", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness(
        (command) =>
          command === "latexmk"
            ? Effect.succeed(failed("Cannot open C:\\Users\\Dana Levi\\AppData\\x.log"))
            : spawnFailure(command),
        { environment: { Path: "C:\\system", USERPROFILE: "C:\\Users\\Dana Levi" } },
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));
      expect(status.unusable?.[0]?.reason).toBe("Cannot open ~\\AppData\\x.log");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("latexDriverLabel", () => {
  it("names the distribution and the file, never the folder", () => {
    expect(
      latexDriverLabel(
        "C:\\Users\\Dana\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\latexmk.exe",
      ),
    ).toBe("MiKTeX's latexmk.exe");
    expect(latexDriverLabel("C:\\texlive\\2024\\bin\\windows\\latexmk.exe")).toBe(
      "TeX Live's latexmk.exe",
    );
    expect(latexDriverLabel("/opt/tools/latexmk")).toBe("latexmk");
  });
});

describe("withoutHomeDirectory", () => {
  it("redacts the home folder in either slash style and any case", () => {
    const environment = { USERPROFILE: "C:\\Users\\Dana Levi" };
    expect(
      withoutHomeDirectory("c:/users/dana levi/x and C:\\Users\\Dana Levi\\y", environment),
    ).toBe("~/x and ~\\y");
    expect(withoutHomeDirectory("nothing here", {})).toBe("nothing here");
  });
});
