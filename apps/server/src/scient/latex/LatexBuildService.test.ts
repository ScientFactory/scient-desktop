import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import type { ExecutionProcessPort, ExecutionProcessRequest } from "@scientfactory/execution";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ScientLatexToolchainStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GeneratedDocumentStore,
  layer as storeLayer,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import {
  LatexBuildService,
  type LatexBuildInput,
  appendBoundedTranscript,
  emptyTranscript,
  escapesWorkspaceRoot,
  make as makeBuildService,
  renderTranscript,
} from "./LatexBuildService.ts";
import {
  LatexPackageInstaller,
  type LatexPackageInstallInput,
  type LatexPackageInstallResult,
} from "./LatexPackageInstaller.ts";
import { LatexToolchain } from "./LatexToolchain.ts";

/** Byte-for-byte the fixture shape the document store's own tests accept. */
function minimalPdf(marker: string): Uint8Array {
  const stream = `% ${marker}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const authority = EnvironmentId.make("environment-scient-latex-test");
const serverEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(authority),
    getDescriptor: Effect.die("unused environment descriptor"),
  }),
);

const LATEXMK: ScientLatexToolchainStatus = {
  kind: "latexmk",
  executable: "latexmk",
  version: "4.79",
  probedAtEpochMs: 0,
};
/** What the probe reports once Scient has installed a distribution itself. */
const MANAGED_LATEXMK: ScientLatexToolchainStatus = {
  kind: "latexmk",
  executable: "/state/userdata/latex/managed/tinytex-2026.08/TinyTeX/bin/windows/latexmk.exe",
  version: "4.88",
  probedAtEpochMs: 0,
  source: "scient-managed",
};
const NO_TOOLCHAIN: ScientLatexToolchainStatus = {
  kind: null,
  executable: null,
  version: null,
  probedAtEpochMs: 0,
};

const TERMINAL_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

const SOURCE = "\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n";
const WARNING_TRANSCRIPT =
  "This is pdfTeX\nLaTeX Warning: Reference `fig:1' undefined on input line 12.\n";
const ERROR_TRANSCRIPT = "./main.tex:12: Undefined control sequence.\nl.12 \\nosuchmacro\n";

/** What a base TinyTeX prints for the first document that uses `mathtools`. */
const missingPackageTranscript = (packageName: string) =>
  [
    "This is pdfTeX, Version 3.141592653-2.6-1.40.26",
    `./main.tex:3: LaTeX Error: File \`${packageName}.sty' not found.`,
    "",
    "! Emergency stop.",
    "",
  ].join("\n");

/**
 * What `latexmk` prints — verbatim, from the machine this was diagnosed on —
 * when it declines to redo a target whose last run failed. Nothing in it is
 * `file:line:` shaped, starts with `!`, or names a missing file, so a build
 * that only reads TeX-shaped lines reads this run as having said nothing.
 */
const REFUSED_RERUN_TRANSCRIPT = [
  "Initial Win CP for (console input, console output, system): (CP437, CP437, CP1252)",
  "Rc files read (in order):",
  "  NONE",
  "Latexmk: This is Latexmk, John Collins, 9 March 2026. Version 4.88.",
  "Latexmk: Nothing to do for 'C:/work/paper/main.tex'.",
  "Latexmk: All targets (C:/state/builds/abc/main.pdf) are up-to-date",
  "Collected error summary (may duplicate other messages):",
  "  pdflatex: gave an error in previous invocation of latexmk.",
  "",
  "Reverting Windows console CPs to (in,out) = (437,437)",
  "C:/state/TinyTeX/bin/windows/runscript.tlu:933: command failed with exit code 12:",
  "perl.exe c:\\state\\TinyTeX\\texmf-dist\\scripts\\latexmk\\latexmk.pl -pdf C:/work/paper/main.tex",
].join("\n");

/** A preamble that wants more than one package the distribution does not carry. */
const MULTI_PACKAGE_SOURCE = [
  "\\documentclass{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage{mathtools,siunitx}",
  "% \\usepackage{neverwanted}",
  "\\input{sections/intro}",
  "\\begin{document}",
  "hello",
  "\\end{document}",
  "",
].join("\n");

interface FakeCompile {
  readonly transcript: string;
  readonly exitCode: number;
  /** Written into the engine's `-outdir` just before the process exits. */
  readonly pdf: Uint8Array | null;
  /** When present the process only exits once the test resolves it. */
  readonly hold?: Deferred.Deferred<void>;
}

function outputDirectory(request: ExecutionProcessRequest): string {
  const flag = request.args.find((argument) => argument.startsWith("-outdir="));
  return flag === undefined ? "" : flag.slice("-outdir=".length);
}

/** Mirrors `buildLatexInvocation`'s own PDF path so the fake writes where the service looks. */
function producedPdfPath(request: ExecutionProcessRequest): string {
  const root = (request.args.at(-1) ?? "").replaceAll("\\", "/");
  const baseName = (root.split("/").at(-1) ?? root).replace(/\.\w+$/u, "");
  return `${outputDirectory(request)}/${baseName}.pdf`;
}

const makeHarness = (input: {
  readonly compiles: ReadonlyArray<FakeCompile>;
  readonly toolchain?: ScientLatexToolchainStatus;
  /** Extra sources, keyed by workspace-relative posix path. */
  readonly files?: Readonly<Record<string, string>>;
  /** The document `buildInput` points at; defaults to the root-level `main.tex`. */
  readonly relativePath?: string;
  /** Everything asked for is placed unless a test says otherwise. */
  readonly install?: (
    request: LatexPackageInstallInput,
  ) => Effect.Effect<LatexPackageInstallResult>;
  /**
   * Files this distribution cannot find, lowercased. Everything else resolves,
   * which is what keeps a document whose preamble is already satisfied from
   * fetching anything.
   */
  readonly missingFiles?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-latex-workspace-",
    });
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-state-" });
    yield* fileSystem.writeFileString(path.join(workspaceRoot, "main.tex"), SOURCE);
    for (const [relativePath, contents] of Object.entries(input.files ?? {})) {
      const absolutePath = path.join(workspaceRoot, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fileSystem.writeFileString(absolutePath, contents);
    }

    const started = yield* Queue.unbounded<ExecutionProcessRequest>();
    const startCount = yield* Ref.make(0);
    const cancelCount = yield* Ref.make(0);
    const pending = yield* Ref.make<ReadonlyArray<FakeCompile>>(input.compiles);

    const port: ExecutionProcessPort = {
      start: (request) =>
        Effect.gen(function* () {
          const compile = yield* Ref.modify(pending, (compiles) => {
            const next = compiles[0];
            return next === undefined
              ? ([null, compiles] as const)
              : ([next, compiles.slice(1)] as const);
          });
          if (compile === null) return yield* Effect.die("the fake engine ran out of compiles");
          yield* Ref.update(startCount, (count) => count + 1);
          yield* Queue.offer(started, request);
          const exitSignal = yield* Deferred.make<number>();
          const finish = Effect.gen(function* () {
            if (compile.pdf !== null) {
              yield* fileSystem.makeDirectory(outputDirectory(request), { recursive: true });
              yield* fileSystem.writeFile(producedPdfPath(request), compile.pdf);
            }
            yield* Deferred.succeed(exitSignal, compile.exitCode);
          }).pipe(Effect.orDie);
          if (compile.hold === undefined) {
            yield* finish;
          } else {
            yield* Effect.forkScoped(Deferred.await(compile.hold).pipe(Effect.andThen(finish)));
          }
          return {
            output: Stream.make({ stream: "stdout" as const, text: compile.transcript }),
            exitCode: Deferred.await(exitSignal),
            cancel: Ref.update(cancelCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(exitSignal, 130)),
              Effect.asVoid,
            ),
          };
        }),
    };

    const installRequests = yield* Queue.unbounded<LatexPackageInstallInput>();
    const installCount = yield* Ref.make(0);
    // What the distribution cannot find. An install places the files it was
    // asked for, so a name fetched once stops being missing — which is what
    // lets a test watch the upfront batch and the reactive loop interact.
    const missingFiles = yield* Ref.make(
      new Set((input.missingFiles ?? []).map((file) => file.toLowerCase())),
    );
    const installer = LatexPackageInstaller.of({
      install: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(installCount, (count) => count + 1);
          yield* Queue.offer(installRequests, request);
          const outcome = yield* (
            input.install ?? ((asked) => Effect.succeed({ installed: asked.packages, failed: [] }))
          )(request);
          yield* Ref.update(missingFiles, (files) => {
            const next = new Set(files);
            for (const packageName of outcome.installed)
              next.delete(`${packageName.toLowerCase()}.sty`);
            return next;
          });
          return outcome;
        }),
      unresolvedFiles: (request) =>
        Ref.get(missingFiles).pipe(
          Effect.map((files) => request.files.filter((file) => files.has(file.toLowerCase()))),
        ),
    });

    const serviceLayer = Layer.effect(LatexBuildService, makeBuildService).pipe(
      Layer.provide(Layer.succeed(LatexPackageInstaller, installer)),
      Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, port)),
      Layer.provide(
        Layer.succeed(
          LatexToolchain,
          LatexToolchain.of({ probe: () => Effect.succeed(input.toolchain ?? LATEXMK) }),
        ),
      ),
      Layer.provideMerge(storeLayer.pipe(Layer.provide(serverEnvironment))),
      Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    return {
      serviceLayer,
      started,
      startCount,
      cancelCount,
      installRequests,
      installCount,
      workspaceRoot,
      inputFor: (relativePath: string): LatexBuildInput => ({ workspaceRoot, relativePath }),
      buildInput: {
        workspaceRoot,
        relativePath: input.relativePath ?? "main.tex",
      } satisfies LatexBuildInput,
    };
  });

const awaitTerminal = (service: LatexBuildService["Service"], input: LatexBuildInput) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const snapshot = yield* service.status(input);
      if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* service.status(input);
  });

describe("LatexBuildService", () => {
  it.live("leads the compiler's PATH with the distribution Scient installed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const harness = yield* makeHarness({
        compiles: [{ transcript: "", exitCode: 0, pdf: minimalPdf("managed") }],
        toolchain: MANAGED_LATEXMK,
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const request = yield* Queue.take(harness.started);

        expect(request.executable).toBe(MANAGED_LATEXMK.executable);
        // latexmk drives pdflatex and biber by name, so the distribution's own
        // bin directory has to lead the child's PATH or none of them resolve.
        const pathKey = Object.keys(request.environment ?? {}).find(
          (key) => key.toUpperCase() === "PATH",
        );
        expect(pathKey).toBeDefined();
        expect(request.environment?.[pathKey ?? ""]).toContain(
          path.dirname(MANAGED_LATEXMK.executable ?? ""),
        );
        // The TeX wrapping knobs survive the addition.
        expect(request.environment).toMatchObject({ max_print_line: "1000" });

        yield* awaitTerminal(service, harness.buildInput);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("installs a package the managed distribution was missing and compiles again", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          { transcript: missingPackageTranscript("mathtools"), exitCode: 1, pdf: null },
          { transcript: "", exitCode: 0, pdf: minimalPdf("resolved") },
        ],
        install: (request) =>
          Deferred.await(hold).pipe(Effect.as({ installed: request.packages, failed: [] })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const asked = yield* Queue.take(harness.installRequests);

        expect(asked.packages).toEqual(["mathtools"]);
        // tlmgr lives beside the engine inside the distribution Scient placed.
        expect(asked.binDirectory).toBe(path.dirname(MANAGED_LATEXMK.executable ?? ""));

        // The fetch is not a state of its own: the build is still running, and
        // the snapshot says what it is waiting for so the strip can too.
        const waiting = yield* service.status(harness.buildInput);
        expect(waiting.state).toBe("running");
        expect(waiting.installingPackages).toEqual(["mathtools"]);

        yield* Deferred.succeed(hold, undefined);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(finished.installingPackages).toBeUndefined();
        expect(finished.descriptor).toMatchObject({ bindingStatus: "current" });
        expect(yield* Ref.get(harness.startCount)).toBe(2);
        expect(yield* Ref.get(harness.installCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("fetches everything the preamble names in one round before compiling at all", () =>
    Effect.gen(function* () {
      // The reactive resolver can only learn one name per compile, because
      // LaTeX stops at the first input it cannot find. A first build of an
      // ordinary paper would therefore spend a compile and a tlmgr run per
      // package; the preamble already said all of it.
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        files: {
          "main.tex": MULTI_PACKAGE_SOURCE,
          "sections/intro.tex": "\\usepackage{booktabs}\nThe introduction.\n",
        },
        // `inputenc` is in every base distribution; the other three are not.
        missingFiles: ["mathtools.sty", "siunitx.sty", "booktabs.sty"],
        compiles: [{ transcript: "", exitCode: 0, pdf: minimalPdf("batched") }],
        install: (request) =>
          Deferred.await(hold).pipe(Effect.as({ installed: request.packages, failed: [] })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const asked = yield* Queue.take(harness.installRequests);

        // One invocation, every name, including the one a chapter asked for.
        expect(asked.packages).toEqual(["mathtools", "siunitx", "booktabs"]);
        expect(asked.expectedFiles).toEqual(["mathtools.sty", "siunitx.sty", "booktabs.sty"]);
        // The strip names all of them, so a first build reads as progress
        // rather than as a stall, and nothing has compiled yet.
        const waiting = yield* service.status(harness.buildInput);
        expect(waiting.state).toBe("running");
        expect(waiting.installingPackages).toEqual(["mathtools", "siunitx", "booktabs"]);
        expect(yield* Ref.get(harness.startCount)).toBe(0);

        yield* Deferred.succeed(hold, undefined);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(yield* Ref.get(harness.installCount)).toBe(1);
        // One compile, not four.
        expect(yield* Ref.get(harness.startCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("fetches nothing upfront for a preamble this distribution already satisfies", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        files: { "main.tex": MULTI_PACKAGE_SOURCE },
        compiles: [{ transcript: "", exitCode: 0, pdf: minimalPdf("nothing-to-do") }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("succeeded");
        // Every name resolved, so the scan cost a few probes and no fetch.
        expect(yield* Ref.get(harness.installCount)).toBe(0);
        expect(yield* Ref.get(harness.startCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("still resolves reactively what only a compile could have revealed", () =>
    Effect.gen(function* () {
      // `mathtools` loads `mhsetup`; no preamble mentions it, and only the
      // compile that gets that far can say so.
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        files: { "main.tex": MULTI_PACKAGE_SOURCE },
        missingFiles: ["mathtools.sty"],
        compiles: [
          { transcript: missingPackageTranscript("mhsetup"), exitCode: 1, pdf: null },
          { transcript: "", exitCode: 0, pdf: minimalPdf("transitive") },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const upfront = yield* Queue.take(harness.installRequests);
        expect(upfront.packages).toEqual(["mathtools"]);

        const reactive = yield* Queue.take(harness.installRequests);
        expect(reactive.packages).toEqual(["mhsetup"]);
        // The reactive round carries the file the compile actually stopped on.
        expect(reactive.expectedFiles).toEqual(["mhsetup.sty"]);

        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(yield* Ref.get(harness.startCount)).toBe(2);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never recompiles for a fetch whose files the engine still cannot see", () =>
    Effect.gen(function* () {
      // `tlmgr` unpacks first and rebuilds the file index afterwards. The
      // installer holds the round to what is visible; a caller that trusted
      // "installed" would compile against a tree that has the bytes and not
      // the index, and fail on the very file it just fetched.
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [{ transcript: missingPackageTranscript("microtype"), exitCode: 1, pdf: null }],
        install: (request) => Effect.succeed({ installed: [], failed: request.packages }),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("failed");
        expect(yield* Ref.get(harness.installCount)).toBe(1);
        // No retry against a half-registered tree.
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        expect(finished.diagnostics.at(-1)?.message).toContain(
          "Scient tried to install 'microtype'",
        );
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("keeps fetching one package per compile until the document builds", () =>
    Effect.gen(function* () {
      // LaTeX stops at the first input it cannot find, so a preamble missing
      // five packages reveals them one compile at a time. A document like this
      // is the ordinary case, not the pathological one.
      const revealed = ["mathtools", "comment", "siunitx", "booktabs", "microtype"];
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          ...revealed.map((packageName) => ({
            transcript: missingPackageTranscript(packageName),
            exitCode: 1,
            pdf: null,
          })),
          { transcript: "", exitCode: 0, pdf: minimalPdf("resolved") },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("succeeded");
        expect(finished.descriptor).toMatchObject({ bindingStatus: "current" });
        expect(yield* Ref.get(harness.installCount)).toBe(revealed.length);
        expect(yield* Ref.get(harness.startCount)).toBe(revealed.length + 1);
        const asked: ReadonlyArray<string>[] = [];
        for (let round = 0; round < revealed.length; round += 1) {
          asked.push([...(yield* Queue.take(harness.installRequests)).packages]);
        }
        // One name per round is what the engine gave the resolver to work with.
        expect(asked).toEqual(revealed.map((packageName) => [packageName]));
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("stops at the round ceiling for a document that never stops revealing", () =>
    Effect.gen(function* () {
      // `MAX_PACKAGE_RESOLUTION_ROUNDS` rounds, then the engine's own error
      // stands: the ceiling is above any real preamble, but it is still there.
      const revealed = Array.from({ length: 16 }, (_unused, index) => `pkg${String(index)}`);
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: revealed.map((packageName) => ({
          transcript: missingPackageTranscript(packageName),
          exitCode: 1,
          pdf: null,
        })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("failed");
        expect(yield* Ref.get(harness.installCount)).toBe(15);
        expect(yield* Ref.get(harness.startCount)).toBe(16);
        expect(finished.failureSummary).toContain("pkg15.sty");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("says so when its own distribution could not place the package", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [{ transcript: missingPackageTranscript("mathtools"), exitCode: 1, pdf: null }],
        // Offline, a repository that has moved on, or a name no repository ever
        // had: from here they all look like this.
        install: (request) => Effect.succeed({ installed: [], failed: request.packages }),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("failed");
        // Nothing landed, so there was nothing to compile again for.
        expect(yield* Ref.get(harness.installCount)).toBe(1);
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        // The engine's own error is kept; the managed wording joins it.
        expect(finished.diagnostics[0]).toMatchObject({ file: "main.tex", line: 3 });
        expect(finished.diagnostics.at(-1)).toMatchObject({
          severity: "error",
          file: null,
          message:
            "Scient tried to install 'mathtools' automatically and could not. If this is your own file, check its path; otherwise retry when online.",
        });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never fetches anything for a compile that exited clean with a PDF", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          {
            // A rerun resolved this itself; the line survives in the transcript.
            transcript: [
              "! LaTeX Error: File `mathtools.sty' not found.",
              "Output written on main.pdf (3 pages).",
            ].join("\n"),
            exitCode: 0,
            pdf: minimalPdf("clean"),
          },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("succeeded");
        // A working document pays nothing for the resolver.
        expect(yield* Ref.get(harness.installCount)).toBe(0);
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        expect(
          finished.diagnostics.some((diagnostic) =>
            diagnostic.message.startsWith("Scient tried to install"),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("leaves the rebuild alone when a cancelled build's fetch finally returns", () =>
    Effect.gen(function* () {
      const fetching = yield* Deferred.make<void>();
      const rebuildCompile = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          { transcript: missingPackageTranscript("mathtools"), exitCode: 1, pdf: null },
          { transcript: "", exitCode: 0, pdf: minimalPdf("rebuild"), hold: rebuildCompile },
        ],
        install: (request) =>
          Deferred.await(fetching).pipe(Effect.as({ installed: request.packages, failed: [] })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);
        yield* Queue.take(harness.installRequests);

        // Cancelling leaves that fiber asleep inside the installer.
        expect((yield* service.cancel(harness.buildInput)).state).toBe("cancelled");
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);
        expect(yield* Ref.get(harness.startCount)).toBe(2);

        // It wakes into a document that has moved on, and has nothing to say
        // about it: no second compile, no writes over the live build's state.
        yield* Deferred.succeed(fetching, undefined);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* Effect.sleep(Duration.millis(10));
          expect(yield* Ref.get(harness.startCount)).toBe(2);
          const running = yield* service.status(harness.buildInput);
          expect(running.state).toBe("running");
          expect(running.installingPackages).toBeUndefined();
        }

        yield* Deferred.succeed(rebuildCompile, undefined);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(finished.descriptor).toMatchObject({ bindingStatus: "current" });
        expect(yield* Ref.get(harness.startCount)).toBe(2);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never asks twice for a package one build has already tried", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          { transcript: missingPackageTranscript("nosuchpkg"), exitCode: 1, pdf: null },
          { transcript: missingPackageTranscript("nosuchpkg"), exitCode: 1, pdf: null },
        ],
        // A repository can answer "installed" for something that does not fix
        // the build; the document must still stop asking.
        install: (request) => Effect.succeed({ installed: request.packages, failed: [] }),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("failed");
        expect(yield* Ref.get(harness.installCount)).toBe(1);
        expect(yield* Ref.get(harness.startCount)).toBe(2);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("names the package for a TeX installation Scient does not own", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [{ transcript: missingPackageTranscript("mathtools"), exitCode: 1, pdf: null }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        expect(finished.state).toBe("failed");
        // A system TeX Live or MiKTeX belongs to the user; Scient says which
        // package is missing instead of reaching into it.
        expect(yield* Ref.get(harness.installCount)).toBe(0);
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        expect(finished.diagnostics[0]).toMatchObject({ file: "main.tex", line: 3 });
        expect(finished.diagnostics.at(-1)).toMatchObject({
          severity: "error",
          file: null,
          message:
            "Missing LaTeX package 'mathtools'. Install it with your TeX distribution (tlmgr install mathtools, or the MiKTeX Console), then rebuild.",
        });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("stays cancelled when the cancel lands while packages are installing", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          { transcript: missingPackageTranscript("mathtools"), exitCode: 1, pdf: null },
          { transcript: "", exitCode: 0, pdf: minimalPdf("never-runs") },
        ],
        install: (request) =>
          Deferred.await(hold).pipe(Effect.as({ installed: request.packages, failed: [] })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.installRequests);

        const cancelled = yield* service.cancel(harness.buildInput);
        expect(cancelled.state).toBe("cancelled");
        expect(cancelled.installingPackages).toBeUndefined();

        yield* Deferred.succeed(hold, undefined);
        const settled = yield* awaitTerminal(service, harness.buildInput);
        expect(settled.state).toBe("cancelled");
        // The retry the fetch was for never happens.
        expect(yield* Ref.get(harness.startCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("publishes the produced PDF and keeps warnings from a successful compile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [{ transcript: WARNING_TRANSCRIPT, exitCode: 0, pdf: minimalPdf("build-a") }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        const queued = yield* service.requestBuild(harness.buildInput);
        expect(queued.rootRelativePath).toBe("main.tex");
        expect(queued.logicalDocumentKey.startsWith("latex:")).toBe(true);
        expect(queued.toolchain?.kind).toBe("latexmk");

        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.failureSummary).toBeNull();
        expect(finished.state).toBe("succeeded");
        expect(finished.pendingRerun).toBe(false);
        expect(finished.descriptor).toMatchObject({
          _tag: "generated-pdf",
          bindingStatus: "current",
          fileName: "main.pdf",
        });
        expect(finished.diagnostics).toEqual([
          {
            severity: "warning",
            file: null,
            line: 12,
            message: "Reference `fig:1' undefined on input line 12.",
          },
        ]);

        const bound = yield* store.getDescriptor(
          LogicalDocumentKey.make(finished.logicalDocumentKey),
        );
        expect(bound).toMatchObject({ bindingStatus: "current", bindingGeneration: 1 });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("compiles a subdirectory root from its own directory and rebases its diagnostics", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const harness = yield* makeHarness({
        relativePath: "paper/main.tex",
        files: {
          "paper/main.tex": SOURCE,
          "paper/sections/intro.tex": "intro\n",
        },
        compiles: [
          {
            // Printed the way the engine prints it: relative to its own cwd.
            transcript: [
              "./sections/intro.tex:7: Undefined control sequence.",
              "l.7 \\nosuchmacro",
              "",
              "/opt/texlive/tex/latex/base/article.cls:11: Package error.",
              "",
            ].join("\n"),
            exitCode: 0,
            pdf: minimalPdf("build-sub"),
          },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const request = yield* Queue.take(harness.started);
        // `\input{sections/intro}` only resolves when TeX runs from `paper/`.
        expect(request.cwd).toBe(path.join(harness.workspaceRoot, "paper"));
        // Without these TeX hard-wraps its own messages at 79 columns.
        expect(request.environment).toMatchObject({
          max_print_line: "1000",
          error_line: "254",
          half_error_line: "238",
        });

        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(finished.rootRelativePath).toBe("paper/main.tex");
        // Clients only understand workspace-relative paths.
        expect(finished.diagnostics[0]).toMatchObject({
          severity: "error",
          file: "paper/sections/intro.tex",
          line: 7,
        });
        // A path outside the workspace keeps its message and loses its file.
        expect(finished.diagnostics[1]).toMatchObject({ severity: "error", file: null, line: 11 });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("publishes a PDF the engine produced despite errors, keeping the errors", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [{ transcript: ERROR_TRANSCRIPT, exitCode: 1, pdf: minimalPdf("partial") }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);

        // Overleaf parity: the reader gets the PDF, the editor gets the errors.
        expect(finished.state).toBe("succeeded");
        expect(finished.failureSummary).toBeNull();
        expect(finished.diagnostics[0]).toMatchObject({
          severity: "error",
          file: "main.tex",
          line: 12,
        });
        expect(finished.descriptor).toMatchObject({
          _tag: "generated-pdf",
          bindingStatus: "current",
        });
        const bound = yield* store.getDescriptor(
          LogicalDocumentKey.make(finished.logicalDocumentKey),
        );
        expect(bound).toMatchObject({ bindingStatus: "current", bindingGeneration: 1 });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("marks the binding stale with parsed diagnostics when the engine exits non-zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a") },
          { transcript: ERROR_TRANSCRIPT, exitCode: 1, pdf: null },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const succeeded = yield* awaitTerminal(service, harness.buildInput);
        expect(succeeded.state).toBe("succeeded");
        const publishedRevision =
          succeeded.descriptor?._tag === "generated-pdf" ? succeeded.descriptor.revisionId : null;
        expect(publishedRevision).not.toBeNull();

        yield* service.requestBuild(harness.buildInput);
        const failed = yield* awaitTerminal(service, harness.buildInput);
        expect(failed.state).toBe("failed");
        expect(failed.diagnostics[0]).toMatchObject({
          severity: "error",
          file: "main.tex",
          line: 12,
        });
        expect(failed.failureSummary).toContain("main.tex:12:");
        // The last good PDF survives its failed successor, flagged stale.
        expect(failed.descriptor).toMatchObject({
          revisionId: publishedRevision,
          bindingStatus: "stale",
          staleReason: failed.failureSummary,
        });
        const bound = yield* store.getDescriptor(
          LogicalDocumentKey.make(failed.logicalDocumentKey),
        );
        expect(bound).toMatchObject({ bindingStatus: "stale", revisionId: publishedRevision });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("coalesces rebuilds requested while one is running into a single rerun", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a"), hold },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-b") },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        const second = yield* service.requestBuild(harness.buildInput);
        expect(second.pendingRerun).toBe(true);
        const third = yield* service.requestBuild(harness.buildInput);
        expect(third.pendingRerun).toBe(true);
        expect(yield* Ref.get(harness.startCount)).toBe(1);

        yield* Deferred.succeed(hold, undefined);
        yield* Queue.take(harness.started);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(finished.pendingRerun).toBe(false);
        // Three requests, two compiles: the second and third coalesced.
        expect(yield* Ref.get(harness.startCount)).toBe(2);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("cancels a running build through the process port without rerunning it", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [{ transcript: "", exitCode: 0, pdf: minimalPdf("build-a"), hold }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        const cancelled = yield* service.cancel(harness.buildInput);
        expect(cancelled.state).toBe("cancelled");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);

        const settled = yield* awaitTerminal(service, harness.buildInput);
        expect(settled.state).toBe("cancelled");
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        // Cancelling again is a no-op rather than a second store transition.
        expect((yield* service.cancel(harness.buildInput)).state).toBe("cancelled");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);

        const bound = yield* store
          .getDescriptor(LogicalDocumentKey.make(settled.logicalDocumentKey))
          .pipe(Effect.flip);
        expect(bound.reason).toBe("missing-revision");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports the binding it just staled when it cancels a build that owned one", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a") },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-b"), hold },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const published = yield* awaitTerminal(service, harness.buildInput);
        expect(published.descriptor).toMatchObject({ bindingStatus: "current" });
        yield* Queue.take(harness.started);

        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);
        const cancelled = yield* service.cancel(harness.buildInput);

        expect(cancelled.state).toBe("cancelled");
        expect(cancelled.failureSummary).toBe("Build cancelled.");
        // The store recorded the cancel against the binding, so the snapshot
        // that reports the cancel has to carry that status, not the `current`
        // one the descriptor was holding when the build started.
        expect(cancelled.descriptor).toMatchObject({
          bindingStatus: "stale",
          staleReason: "Build cancelled.",
        });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("admits three compiles at a time and leaves the rest queued", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const documents = ["a.tex", "b.tex", "c.tex", "d.tex"];
      const harness = yield* makeHarness({
        files: Object.fromEntries(documents.map((name) => [name, SOURCE])),
        compiles: documents.map((name) => ({
          transcript: "",
          exitCode: 0,
          pdf: minimalPdf(name),
          hold,
        })),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const inputs = documents.map((name) => harness.inputFor(name));
        yield* Effect.all(inputs.map((input) => service.requestBuild(input)));
        yield* Effect.all([
          Queue.take(harness.started),
          Queue.take(harness.started),
          Queue.take(harness.started),
        ]);

        // Give the fourth compile every chance to reach the port; the permit is
        // the only thing holding it back.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* Effect.sleep(Duration.millis(10));
          expect(yield* Ref.get(harness.startCount)).toBe(3);
        }
        const waiting = yield* Effect.all(inputs.map((input) => service.status(input)));
        expect(waiting.filter((snapshot) => snapshot.state === "running")).toHaveLength(3);
        expect(waiting.filter((snapshot) => snapshot.state === "queued")).toHaveLength(1);

        yield* Deferred.succeed(hold, undefined);
        const finished = yield* Effect.all(
          inputs.map((input) => awaitTerminal(service, input)),
          { concurrency: "unbounded" },
        );
        expect(finished.map((snapshot) => snapshot.state)).toEqual([
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded",
        ]);
        expect(yield* Ref.get(harness.startCount)).toBe(4);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("lets the newest generation win and reports a superseded publish as cancelled", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a") },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-b") },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-c"), hold },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const first = yield* awaitTerminal(service, harness.buildInput);
        yield* Queue.take(harness.started);
        yield* service.requestBuild(harness.buildInput);
        const second = yield* awaitTerminal(service, harness.buildInput);
        yield* Queue.take(harness.started);
        expect(second.state).toBe("succeeded");
        expect(second.descriptor).toMatchObject({ bindingGeneration: 2 });
        const firstRevision =
          first.descriptor?._tag === "generated-pdf" ? first.descriptor.revisionId : null;
        const secondRevision =
          second.descriptor?._tag === "generated-pdf" ? second.descriptor.revisionId : null;
        expect(secondRevision).not.toBe(firstRevision);

        const documentKey = LogicalDocumentKey.make(second.logicalDocumentKey);
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);
        // A different producer takes the binding while the third build compiles.
        yield* store.beginProduction({
          logicalDocumentKey: documentKey,
          operationId: ProducingOperationId.make("external-production"),
          producerId: ArtifactProducerId.make("latex"),
        });
        yield* Deferred.succeed(hold, undefined);

        const superseded = yield* awaitTerminal(service, harness.buildInput);
        expect(superseded.state).toBe("cancelled");
        const bound = yield* store.getDescriptor(documentKey);
        expect(bound).toMatchObject({ revisionId: secondRevision });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("fails without touching the document store when no toolchain is installed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ compiles: [], toolchain: NO_TOOLCHAIN });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("failed");
        expect(finished.failureSummary).toContain("No LaTeX toolchain found");
        expect(finished.descriptor).toBeNull();
        expect(yield* Ref.get(harness.startCount)).toBe(0);

        const bound = yield* store
          .getDescriptor(LogicalDocumentKey.make(finished.logicalDocumentKey))
          .pipe(Effect.flip);
        expect(bound.reason).toBe("missing-binding");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports an unreadable source without starting a build", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ compiles: [] });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const missing = yield* service.requestBuild({
          workspaceRoot: harness.buildInput.workspaceRoot,
          relativePath: "absent.tex",
        });
        expect(missing.state).toBe("failed");
        expect(missing.failureSummary).toContain("absent.tex");
        expect(yield* Ref.get(harness.startCount)).toBe(0);

        const escaping = yield* service
          .requestBuild({
            workspaceRoot: harness.buildInput.workspaceRoot,
            relativePath: "../outside.tex",
          })
          .pipe(Effect.flip);
        expect(escaping.reason).toBe("invalid-path");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never compiles a Windows drive-relative path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ compiles: [] });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const outcome = yield* service
          .requestBuild({
            workspaceRoot: harness.buildInput.workspaceRoot,
            relativePath: "C:evil\\x.tex",
          })
          .pipe(Effect.result);

        // Where `C:evil\x.tex` lands depends on the drive the workspace sits
        // on: the same drive resolves it to an ordinary missing file inside the
        // workspace, another drive makes `path.relative` hand back an absolute
        // path that the containment guard rejects. Neither reaches the engine,
        // and neither is allowed to name a path outside the root.
        if (outcome._tag === "Failure") {
          expect(outcome.failure.reason).toBe("invalid-path");
        } else {
          expect(outcome.success.state).toBe("failed");
          expect(escapesWorkspaceRoot(outcome.success.rootRelativePath)).toBe(false);
        }
        expect(yield* Ref.get(harness.startCount)).toBe(0);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never reports a failed build without saying why", () =>
    Effect.gen(function* () {
      // The regression, as it happened. A first compile stops on
      // `microtype.sty`; the fetch reports failure (in production, a `tlmgr`
      // whose shim was killed at the budget while its perl kept going); the
      // reader rebuilds; and `latexmk` — holding, in the work directory that
      // outlives a build, both the record that the last run failed and the
      // paths it looked for the missing file in — declines to rerun the engine
      // at all. Its refusal is prose: no `file:line:`, no `!`, no missing file.
      // The build recorded that as an empty diagnostics list under the bare
      // "LaTeX build failed.", which is the one thing a reader cannot act on.
      const harness = yield* makeHarness({
        toolchain: MANAGED_LATEXMK,
        compiles: [
          { transcript: missingPackageTranscript("microtype"), exitCode: 1, pdf: null },
          { transcript: REFUSED_RERUN_TRANSCRIPT, exitCode: 12, pdf: null },
        ],
        install: (request) => Effect.succeed({ installed: [], failed: request.packages }),
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        const first = yield* awaitTerminal(service, harness.buildInput);
        expect(first.state).toBe("failed");

        yield* service.requestBuild(harness.buildInput);
        const second = yield* awaitTerminal(service, harness.buildInput);

        expect(second.state).toBe("failed");
        expect(second.diagnostics.length).toBeGreaterThan(0);
        expect(second.failureSummary).not.toBe("LaTeX build failed.");
        // The driver's own verdict, which is everything that run had to say.
        expect(second.diagnostics.at(-1)?.message).toBe(
          "pdflatex: gave an error in previous invocation of latexmk.",
        );
        expect(second.failureSummary).toBe(
          "pdflatex: gave an error in previous invocation of latexmk.",
        );
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("carries a reason on every shape of failure a build can reach", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly harness: Parameters<typeof makeHarness>[0];
      }> = [
        {
          name: "no engine at all",
          harness: { compiles: [], toolchain: NO_TOOLCHAIN },
        },
        {
          name: "an engine that said nothing and produced nothing",
          harness: { compiles: [{ transcript: "", exitCode: 1, pdf: null }] },
        },
        {
          name: "an engine that claimed success and produced nothing",
          harness: { compiles: [{ transcript: "", exitCode: 0, pdf: null }] },
        },
        {
          name: "a driver that refused to rerun",
          harness: {
            compiles: [{ transcript: REFUSED_RERUN_TRANSCRIPT, exitCode: 12, pdf: null }],
          },
        },
      ];
      for (const testCase of cases) {
        const harness = yield* makeHarness(testCase.harness);
        yield* Effect.gen(function* () {
          const service = yield* LatexBuildService;
          yield* service.requestBuild(harness.buildInput);
          const finished = yield* awaitTerminal(service, harness.buildInput);

          expect(finished.state, testCase.name).toBe("failed");
          // The invariant: a reader is never told only that it failed.
          expect(finished.diagnostics.length, testCase.name).toBeGreaterThan(0);
          expect(
            finished.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
            testCase.name,
          ).toBe(true);
          expect(finished.failureSummary, testCase.name).not.toBe("LaTeX build failed.");
        }).pipe(Effect.provide(harness.serviceLayer));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails a build whose engine never exits once the compile timeout elapses", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [{ transcript: "", exitCode: 0, pdf: null, hold }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        yield* TestClock.adjust(Duration.minutes(5));
        let snapshot = yield* service.status(harness.buildInput);
        for (let attempt = 0; attempt < 100 && !TERMINAL_STATES.has(snapshot.state); attempt += 1) {
          yield* TestClock.adjust(Duration.millis(20));
          snapshot = yield* service.status(harness.buildInput);
        }
        expect(snapshot.state).toBe("failed");
        expect(snapshot.failureSummary).toBe("Build timed out.");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );
});

describe("escapesWorkspaceRoot", () => {
  it("rejects parent walks and anything path.relative could not keep relative", () => {
    expect(escapesWorkspaceRoot("main.tex")).toBe(false);
    expect(escapesWorkspaceRoot("paper/sections/intro.tex")).toBe(false);
    expect(escapesWorkspaceRoot("")).toBe(true);
    expect(escapesWorkspaceRoot("..")).toBe(true);
    expect(escapesWorkspaceRoot("../outside.tex")).toBe(true);
    // `path.relative` returns these when the two sides share no root at all,
    // which is how a Windows drive-relative request escapes.
    expect(escapesWorkspaceRoot("/etc/passwd")).toBe(true);
    expect(escapesWorkspaceRoot("C:/other/evil/x.tex")).toBe(true);
  });
});

describe("appendBoundedTranscript", () => {
  it("keeps a small transcript verbatim", () => {
    const state = appendBoundedTranscript(
      appendBoundedTranscript(emptyTranscript, "This is pdfTeX\n"),
      "Output written on main.pdf (3 pages).\n",
    );

    expect(renderTranscript(state)).toBe("This is pdfTeX\nOutput written on main.pdf (3 pages).\n");
  });

  it("drops the middle of an oversized transcript, never the ending", () => {
    const noise = "x".repeat(1024 * 1024);
    let state = appendBoundedTranscript(emptyTranscript, "This is pdfTeX\n");
    for (let chunk = 0; chunk < 5; chunk += 1) {
      state = appendBoundedTranscript(state, noise);
    }
    state = appendBoundedTranscript(state, "\n./main.tex:12: Undefined control sequence.\n");
    const text = renderTranscript(state);

    // The engine's verdict is the last thing it prints, so the tail is the part
    // worth keeping; the banner survives as a short head.
    expect(text.startsWith("This is pdfTeX\n")).toBe(true);
    expect(text.endsWith("\n./main.tex:12: Undefined control sequence.\n")).toBe(true);
    expect(text).toContain("[transcript truncated]");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024 * 1024 + 64);
  });
});
