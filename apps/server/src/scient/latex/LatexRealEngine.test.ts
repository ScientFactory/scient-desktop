// @effect-diagnostics nodeBuiltinImport:off -- Engine detection has to happen at
// collection time, before any Effect runtime exists, so the suite can skip itself.
/**
 * Opt in through installed latexmk/tectonic on PATH. A real compile is required to prove invocation
 * produces a PDF and subdirectory roots resolve input/include paths; absent engines must skip.
 */
import * as NodeChildProcess from "node:child_process";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { LatexBuildService, type LatexBuildInput } from "./LatexBuildService.ts";
import { LatexToolchain } from "./LatexToolchain.ts";
import { awaitLatexBuildTerminal as awaitTerminal } from "./latexBuildCompletion.testkit.ts";
import {
  compilesNestedRootFromFragment,
  expectPublishedPdf,
  makeLatexRealWorkspace as makeWorkspace,
  popplerHas,
  rebuildsEditedSource,
} from "./latexRealEngine.testkit.ts";
import * as SyncTexRuntime from "./SyncTexRuntime.ts";

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
// The Linux TinyTeX smoke runs the nested-root and edit/rebuild scenarios against its verified
// payload (TinyTexAssetSmoke.test.ts). Here they run against an engine already on PATH; the
// round trip also needs Poppler's pdftotext and a SyncTeX helper: the one set below or a
// bundled one.
const SYNCTEX_NAVIGATOR_PATH = process.env.SCIENT_LATEX_REAL_SYNCTEX_PATH;
const engine =
  SYNCTEX_NAVIGATOR_PATH === undefined ? {} : { syncTexNavigatorPath: SYNCTEX_NAVIGATOR_PATH };
// Ask SyncTexRuntime itself, as the round trip will. Only a helper it reports missing (with none
// set above) or unsupported on this host skips; a damaged helper or a bad explicit path fails.
const SYNCTEX_HELPER_ABSENT = await Effect.gen(function* () {
  const runtime = yield* SyncTexRuntime.SyncTexRuntime;
  return yield* runtime.resolve;
}).pipe(
  Effect.as(false),
  Effect.catchTags({
    SyncTexRuntimeError: (error) =>
      Effect.succeed(
        error.reason === "unsupported" ||
          (error.reason === "missing" && SYNCTEX_NAVIGATOR_PATH === undefined),
      ),
  }),
  Effect.provide(
    SyncTexRuntime.layer.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "latex-synctex-probe-" }, engine),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  Effect.runPromise,
);

describe.skipIf(!ENGINE_ON_PATH)("LatexBuildService against an installed engine", () => {
  it.live(
    "compiles a root at the workspace root",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWorkspace(
          {
            "main.tex":
              "% !TEX program = tectonic\n\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\\end{document}\n",
          },
          engine,
        );
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
      }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        Effect.scoped,
      ),
    COMPILE_TIMEOUT_MS,
  );

  it.live(
    "discovers and compiles a root under paper/ from an opened included fragment",
    () => compilesNestedRootFromFragment(engine),
    COMPILE_TIMEOUT_MS,
  );
});

describe.skipIf(!ENGINE_ON_PATH || !popplerHas("pdftotext") || SYNCTEX_HELPER_ABSENT)(
  "edited-source real-engine round trip",
  () => {
    it.live("rebuilds edited prose, preserves math and recovers from a failed compile", () =>
      rebuildsEditedSource(engine),
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
          const h = yield* makeWorkspace(
            { "main.tex": source },
            { ...engine, managedRoot: installedManagedRoot! },
          );
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
        }).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
          Effect.scoped,
        ),
    );
  },
);
