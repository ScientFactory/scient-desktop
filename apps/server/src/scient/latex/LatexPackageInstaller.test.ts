import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExecutionProcessError,
  type ExecutionProcessPort,
  type ExecutionProcessRequest,
} from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../processRunner.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import {
  LatexPackageInstaller,
  appendOutputTail,
  clearFailedPackageSearches,
  make,
  owningPackageFromSearch,
  renderOutputTail,
  texliveScriptInvocation,
  unknownPackagesFromInstall,
} from "./LatexPackageInstaller.ts";

const TEXLIVE_ROOT = "/state/latex/managed/tinytex-2026.08-abcd1234/TinyTeX";
const BIN_DIRECTORY = `${TEXLIVE_ROOT}/bin/windows`;
const PERL = `${TEXLIVE_ROOT}/tlpkg/tlperl/bin/perl.exe`;
const TLMGR_SCRIPT = `${TEXLIVE_ROOT}/texmf-dist/scripts/texlive/tlmgr.pl`;

/** `tlmgr search --file` prints the package, then the paths it ships. */
const SEARCH_OUTPUT = [
  "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
  "algorithms:",
  "\ttexmf-dist/tex/latex/algorithms/algorithm.sty",
  "\ttexmf-dist/tex/latex/algorithms/algorithmicx/algpseudocode.sty",
  "algorithmicx:",
  "\ttexmf-dist/tex/latex/algorithmicx/algpseudocode.sty",
].join("\n");

/** One run of a distribution script, as the fake port saw it. */
interface FakeRun {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

interface FakeProcess {
  readonly output?: string;
  readonly exitCode?: number;
  /** Never exits on its own; only a `cancel` ends it. The orphan case. */
  readonly hang?: boolean;
}

/**
 * What `kpsewhich` prints for a list of names: one line per argument, in order,
 * left empty for a name it could not resolve, with the number of failures as
 * the exit status.
 */
const probeOutput = (
  fileNames: ReadonlyArray<string>,
  resolves: (fileName: string) => boolean,
): ProcessRunner.ProcessRunOutput => {
  const lines = fileNames.map((fileName) => (resolves(fileName) ? `/texmf-dist/${fileName}` : ""));
  return {
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(lines.filter((line) => line === "").length),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
};

/**
 * Wires the installer over a fake execution port and a fake probe runner, so a
 * test decides exactly what `tlmgr` and `kpsewhich` answer without a
 * distribution being anywhere on this machine.
 */
const harness = (input: {
  readonly respond?: (args: ReadonlyArray<string>) => Effect.Effect<FakeProcess>;
  /** What `kpsewhich` answers, given the names it was handed and which call this is. */
  readonly probe?: (
    fileNames: ReadonlyArray<string>,
    call: number,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
}) =>
  Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyArray<FakeRun>>([]);
    const started = yield* Queue.unbounded<ExecutionProcessRequest>();
    const cancelCount = yield* Ref.make(0);
    const probes = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);

    const respond: (args: ReadonlyArray<string>) => Effect.Effect<FakeProcess> =
      input.respond ?? (() => Effect.succeed<FakeProcess>({}));
    const port: ExecutionProcessPort = {
      start: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(runs, (previous) => [
            ...previous,
            {
              executable: request.executable,
              args: request.args,
              environment: request.environment,
            },
          ]);
          yield* Queue.offer(started, request);
          const process = yield* respond(request.args);
          const exitSignal = yield* Deferred.make<number>();
          if (process.hang !== true) {
            yield* Deferred.succeed(exitSignal, process.exitCode ?? 0);
          }
          return {
            output: Stream.make({ stream: "stdout" as const, text: process.output ?? "" }),
            exitCode: Deferred.await(exitSignal),
            cancel: Ref.update(cancelCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(exitSignal, 130)),
              Effect.asVoid,
            ),
          };
        }),
    };

    const runner = ProcessRunner.ProcessRunner.of({
      run: (request) =>
        Effect.gen(function* () {
          const fileNames = request.args;
          const call = (yield* Ref.get(probes)).length;
          yield* Ref.update(probes, (previous) => [...previous, fileNames]);
          return yield* (
            input.probe ?? ((names) => Effect.succeed(probeOutput(names, () => true)))
          )(fileNames, call);
        }),
    });

    return {
      layer: Layer.effect(LatexPackageInstaller, make).pipe(
        Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, port)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
      ),
      runs,
      started,
      cancelCount,
      probes,
    };
  });

/** `path.join` spells Windows paths with backslashes; the fixtures do not. */
const posix = (value: string): string => value.replaceAll("\\", "/");

/** Just the `tlmgr` argument list of each run, with the script path dropped. */
const tlmgrArguments = (runs: ReadonlyArray<FakeRun>): ReadonlyArray<ReadonlyArray<string>> =>
  runs.map((run) => (run.executable.endsWith("perl.exe") ? run.args.slice(1) : run.args));

const installing = (input: {
  readonly packages: ReadonlyArray<string>;
  readonly expectedFiles?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const installer = yield* LatexPackageInstaller;
    return yield* installer.install({
      packages: input.packages,
      binDirectory: BIN_DIRECTORY,
      ...(input.expectedFiles === undefined ? {} : { expectedFiles: input.expectedFiles }),
    });
  });

describe("texliveScriptInvocation", () => {
  const join = (...segments: ReadonlyArray<string>) => segments.join("/");
  const dirname = (segment: string) => segment.split("/").slice(0, -1).join("/");

  it("runs the Windows tlmgr as the perl script the shim wraps, never as a .bat", () => {
    // The shim cannot be spawned without a shell, and a shell is a process
    // between Scient and the work: killing it leaves the perl underneath
    // installing into a distribution whose owner has already given up. The
    // wrapper's own body is encoded here instead.
    const invocation = texliveScriptInvocation({
      binDirectory: BIN_DIRECTORY,
      script: "tlmgr",
      args: ["install", "mathtools"],
      platform: "win32",
      join,
      dirname,
      pathDelimiter: ";",
    });

    expect(invocation.executable).toBe(PERL);
    expect(invocation.args).toEqual([TLMGR_SCRIPT, "install", "mathtools"]);
    // `tlmgr.pl` finds its own installation root by looking for the
    // distribution's `bin` on PATH, and loads its modules out of the bundled
    // perl library — both exactly as `tlmgr.bat` sets them up.
    expect(invocation.pathPrefix).toBe(`${TEXLIVE_ROOT}/tlpkg/tlperl/bin;${BIN_DIRECTORY}`);
    expect(invocation.environment).toEqual({ PERL5LIB: `${TEXLIVE_ROOT}/tlpkg/tlperl/lib` });
  });

  it("runs mktexlsr and the POSIX tlmgr as themselves", () => {
    // Only `tlmgr` is a `.bat` on Windows, and only because of a self-update
    // path Scient never asks for.
    expect(
      texliveScriptInvocation({
        binDirectory: BIN_DIRECTORY,
        script: "mktexlsr",
        args: [],
        platform: "win32",
        join,
        dirname,
        pathDelimiter: ";",
      }),
    ).toMatchObject({ executable: `${BIN_DIRECTORY}/mktexlsr.exe`, args: [] });

    expect(
      texliveScriptInvocation({
        binDirectory: "/opt/tinytex/bin/x86_64-linux",
        script: "tlmgr",
        args: ["install", "mathtools"],
        platform: "linux",
        join,
        dirname,
        pathDelimiter: ":",
      }),
    ).toMatchObject({
      executable: "/opt/tinytex/bin/x86_64-linux/tlmgr",
      args: ["install", "mathtools"],
      environment: {},
    });
  });
});

describe("appendOutputTail", () => {
  it("keeps the newest bytes, because the verdict is the last thing tlmgr says", () => {
    const noise = "x".repeat(256 * 1024);
    let state = appendOutputTail({ chunks: [], bytes: 0 }, "tlmgr: package repository …\n");
    for (let chunk = 0; chunk < 4; chunk += 1) state = appendOutputTail(state, noise);
    state = appendOutputTail(state, "tlmgr install: package already present: microtype\n");
    const text = renderOutputTail(state);

    expect(text.endsWith("tlmgr install: package already present: microtype\n")).toBe(true);
    expect(text).not.toContain("package repository");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1024 + noise.length);
  });
});

describe("unknownPackagesFromInstall", () => {
  it("names only the requested packages the repository does not have", () => {
    const transcript = [
      "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
      "tlmgr install: package algorithm not present in repository.",
      "[1/1, ??:??/??:??] install: mathtools [40k]",
    ].join("\n");

    expect(unknownPackagesFromInstall(transcript, ["mathtools", "algorithm"])).toEqual([
      "algorithm",
    ]);
    expect(unknownPackagesFromInstall("", ["mathtools"])).toEqual([]);
  });
});

describe("owningPackageFromSearch", () => {
  it("answers the package that ships a file of that name, not the first listed", () => {
    expect(owningPackageFromSearch(SEARCH_OUTPUT, "algorithm")).toBe("algorithms");
    expect(owningPackageFromSearch(SEARCH_OUTPUT, "algpseudocode")).toBe("algorithms");
    expect(owningPackageFromSearch(SEARCH_OUTPUT, "nothinghere")).toBeNull();
  });
});

describe("LatexPackageInstaller", () => {
  it.effect("installs through the tlmgr inside the managed distribution", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({
        respond: () => Effect.succeed({ output: "install: mathtools [40k]" }),
      });
      const result = yield* installing({ packages: ["mathtools", "mathtools"] }).pipe(
        Effect.provide(layer),
      );

      expect(result).toEqual({ installed: ["mathtools"], failed: [] });
      const [first, ...rest] = yield* Ref.get(runs);
      expect(rest).toEqual([]);
      expect(posix(first?.executable ?? "")).toBe(PERL);
      expect((first?.args ?? []).map(posix)).toEqual([TLMGR_SCRIPT, "install", "mathtools"]);
      // tlmgr drives the same helpers latexmk does, so the distribution's own
      // bin directory has to lead the child's PATH.
      const pathKey = Object.keys(first?.environment ?? {}).find(
        (key) => key.toUpperCase() === "PATH",
      );
      expect(posix(first?.environment[pathKey ?? ""] ?? "")).toContain(BIN_DIRECTORY);
      expect(posix(first?.environment["PERL5LIB"] ?? "")).toBe(`${TEXLIVE_ROOT}/tlpkg/tlperl/lib`);
    }),
  );

  it.effect("tree-kills a tlmgr that outlives its budget rather than leaving it running", () =>
    Effect.gen(function* () {
      // The production failure this closes: `ProcessRunner` had no tree kill,
      // so a slow install lost its shim and kept its perl, which finished the
      // install minutes later — rewriting the distribution's file index
      // underneath a build that had already been told nothing was placed.
      const { layer, started, cancelCount } = yield* harness({
        respond: () => Effect.succeed({ hang: true }),
      });
      const fetching = yield* Effect.forkChild(
        installing({ packages: ["collection-fontsrecommended"] }).pipe(Effect.provide(layer)),
      );
      yield* Queue.take(started);
      yield* TestClock.adjust(Duration.minutes(11));

      expect(yield* Fiber.join(fetching)).toEqual({
        installed: [],
        failed: ["collection-fontsrecommended"],
      });
      // One cancel, through the port, whose kill is the whole process tree.
      expect(yield* Ref.get(cancelCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("only reports a package installed once the engine can find its file", () =>
    Effect.gen(function* () {
      // `tlmgr` unpacks first and rebuilds the file index afterwards, so
      // "finished" and "visible" are two moments. A retry compiled between them
      // fails on exactly the file the round was fetching, from a tree that
      // already has it.
      const { layer, runs, probes } = yield* harness({
        respond: () => Effect.succeed({ output: "install: microtype [280k]" }),
        probe: (fileNames, call) => Effect.succeed(probeOutput(fileNames, () => call > 0)),
      });
      const result = yield* installing({
        packages: ["microtype"],
        expectedFiles: ["microtype.sty"],
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: ["microtype"], failed: [] });
      // The index was rebuilt once, between the two answers, rather than
      // waited on.
      expect((yield* Ref.get(runs)).map((run) => posix(run.executable))).toEqual([
        PERL,
        `${BIN_DIRECTORY}/mktexlsr.exe`,
      ]);
      expect(yield* Ref.get(probes)).toEqual([["microtype.sty"], ["microtype.sty"]]);
    }),
  );

  it.effect("reports a package the engine still cannot see as one it could not place", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({
        respond: () => Effect.succeed({ output: "install: microtype [280k]" }),
        probe: (fileNames) => Effect.succeed(probeOutput(fileNames, () => false)),
      });
      const result = yield* installing({
        packages: ["microtype"],
        expectedFiles: ["microtype.sty"],
      }).pipe(Effect.provide(layer));

      // Nothing became visible, so there is nothing to compile again for and
      // the caller says so rather than looping.
      expect(result).toEqual({ installed: [], failed: ["microtype"] });
      expect((yield* Ref.get(runs)).map((run) => posix(run.executable))).toEqual([
        PERL,
        `${BIN_DIRECTORY}/mktexlsr.exe`,
      ]);
    }),
  );

  it.effect("assumes a file is visible when the probe itself cannot answer", () =>
    Effect.gen(function* () {
      // A distribution whose `kpsewhich` will not run must not be one where
      // nothing is ever visible, or no build could ever recompile.
      const { layer } = yield* harness({
        respond: () => Effect.succeed({ output: "install: microtype [280k]" }),
        probe: () =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "kpsewhich",
              argumentCount: 1,
              cause: new Error("spawn ENOENT"),
            }),
          ),
      });
      const result = yield* installing({
        packages: ["microtype"],
        expectedFiles: ["microtype.sty"],
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: ["microtype"], failed: [] });
    }),
  );

  it.effect("maps a file tlmgr has never heard of onto the package that ships it", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({
        respond: (args) => {
          if (args.includes("search")) return Effect.succeed({ output: SEARCH_OUTPUT });
          return args.includes("algorithm")
            ? Effect.succeed({
                output: "tlmgr install: package algorithm not present in repository.",
                exitCode: 1,
              })
            : Effect.succeed({ output: "install: algorithms [120k]" });
        },
      });
      const result = yield* installing({ packages: ["algorithm"] }).pipe(Effect.provide(layer));

      // `algorithm.sty` comes from `algorithms`; the file search is the only
      // thing that knows that, and it is asked once.
      expect(result).toEqual({ installed: ["algorithms"], failed: [] });
      expect(tlmgrArguments(yield* Ref.get(runs))).toEqual([
        ["install", "algorithm"],
        ["search", "--global", "--file", "/algorithm."],
        ["install", "algorithms"],
      ]);
    }),
  );

  it.effect("reports a package nothing can supply without asking twice", () =>
    Effect.gen(function* () {
      clearFailedPackageSearches();
      const { layer, runs } = yield* harness({
        respond: (args) =>
          args.includes("search")
            ? Effect.succeed({ output: "tlmgr: no results" })
            : Effect.succeed({
                output: "tlmgr install: package nosuchpkg not present in repository.",
              }),
      });
      const install = installing({ packages: ["nosuchpkg"] }).pipe(Effect.provide(layer));

      expect(yield* install).toEqual({ installed: [], failed: ["nosuchpkg"] });
      expect(yield* Ref.get(runs)).toHaveLength(2);

      // The same document, saved again. A name the repository has already
      // disowned is not searched for a second time; only the install attempt
      // that carries it runs.
      expect(yield* install).toEqual({ installed: [], failed: ["nosuchpkg"] });
      expect(yield* Ref.get(runs)).toHaveLength(3);
      clearFailedPackageSearches();
    }),
  );

  it.effect("never lets a name that is not a package name reach argv", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({
        respond: () => Effect.succeed({ output: "install: mathtools [40k]" }),
      });
      // The names come out of a transcript the document wrote.
      const result = yield* installing({
        packages: ["-gui", "foo;bar", "mathtools"],
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: ["mathtools"], failed: ["-gui", "foo;bar"] });
      expect(tlmgrArguments(yield* Ref.get(runs))).toEqual([["install", "mathtools"]]);
    }),
  );

  it.effect("runs nothing at all when no requested name is a package name", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({});
      const result = yield* installing({
        packages: ["--repository=http://evil.example", "..\\..\\etc"],
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({
        installed: [],
        failed: ["--repository=http://evil.example", "..\\..\\etc"],
      });
      expect(yield* Ref.get(runs)).toEqual([]);
    }),
  );

  it.effect("asks about a whole preamble in one probe, not one process per name", () =>
    Effect.gen(function* () {
      // This runs before every compile of a managed build, so a process per
      // package would put a second of spawning in front of every save.
      // `kpsewhich` answers a list positionally: a line per name, empty for one
      // it could not resolve.
      const { layer, probes } = yield* harness({
        probe: (fileNames) =>
          Effect.succeed(probeOutput(fileNames, (fileName) => fileName !== "siunitx.sty")),
      });
      const unresolved = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.unresolvedFiles({
          files: ["amsmath.sty", "siunitx.sty", "booktabs.sty"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      expect(unresolved).toEqual(["siunitx.sty"]);
      expect(yield* Ref.get(probes)).toEqual([["amsmath.sty", "siunitx.sty", "booktabs.sty"]]);
    }),
  );

  it.effect("never lets a file name that is not one reach a probe", () =>
    Effect.gen(function* () {
      const { layer, probes } = yield* harness({});
      const unresolved = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.unresolvedFiles({
          files: ["../../etc/passwd", "-var-value=TEXMFHOME", "mathtools.sty"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      expect(unresolved).toEqual([]);
      // One probe, carrying only the name that is one.
      expect(yield* Ref.get(probes)).toEqual([["mathtools.sty"]]);
    }),
  );

  it.live("runs one tlmgr at a time against the distribution", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const { layer } = yield* harness({
        respond: (args) =>
          Effect.gen(function* () {
            const name = args.at(-1) ?? "";
            yield* Ref.update(events, (previous) => [...previous, `start:${name}`]);
            yield* Effect.sleep(Duration.millis(20));
            yield* Ref.update(events, (previous) => [...previous, `end:${name}`]);
            return { output: `install: ${name}` };
          }),
      });
      yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        yield* Effect.all(
          ["first", "second"].map((packageName) =>
            installer.install({ packages: [packageName], binDirectory: BIN_DIRECTORY }),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer));

      // `tlmgr` writes the distribution's own package database; two of them
      // over one tree is a lock error at best. Neither run overlaps the other.
      const observed = yield* Ref.get(events);
      expect(observed).toHaveLength(4);
      const leader = (observed[0] ?? "").slice("start:".length);
      const follower = leader === "first" ? "second" : "first";
      expect(observed).toEqual([
        `start:${leader}`,
        `end:${leader}`,
        `start:${follower}`,
        `end:${follower}`,
      ]);
    }),
  );

  it.effect("treats a tlmgr that will not start as packages it could not place", () =>
    Effect.gen(function* () {
      const absentPort: ExecutionProcessPort = {
        start: () =>
          Effect.fail(
            new ExecutionProcessError({
              operation: "spawn",
              message: "Unable to start the execution process.",
            }),
          ),
      };
      const layer = Layer.effect(LatexPackageInstaller, make).pipe(
        Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, absentPort)),
        Layer.provide(
          Layer.succeed(
            ProcessRunner.ProcessRunner,
            ProcessRunner.ProcessRunner.of({
              run: (request) => Effect.succeed(probeOutput(request.args, () => false)),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
      );

      // A distribution without a tlmgr leaves the build the error it had.
      expect(yield* installing({ packages: ["mathtools"] }).pipe(Effect.provide(layer))).toEqual({
        installed: [],
        failed: ["mathtools"],
      });
    }),
  );

  it.effect("never runs anything for an empty request", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness({});
      const result = yield* installing({ packages: [] }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: [], failed: [] });
      expect(yield* Ref.get(runs)).toEqual([]);
    }),
  );
});
