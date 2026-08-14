import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../processRunner.ts";
import {
  LatexPackageInstaller,
  clearFailedPackageSearches,
  make,
  owningPackageFromSearch,
  unknownPackagesFromInstall,
} from "./LatexPackageInstaller.ts";

const BIN_DIRECTORY = "/state/latex/managed/tinytex-2026.08-abcd1234/TinyTeX/bin/windows";

const output = (input: {
  readonly stdout?: string;
  readonly code?: number;
  readonly timedOut?: boolean;
}): ProcessRunner.ProcessRunOutput => ({
  stdout: input.stdout ?? "",
  stderr: "",
  code: input.timedOut === true ? null : ChildProcessSpawner.ExitCode(input.code ?? 0),
  timedOut: input.timedOut ?? false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** `tlmgr search --file` prints the package, then the paths it ships. */
const SEARCH_OUTPUT = [
  "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet",
  "algorithms:",
  "\ttexmf-dist/tex/latex/algorithms/algorithm.sty",
  "\ttexmf-dist/tex/latex/algorithms/algorithmic.sty",
  "algorithmicx:",
  "\ttexmf-dist/tex/latex/algorithmicx/algpseudocode.sty",
].join("\n");

interface FakeRun {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
}

/**
 * Wires the installer over a fake runner, so a test decides exactly what
 * `tlmgr` answers without a distribution being anywhere on this machine.
 */
const harness = (
  respond: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyArray<FakeRun>>([]);
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(runs, (previous) => [
          ...previous,
          { command: input.command, args: input.args, env: input.env },
        ]).pipe(Effect.andThen(respond(input.args))),
    });
    return {
      layer: Layer.effect(LatexPackageInstaller, make).pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
      ),
      runs,
    };
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
    expect(owningPackageFromSearch(SEARCH_OUTPUT, "algpseudocode")).toBe("algorithmicx");
    expect(owningPackageFromSearch(SEARCH_OUTPUT, "nothinghere")).toBeNull();
  });
});

describe("LatexPackageInstaller", () => {
  it.effect("installs through the tlmgr inside the managed distribution", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness(() =>
        Effect.succeed(output({ stdout: "install: mathtools [40k]" })),
      );
      const result = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({
          packages: ["mathtools", "mathtools"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: ["mathtools"], failed: [] });
      const [first, ...rest] = yield* Ref.get(runs);
      expect(rest).toEqual([]);
      // Windows ships tlmgr as a shim beside the engine; ProcessRunner is what
      // knows a `.bat` has to run through the shell.
      expect(first?.command.replaceAll("\\", "/")).toBe(`${BIN_DIRECTORY}/tlmgr.bat`);
      expect(first?.args).toEqual(["install", "mathtools"]);
      // tlmgr drives the same helpers latexmk does, so the distribution's own
      // bin directory has to lead the child's PATH.
      const pathKey = Object.keys(first?.env ?? {}).find((key) => key.toUpperCase() === "PATH");
      expect(first?.env?.[pathKey ?? ""]).toContain(BIN_DIRECTORY);
    }),
  );

  it.effect("maps a file tlmgr has never heard of onto the package that ships it", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness((args) => {
        if (args[0] === "search") return Effect.succeed(output({ stdout: SEARCH_OUTPUT }));
        return args.includes("algorithm")
          ? Effect.succeed(
              output({
                stdout: "tlmgr install: package algorithm not present in repository.",
                code: 1,
              }),
            )
          : Effect.succeed(output({ stdout: "install: algorithms [120k]" }));
      });
      const result = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({
          packages: ["algorithm"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      // `algorithm.sty` comes from `algorithms`; the file search is the only
      // thing that knows that, and it is asked once.
      expect(result).toEqual({ installed: ["algorithms"], failed: [] });
      expect((yield* Ref.get(runs)).map((run) => run.args)).toEqual([
        ["install", "algorithm"],
        ["search", "--global", "--file", "/algorithm."],
        ["install", "algorithms"],
      ]);
    }),
  );

  it.effect("reports a package nothing can supply without asking twice", () =>
    Effect.gen(function* () {
      clearFailedPackageSearches();
      const { layer, runs } = yield* harness((args) =>
        args[0] === "search"
          ? Effect.succeed(output({ stdout: "tlmgr: no results" }))
          : Effect.succeed(
              output({ stdout: "tlmgr install: package nosuchpkg not present in repository." }),
            ),
      );
      const install = Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({
          packages: ["nosuchpkg"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

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
      const { layer, runs } = yield* harness(() =>
        Effect.succeed(output({ stdout: "install: mathtools [40k]" })),
      );
      const result = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({
          // The names come out of a transcript the document wrote.
          packages: ["-gui", "foo;bar", "mathtools"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: ["mathtools"], failed: ["-gui", "foo;bar"] });
      expect((yield* Ref.get(runs)).map((run) => run.args)).toEqual([["install", "mathtools"]]);
    }),
  );

  it.effect("runs nothing at all when no requested name is a package name", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness(() => Effect.succeed(output({})));
      const result = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({
          packages: ["--repository=http://evil.example", "..\\..\\etc"],
          binDirectory: BIN_DIRECTORY,
        });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({
        installed: [],
        failed: ["--repository=http://evil.example", "..\\..\\etc"],
      });
      expect(yield* Ref.get(runs)).toEqual([]);
    }),
  );

  it.live("runs one tlmgr at a time against the distribution", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const { layer } = yield* harness((args) =>
        Effect.gen(function* () {
          const name = args[1] ?? "";
          yield* Ref.update(events, (previous) => [...previous, `start:${name}`]);
          yield* Effect.sleep(Duration.millis(20));
          yield* Ref.update(events, (previous) => [...previous, `end:${name}`]);
          return output({ stdout: `install: ${name}` });
        }),
      );
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

  it.effect("routes the Windows tlmgr shim through the shell with escaped arguments", () =>
    Effect.gen(function* () {
      // Not a test of this module's own code: it pins the inherited helper
      // `ProcessRunner` resolves through, because a `.bat` that stops being
      // routed to the shell is a managed install that silently cannot fetch
      // anything on Windows.
      const routed = yield* resolveSpawnCommand(
        `${BIN_DIRECTORY}/tlmgr.bat`,
        ["install", "mathtools"],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(routed.shell).toBe(true);
      expect(routed.command).toContain("tlmgr.bat");
      expect(routed.args).toEqual(['^"install^"', '^"mathtools^"']);
    }),
  );

  it.effect("treats a timed-out or unspawnable tlmgr as packages it could not place", () =>
    Effect.gen(function* () {
      const timedOut = yield* harness(() => Effect.succeed(output({ timedOut: true })));
      const install = (layer: Layer.Layer<LatexPackageInstaller>) =>
        Effect.gen(function* () {
          const installer = yield* LatexPackageInstaller;
          return yield* installer.install({
            packages: ["mathtools"],
            binDirectory: BIN_DIRECTORY,
          });
        }).pipe(Effect.provide(layer));

      expect(yield* install(timedOut.layer)).toEqual({ installed: [], failed: ["mathtools"] });

      const absent = yield* harness((args) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "tlmgr.bat",
            argumentCount: args.length,
            cause: new Error("spawn ENOENT"),
          }),
        ),
      );
      // A distribution without a tlmgr leaves the build the error it had.
      expect(yield* install(absent.layer)).toEqual({ installed: [], failed: ["mathtools"] });
    }),
  );

  it.effect("never runs anything for an empty request", () =>
    Effect.gen(function* () {
      const { layer, runs } = yield* harness(() => Effect.succeed(output({})));
      const result = yield* Effect.gen(function* () {
        const installer = yield* LatexPackageInstaller;
        return yield* installer.install({ packages: [], binDirectory: BIN_DIRECTORY });
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({ installed: [], failed: [] });
      expect(yield* Ref.get(runs)).toEqual([]);
    }),
  );
});
