import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
