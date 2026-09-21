// @effect-diagnostics nodeBuiltinImport:off -- Engine detection has to happen at
// collection time, before any Effect runtime exists, so the suite can skip itself.
/**
 * The one test that runs a real TeX engine. It is skipped unless `latexmk` or
 * `tectonic` resolves on PATH, which is the normal state of a machine and of
 * CI; where an engine does exist it proves the two things only a real compile
 * can: that the argv this lane builds actually produces a PDF, and that a root
 * living in a subdirectory finds the files it `\input`s and `\include`s.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { editVisualRun, matchVisualRun } from "@t3tools/shared/latexVisual";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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
  layer as buildServiceLayer,
} from "./LatexBuildService.ts";
import { layer as packageInstallerLayer } from "./LatexPackageInstaller.ts";
import { layer as toolchainLayer } from "./LatexToolchain.ts";
import { LatexSyncTex, layer as syncTexLayer } from "./LatexSyncTex.ts";
import { layer as visualRevisionStoreLayer } from "./LatexVisualRevisionStore.ts";

/** A whole-command string keeps this off `shell:true`'s argument-splicing path. */
const resolvesOnPath = (command: string): boolean => {
  const probe = NodeChildProcess.spawnSync(command, {
    // Windows resolves these through PATHEXT shims, so the probe needs a shell.
    shell: true,
    stdio: "ignore",
    timeout: 20_000,
  });
  return probe.error === undefined && probe.status === 0;
};

const ENGINE_ON_PATH = resolvesOnPath("latexmk -v") || resolvesOnPath("tectonic --version");

const COMPILE_TIMEOUT_MS = 25_000;

const authority = EnvironmentId.make("environment-scient-latex-real-test");
const serverEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(authority),
    getDescriptor: Effect.die("unused environment descriptor"),
  }),
);

const TERMINAL_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

/** Every service is the real one here; only the state root is disposable. */
const makeWorkspace = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-latex-engine-workspace-",
    });
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-latex-engine-state-",
    });
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspaceRoot, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fileSystem.writeFileString(absolutePath, contents);
    }
    const generatedStoreLayer = storeLayer.pipe(Layer.provide(serverEnvironment));
    return {
      workspaceRoot,
      serviceLayer: buildServiceLayer.pipe(
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provideMerge(syncTexLayer.pipe(Layer.provide(serverEnvironment))),
        Layer.provideMerge(
          visualRevisionStoreLayer.pipe(
            Layer.provide(generatedStoreLayer),
            Layer.provide(serverEnvironment),
          ),
        ),
        // Never asked for here — the engine on PATH is the user's own, which
        // this lane does not install into — but the service holds it the way
        // the server mounts it.
        Layer.provide(packageInstallerLayer),
        Layer.provideMerge(toolchainLayer),
        Layer.provideMerge(generatedStoreLayer),
        Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      ),
    };
  });

const awaitTerminal = (service: LatexBuildService["Service"], input: LatexBuildInput) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < COMPILE_TIMEOUT_MS / 50; attempt += 1) {
      const snapshot = yield* service.status(input);
      if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
      yield* Effect.sleep(Duration.millis(50));
    }
    return yield* service.status(input);
  });

const expectPublishedPdf = (
  store: GeneratedDocumentStore["Service"],
  descriptor: PdfSourceDescriptor | null,
) =>
  Effect.gen(function* () {
    if (descriptor?._tag !== "generated-pdf") {
      return yield* Effect.die("expected a published generated PDF");
    }
    const published = yield* store.resolveRevision({
      authority: descriptor.authority,
      artifactId: descriptor.artifactId,
      revisionId: descriptor.revisionId,
    });
    expect(published.fileName).toBe("main.pdf");
    expect(published.revision.size).toBeGreaterThan(0);
  });

describe.skipIf(!ENGINE_ON_PATH)("LatexBuildService against an installed engine", () => {
  it.live(
    "compiles a root at the workspace root",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWorkspace({
          "main.tex":
            "\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\\end{document}\n",
        });
        yield* Effect.gen(function* () {
          const service = yield* LatexBuildService;
          const store = yield* GeneratedDocumentStore;
          const input: LatexBuildInput = {
            workspaceRoot: harness.workspaceRoot,
            relativePath: "main.tex",
          };
          yield* service.requestBuild(input);
          const finished = yield* awaitTerminal(service, input);

          expect(finished.failureSummary).toBeNull();
          expect(finished.state).toBe("succeeded");
          expect(finished.diagnostics).toEqual([]);
          expect(finished.visualSourceRevisions?.["main.tex"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
          expect(finished.descriptor).toMatchObject({
            _tag: "generated-pdf",
            bindingStatus: "current",
            fileName: "main.pdf",
          });
          yield* expectPublishedPdf(store, finished.descriptor);
        }).pipe(Effect.provide(harness.serviceLayer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    COMPILE_TIMEOUT_MS,
  );

  it.live(
    "compiles a root under paper/ that inputs and includes its neighbours",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWorkspace({
          // `\input` and `\include` resolve against the engine's working
          // directory, which is why the compile has to run from `paper/`.
          "paper/main.tex": [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\input{sections/intro}",
            "\\include{appendix}",
            "\\end{document}",
            "",
          ].join("\n"),
          "paper/sections/intro.tex": "The introduction.\n",
          "paper/appendix.tex": "The appendix.\n",
        });
        yield* Effect.gen(function* () {
          const service = yield* LatexBuildService;
          const store = yield* GeneratedDocumentStore;
          const input: LatexBuildInput = {
            workspaceRoot: harness.workspaceRoot,
            relativePath: "paper/main.tex",
          };
          yield* service.requestBuild(input);
          const finished = yield* awaitTerminal(service, input);

          expect(finished.failureSummary).toBeNull();
          expect(finished.state).toBe("succeeded");
          expect(finished.diagnostics).toEqual([]);
          expect(finished.rootRelativePath).toBe("paper/main.tex");
          expect(Object.keys(finished.visualSourceRevisions ?? {}).sort()).toEqual([
            "paper/appendix.tex",
            "paper/main.tex",
            "paper/sections/intro.tex",
          ]);
          yield* expectPublishedPdf(store, finished.descriptor);
        }).pipe(Effect.provide(harness.serviceLayer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    COMPILE_TIMEOUT_MS,
  );
});

describe.skipIf(!ENGINE_ON_PATH || !resolvesOnPath("pdftotext -v"))(
  "visual editing real-engine round trip",
  () => {
    it.live(
      "maps the published PDF, repeatedly patches prose, preserves math and recovers from a failed compile",
      () =>
        Effect.gen(function* () {
          const original =
            "\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\nProtected mathematics: $x^2 + y^2 = z^2$.\n\\end{document}\n";
          const harness = yield* makeWorkspace({ "main.tex": original });
          yield* Effect.gen(function* () {
            const service = yield* LatexBuildService;
            const store = yield* GeneratedDocumentStore;
            const sync = yield* LatexSyncTex;
            const fs = yield* FileSystem.FileSystem;
            const input = { workspaceRoot: harness.workspaceRoot, relativePath: "main.tex" };
            let source = original;
            let lastRevision: string | null = null;
            let initialPixels: string | null = null;
            for (const replacement of [
              null,
              null,
              "Hello from Science.",
              "Hello from Science: 50% & counting.",
              "A completely revised sentence.",
            ]) {
              if (replacement !== null) {
                const sentence = source.split("\n")[2]!;
                // The same bounded mapper and splice implementation used by the UI.
                const display = sentence.replace(/\\([%&])/gu, "$1");
                const match = matchVisualRun(source, display, 0, 3);
                expect(match).not.toBeNull();
                source = editVisualRun(source, match!.run, replacement);
                yield* fs.writeFileString(`${harness.workspaceRoot}/main.tex`, source);
              }
              yield* service.requestBuild(input);
              const finished = yield* awaitTerminal(service, input);
              expect(finished.state).toBe("succeeded");
              expect(finished.visualSourceRevisions?.["main.tex"]).toBe(
                `sha256:${NodeCrypto.createHash("sha256").update(source).digest("hex")}`,
              );
              const descriptor = finished.descriptor;
              if (descriptor?._tag !== "generated-pdf") return yield* Effect.die("missing PDF");
              if (replacement !== null) expect(descriptor.revisionId).not.toBe(lastRevision);
              lastRevision = descriptor.revisionId;
              const published = yield* store.resolveRevision({
                authority: descriptor.authority,
                artifactId: descriptor.artifactId,
                revisionId: descriptor.revisionId,
              });
              const text = NodeChildProcess.execFileSync("pdftotext", [published.path, "-"], {
                encoding: "utf8",
              });
              expect(text).toContain(replacement ?? "Hello from Scient.");
              if (replacement === null && resolvesOnPath("pdftoppm -v")) {
                const pixels = NodeChildProcess.execFileSync(
                  "pdftoppm",
                  ["-singlefile", "-r", "72", published.path],
                  { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
                );
                const digest = NodeCrypto.createHash("sha256").update(pixels).digest("hex");
                if (initialPixels !== null) expect(digest).toBe(initialPixels);
                initialPixels = digest;
              }
              expect(source).toContain("$x^2 + y^2 = z^2$");
              const revision = {
                workspaceRoot: harness.workspaceRoot,
                rootRelativePath: "main.tex",
                artifactId: descriptor.artifactId,
                revisionId: descriptor.revisionId,
              };
              const forward = yield* sync.forward({
                ...revision,
                sourceRelativePath: "main.tex",
                line: 3,
              });
              expect(
                forward._tag,
                forward._tag === "unavailable" ? forward.message : undefined,
              ).toBe("found");
              if (forward._tag === "found") {
                const inverse = yield* sync.inverse({
                  ...revision,
                  page: forward.page,
                  x: forward.x,
                  y: forward.y,
                });
                expect(inverse).toMatchObject({ _tag: "found", relativePath: "main.tex" });
              }
            }
            yield* fs.writeFileString(
              `${harness.workspaceRoot}/main.tex`,
              source.replace("\\end{document}", "\\UndefinedVisualTest\n\\end{document}"),
            );
            yield* service.requestBuild(input);
            const failed = yield* awaitTerminal(service, input);
            expect(failed.state).toBe("failed");
            expect(failed.visualSourceRevisions).toBeUndefined();
            expect(failed.descriptor).toMatchObject({
              revisionId: lastRevision,
              bindingStatus: "stale",
            });
            yield* fs.writeFileString(`${harness.workspaceRoot}/main.tex`, source);
            yield* service.requestBuild(input);
            expect((yield* awaitTerminal(service, input)).state).toBe("succeeded");
          }).pipe(Effect.provide(harness.serviceLayer));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      60_000,
    );
  },
);
