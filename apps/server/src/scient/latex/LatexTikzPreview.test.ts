import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ExecutionProcessError } from "@scientfactory/execution";
import type { ScientLatexArtworkRequest } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { LatexTikzPreview, layer } from "./LatexTikzPreview.ts";
import { LatexToolchain } from "./LatexToolchain.ts";

const documentSource =
  "\\documentclass{article}\n\\begin{document}\nSaved document\n\\end{document}\n";
const missingPackage = "! LaTeX Error: File `pgfplots.sty' not found.\n! Emergency stop.\n";
const publicationHelper = await filePublicationTestHelper();

const harness = Effect.fnUntraced(function* (
  options: {
    kind?: "latexmk" | "tectonic";
    retirement?: Deferred.Deferred<number>;
    cancelFails?: boolean;
    transcript?: string;
    unretiredInstall?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "scient-artwork-admission-" })
    .pipe(Effect.flatMap((root) => fs.realPath(root)));
  const workspaceRoot = path.join(directory, "project");
  yield* fs.makeDirectory(workspaceRoot);
  yield* fs.writeFileString(path.join(workspaceRoot, "main.tex"), documentSource);
  const executable = path.join(directory, "managed", options.kind ?? "latexmk");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "synthetic compiler identity");
  if (options.unretiredInstall)
    yield* fs.writeFileString(
      path.join(path.dirname(executable), ".scient-unretired-install"),
      "Unknown prior installer retirement",
    );
  const reads = yield* Ref.make(0);
  const probes = yield* Ref.make(0);
  const starts = yield* Ref.make(0);
  const cancellations = yield* Ref.make(0);
  const argumentsUsed = yield* Ref.make<readonly string[]>([]);
  const processDirectory = yield* Ref.make("");
  const started = yield* Deferred.make<void>();
  const canceled = yield* Deferred.make<void>();
  const compiledSource = yield* Ref.make("");
  const configLayer = ServerConfig.layerTest(
    workspaceRoot,
    directory,
    publicationHelper === undefined ? {} : { filePublicationHelperPath: publicationHelper },
  );
  const underlyingWorkspace = yield* WorkspaceFileSystem.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
        WorkspacePaths.layer,
        configLayer,
      ),
    ),
  );
  const workspace = WorkspaceFileSystem.WorkspaceFileSystem.of({
    ...underlyingWorkspace,
    readFile: (request) =>
      Ref.update(reads, (count) => count + 1).pipe(
        Effect.andThen(underlyingWorkspace.readFile(request)),
      ),
  });
  const serviceLayer = layer.pipe(
    Layer.provide(Layer.succeed(WorkspaceFileSystem.WorkspaceFileSystem, workspace)),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(
      Layer.succeed(
        LatexToolchain,
        LatexToolchain.of({
          probe: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as({
                kind: options.kind ?? "latexmk",
                executable,
                version: "4.88",
                probedAtEpochMs: 0,
                source: "scient-managed" as const,
                compilers: [],
              }),
            ),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        LocalExecutionProcess.ExecutionProcess,
        LocalExecutionProcess.ExecutionProcess.of({
          start: (request) =>
            Effect.gen(function* () {
              yield* Ref.update(starts, (count) => count + 1);
              yield* Ref.set(
                compiledSource,
                yield* fs.readFileString(path.join(request.cwd, "picture.tex")),
              );
              yield* Ref.set(argumentsUsed, request.args);
              yield* Ref.set(processDirectory, request.cwd);
              yield* Deferred.succeed(started, undefined);
              const cancel = yield* Effect.cached(
                Ref.update(cancellations, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(canceled, undefined)),
                  Effect.andThen(
                    options.cancelFails
                      ? Effect.fail(
                          new ExecutionProcessError({
                            operation: "cancel",
                            message: "Synthetic unknown process retirement",
                            cause: new Error("owned process did not retire"),
                          }),
                        )
                      : Effect.void,
                  ),
                  Effect.asVoid,
                ),
              );
              return {
                output: Stream.make({
                  stream: "stderr" as const,
                  text: options.transcript ?? missingPackage,
                }),
                exitCode: options.retirement
                  ? Deferred.await(options.retirement)
                  : Effect.succeed(1),
                cancel,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ExecutionProcessError({
                    operation: "spawn",
                    message: "Could not read the synthetic compiler input.",
                    cause,
                  }),
              ),
            ),
        }),
      ),
    ),
    Layer.provide(configLayer),
    Layer.provide(Layer.succeed(HostProcess.Environment, {})),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(SpawnExecutableResolution, (command) => command)),
    Layer.provide(NodeServices.layer),
  );
  const request: ScientLatexArtworkRequest = {
    authorization: "execute-host-tex",
    workspaceRoot,
    relativePath: "main.tex",
    preamble: "\\documentclass{article}\n\\usepackage{tikz,pgfplots}",
    source: "\\begin{tikzpicture}\\draw(0,0)--(1,1);\\end{tikzpicture}",
    widthInches: 4,
  };
  return {
    fs,
    path,
    serviceLayer,
    request,
    reads,
    probes,
    starts,
    cancellations,
    compiledSource,
    argumentsUsed,
    processDirectory,
    started,
    canceled,
  };
});

describe("LatexTikzPreview explicit host execution", () => {
  it.effect(
    "refuses omitted and non-action authorization before file access, probing or execution",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const { authorization: _authorization, ...omitted } = h.request;
        const results = yield* Effect.gen(function* () {
          const preview = yield* LatexTikzPreview;
          return yield* Effect.forEach(
            [
              omitted,
              { ...omitted, authorization: "installed-toolchain" },
              { ...omitted, authorization: true },
            ],
            (request) => preview.render(request as unknown as ScientLatexArtworkRequest),
          );
        }).pipe(Effect.provide(h.serviceLayer));
        for (const result of results) {
          expect(result._tag).toBe("unavailable");
        }
        expect(yield* Ref.get(h.reads)).toBe(0);
        expect(yield* Ref.get(h.probes)).toBe(0);
        expect(yield* Ref.get(h.starts)).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "runs admitted client text once but never installs missing packages or changes the document",
    () =>
      Effect.gen(function* () {
        for (const kind of ["latexmk", "tectonic"] as const) {
          const h = yield* harness({ kind });
          const result = yield* Effect.gen(function* () {
            const preview = yield* LatexTikzPreview;
            return yield* preview.render(h.request);
          }).pipe(Effect.provide(h.serviceLayer));
          expect(result._tag).toBe("unavailable");
          expect(yield* Ref.get(h.starts)).toBe(1);
          expect(yield* Ref.get(h.cancellations)).toBe(1);
          if (kind === "tectonic")
            expect(yield* Ref.get(h.argumentsUsed)).toContain("--only-cached");
          const compiled = yield* Ref.get(h.compiledSource);
          expect(compiled).toContain(h.request.preamble);
          expect(compiled).toContain(h.request.source);
          expect(compiled).not.toContain("Saved document");
          expect(yield* h.fs.readFileString(h.path.join(h.request.workspaceRoot, "main.tex"))).toBe(
            documentSource,
          );
          expect(yield* h.fs.readDirectory(h.request.workspaceRoot)).toEqual(["main.tex"]);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never injects unadmitted auxiliary-file TeX into an algorithm preview", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const auxiliary =
        "\\newlabel{sample}{{1}{1}}\\directlua{error('UNADMITTED_AUX_EXECUTION')}\n";
      const auxiliaryPath = h.path.join(h.request.workspaceRoot, "main.aux");
      yield* h.fs.writeFileString(auxiliaryPath, auxiliary);
      yield* Effect.gen(function* () {
        const preview = yield* LatexTikzPreview;
        return yield* preview.render({
          ...h.request,
          preamble: `${h.request.preamble}\n\\usepackage{algorithm}`,
          source: `\\begin{algorithm}${h.request.source}\\end{algorithm}`,
          algorithmNumber: 3,
        });
      }).pipe(Effect.provide(h.serviceLayer));
      expect(yield* Ref.get(h.starts)).toBe(1);
      expect(yield* Ref.get(h.compiledSource)).not.toContain("UNADMITTED_AUX_EXECUTION");
      expect(yield* h.fs.readFileString(auxiliaryPath)).toBe(auxiliary);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("holds the private workspace until an interrupted compiler has retired", () =>
    Effect.gen(function* () {
      const retirement = yield* Deferred.make<number>();
      const h = yield* harness({ retirement });
      const rendering = yield* Effect.gen(function* () {
        const preview = yield* LatexTikzPreview;
        return yield* preview.render(h.request);
      }).pipe(Effect.provide(h.serviceLayer), Effect.forkChild);
      yield* Deferred.await(h.started);
      const interrupting = yield* Fiber.interrupt(rendering).pipe(Effect.forkChild);
      yield* Deferred.await(h.canceled);
      yield* Effect.yieldNow;
      expect(interrupting.pollUnsafe()).toBeUndefined();
      const directory = yield* Ref.get(h.processDirectory);
      expect(yield* h.fs.exists(directory)).toBe(true);
      yield* Deferred.succeed(retirement, 1);
      yield* Fiber.join(interrupting);
      expect(yield* h.fs.exists(directory)).toBe(false);
      expect(yield* Ref.get(h.cancellations)).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "quarantines unknown compiler retirement instead of deleting or reusing its workspace",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ cancelFails: true });
        const results = yield* Effect.gen(function* () {
          const preview = yield* LatexTikzPreview;
          const first = yield* preview.render(h.request);
          const second = yield* preview.render(h.request);
          return [first, second];
        }).pipe(Effect.provide(h.serviceLayer));
        expect(results.map((result) => result._tag)).toEqual(["unavailable", "unavailable"]);
        expect(yield* Ref.get(h.starts)).toBe(1);
        expect(yield* Ref.get(h.cancellations)).toBe(1);
        expect(yield* h.fs.exists(yield* Ref.get(h.processDirectory))).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a managed distribution with unknown installer retirement", () =>
    Effect.gen(function* () {
      const h = yield* harness({ unretiredInstall: true });
      const result = yield* Effect.gen(function* () {
        const preview = yield* LatexTikzPreview;
        return yield* preview.render(h.request);
      }).pipe(Effect.provide(h.serviceLayer));
      expect(result._tag).toBe("unavailable");
      expect(yield* Ref.get(h.starts)).toBe(0);
      expect(yield* h.fs.readFileString(h.path.join(h.request.workspaceRoot, "main.tex"))).toBe(
        documentSource,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "directs an unavailable Tectonic bundle back to explicit document Build without retries",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          kind: "tectonic",
          transcript: "error: bundle resource could not be opened in cached-only mode.\n",
        });
        const result = yield* Effect.gen(function* () {
          const preview = yield* LatexTikzPreview;
          return yield* preview.render(h.request);
        }).pipe(Effect.provide(h.serviceLayer));
        expect(result._tag).toBe("unavailable");
        expect(yield* Ref.get(h.starts)).toBe(1);
        expect(yield* Ref.get(h.argumentsUsed)).toContain("--only-cached");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
