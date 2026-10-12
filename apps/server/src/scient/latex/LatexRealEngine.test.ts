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
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
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
import { LatexToolchain, layer as toolchainLayer } from "./LatexToolchain.ts";
import { LatexSyncTex, layer as syncTexLayer } from "./LatexSyncTex.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";

const publicationHelper = await filePublicationTestHelper();

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
const makeWorkspace = (files: Readonly<Record<string, string>>, managedRoot?: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-engine-workspace-" }),
    );
    const baseDir = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-engine-state-" }),
    );
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspaceRoot, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fileSystem.writeFileString(absolutePath, contents);
    }
    if (managedRoot !== undefined) {
      const managedDirectory = path.join(baseDir, "userdata", "latex", "managed");
      yield* fileSystem.makeDirectory(managedDirectory, { recursive: true });
      const installed = path.join(managedDirectory, "existing-installed-toolchain");
      yield* fileSystem.symlink(managedRoot, installed);
      yield* fileSystem.writeFileString(
        path.join(managedDirectory, "managed-state.json"),
        JSON.stringify({
          schemaVersion: 1,
          version: "existing-install-acceptance",
          installedAtEpochMs: 0,
          root: installed,
        }),
      );
    }
    const generatedStoreLayer = storeLayer.pipe(Layer.provide(serverEnvironment));
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
        Layer.provideMerge(generatedStoreLayer),
        Layer.provideMerge(
          WorkspaceFileSystem.layer.pipe(
            Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
            Layer.provide(WorkspacePaths.layer),
          ),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(workspaceRoot, baseDir, {
            ...(publicationHelper === undefined
              ? {}
              : { filePublicationHelperPath: publicationHelper }),
            ...(process.env.SCIENT_LATEX_REAL_SYNCTEX_PATH === undefined
              ? {}
              : { syncTexNavigatorPath: process.env.SCIENT_LATEX_REAL_SYNCTEX_PATH }),
          }),
        ),
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
            "% !TEX program = tectonic\n\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\\end{document}\n",
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
    "discovers and compiles a root under paper/ from an opened included fragment",
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
            relativePath: "paper/sections/intro.tex",
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
  "edited-source real-engine round trip",
  () => {
    it.live(
      "rebuilds edited prose, preserves math and recovers from a failed compile",
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
                source = source.replace(
                  sentence,
                  replacement.replace(/[%&]/gu, (character) => `\\${character}`),
                );
                yield* fs.writeFileString(`${harness.workspaceRoot}/main.tex`, source);
              }
              yield* service.requestBuild(input);
              const finished = yield* awaitTerminal(service, input);
              expect(finished.state).toBe("succeeded");
              const sourceRevision = `sha256:${NodeCrypto.createHash("sha256").update(source).digest("hex")}`;
              expect(finished.visualSourceRevisions?.["main.tex"]).toBe(sourceRevision);
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
                sourceRevision,
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

const installedManagedRoot = process.env.SCIENT_LATEX_REAL_MANAGED_ROOT;
describe.skipIf(installedManagedRoot === undefined)(
  "existing optional compiler through production services",
  () => {
    it.live(
      "builds LuaLaTeX, saves new source bytes, rebuilds, and preserves the default driver",
      () =>
        Effect.gen(function* () {
          const source =
            "% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}\nOptional compiler acceptance.\n\\end{document}\n";
          const h = yield* makeWorkspace({ "main.tex": source }, installedManagedRoot);
          yield* Effect.gen(function* () {
            const service = yield* LatexBuildService;
            const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
            const toolchain = yield* LatexToolchain;
            const defaultBefore = yield* toolchain.probe(false);
            const input = { workspaceRoot: h.workspaceRoot, relativePath: "main.tex" };
            yield* service.requestBuild(input);
            const first = yield* awaitTerminal(service, input);
            expect(first.state, first.failureSummary ?? undefined).toBe("succeeded");
            expect(first.failureSummary).toBeNull();
            const before = yield* workspace.readFile({
              cwd: h.workspaceRoot,
              relativePath: "main.tex",
            });
            expect(before.contents).toBe(source);
            const changed = source.replace(
              "Optional compiler acceptance.",
              "Saved and rebuilt without manual recovery.",
            );
            const saved = yield* workspace.writeFile({
              cwd: h.workspaceRoot,
              relativePath: "main.tex",
              contents: changed,
              expectedRevision: before.revision,
              mutationId: "real-optional-save",
            });
            expect(saved.revision).not.toBe(before.revision);
            yield* service.requestBuild(input);
            const second = yield* awaitTerminal(service, input);
            expect(second.state).toBe("succeeded");
            expect(second.failureSummary).toBeNull();
            expect(second.descriptor).not.toEqual(first.descriptor);
            expect(
              (yield* workspace.readFile({ cwd: h.workspaceRoot, relativePath: "main.tex" }))
                .contents,
            ).toBe(changed);
            const defaultAfter = yield* toolchain.probe(false);
            expect(defaultAfter.kind).toBe(defaultBefore.kind);
            expect(defaultAfter.executable).toBe(defaultBefore.executable);
          }).pipe(Effect.provide(h.serviceLayer));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      60_000,
    );
  },
);
