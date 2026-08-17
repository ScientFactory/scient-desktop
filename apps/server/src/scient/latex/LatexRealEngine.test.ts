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
import { layer as syncTexLayer } from "./LatexSyncTex.ts";

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
    return {
      workspaceRoot,
      serviceLayer: buildServiceLayer.pipe(
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provideMerge(syncTexLayer.pipe(Layer.provide(serverEnvironment))),
        // Never asked for here — the engine on PATH is the user's own, which
        // this lane does not install into — but the service holds it the way
        // the server mounts it.
        Layer.provide(packageInstallerLayer),
        Layer.provideMerge(toolchainLayer),
        Layer.provideMerge(storeLayer.pipe(Layer.provide(serverEnvironment))),
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
          yield* expectPublishedPdf(store, finished.descriptor);
        }).pipe(Effect.provide(harness.serviceLayer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    COMPILE_TIMEOUT_MS,
  );
});
