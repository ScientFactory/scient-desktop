// @effect-diagnostics nodeBuiltinImport:off -- the round trip reads the published PDF with Poppler.
/**
 * Real-engine scenarios for LatexBuildService with every production service. Two callers run
 * them: `LatexRealEngine.test.ts` against an engine already on PATH, and the TinyTeX asset
 * smoke against the pinned payload it has just verified.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "@effect/vitest";
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
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";
import { LatexBuildService, layer as buildServiceLayer } from "./LatexBuildService.ts";
import { layer as packageInstallerLayer } from "./LatexPackageInstaller.ts";
import { layer as toolchainLayer } from "./LatexToolchain.ts";
import { LatexSyncTex, layer as syncTexLayer } from "./LatexSyncTex.ts";
import { awaitLatexBuildTerminal, observeLatexBuilds } from "./latexBuildCompletion.testkit.ts";

export interface LatexRealEngineOptions {
  /** A managed install to record as already installed. */
  readonly managedRoot?: string;
  /** The SyncTeX helper the service navigates with, instead of the bundled lookup. */
  readonly syncTexNavigatorPath?: string;
  /** A folder holding the engine, searched before the host's PATH. */
  readonly engineBinDirectory?: string;
}

const authority = EnvironmentId.make("environment-scient-latex-real-test");
const serverEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(authority),
    getDescriptor: Effect.die("unused environment descriptor"),
  }),
);

const hostEnvironmentWith = (engineBinDirectory: string | undefined) => {
  if (engineBinDirectory === undefined) return Layer.empty;
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return Layer.succeed(HostProcess.Environment, {
    ...process.env,
    [pathKey]: `${engineBinDirectory}${NodePath.delimiter}${process.env[pathKey] ?? ""}`,
  });
};

/** The managed install record for a toolchain already in place at `root`. */
const managedStateRecord = (root: string) =>
  JSON.stringify({
    schemaVersion: 1,
    version: "existing-install-acceptance",
    installedAtEpochMs: 0,
    root,
  });

/** Every service is the real one here; only the state root is disposable. */
export const makeLatexRealWorkspace = (
  files: Readonly<Record<string, string>>,
  options: LatexRealEngineOptions = {},
) =>
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
    if (options.managedRoot !== undefined) {
      const managedDirectory = path.join(baseDir, "userdata", "latex", "managed");
      yield* fileSystem.makeDirectory(managedDirectory, { recursive: true });
      const installed = path.join(managedDirectory, "existing-installed-toolchain");
      yield* fileSystem.symlink(options.managedRoot, installed);
      yield* fileSystem.writeFileString(
        path.join(managedDirectory, "managed-state.json"),
        managedStateRecord(installed),
      );
    }
    const publicationHelper = yield* Effect.promise(() => filePublicationTestHelper());
    const completionLayer = yield* observeLatexBuilds();
    const generatedStoreLayer = storeLayer.pipe(Layer.provide(serverEnvironment));
    return {
      workspaceRoot,
      serviceLayer: buildServiceLayer.pipe(
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provideMerge(syncTexLayer.pipe(Layer.provide(serverEnvironment))),
        // Never asked for here — the engine is the user's own or the verified payload, which
        // these scenarios do not install into — but the service holds it the way the server
        // mounts it.
        Layer.provide(packageInstallerLayer),
        Layer.provideMerge(toolchainLayer),
        Layer.provideMerge(generatedStoreLayer),
        Layer.provideMerge(
          WorkspaceFileSystem.layer.pipe(
            Layer.provide(layerKnownWorkspacesAllowAll),
            Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
            Layer.provide(WorkspacePaths.layer),
          ),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(workspaceRoot, baseDir, {
            ...(publicationHelper === undefined
              ? {}
              : { filePublicationHelperPath: publicationHelper }),
            ...(options.syncTexNavigatorPath === undefined
              ? {}
              : { syncTexNavigatorPath: options.syncTexNavigatorPath }),
          }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        Layer.provideMerge(completionLayer),
        Layer.provideMerge(hostEnvironmentWith(options.engineBinDirectory)),
      ),
    };
  });

export const expectPublishedPdf = (
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

const scenario = <A, E, R>(
  files: Readonly<Record<string, string>>,
  options: LatexRealEngineOptions,
  body: (workspaceRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeLatexRealWorkspace(files, options);
    return yield* body(harness.workspaceRoot).pipe(Effect.provide(harness.serviceLayer));
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
    Effect.scoped,
  );

/** Opening an included fragment finds the root under `paper/` and compiles from there. */
export const compilesNestedRootFromFragment = (options: LatexRealEngineOptions = {}) =>
  scenario(
    {
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
    },
    options,
    (workspaceRoot) =>
      Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        const input = { workspaceRoot, relativePath: "paper/sections/intro.tex" };
        yield* service.requestBuild(input);
        const finished = yield* awaitLatexBuildTerminal(service, input);

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
      }),
  );

/**
 * Edits prose between builds and checks each published PDF's text, that the math survives,
 * SyncTeX in both directions, and recovery from a failed compile. Needs `pdftotext`; uses
 * `pdftoppm` when present to check that an unchanged source renders the same pixels.
 */
export const rebuildsEditedSource = (options: LatexRealEngineOptions = {}) => {
  const original =
    "\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\nProtected mathematics: $x^2 + y^2 = z^2$.\n\\end{document}\n";
  return scenario({ "main.tex": original }, options, (workspaceRoot) =>
    Effect.gen(function* () {
      const service = yield* LatexBuildService;
      const store = yield* GeneratedDocumentStore;
      const sync = yield* LatexSyncTex;
      const fs = yield* FileSystem.FileSystem;
      const input = { workspaceRoot, relativePath: "main.tex" };
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
          yield* fs.writeFileString(`${workspaceRoot}/main.tex`, source);
        }
        yield* service.requestBuild(input);
        const finished = yield* awaitLatexBuildTerminal(service, input);
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
        if (replacement === null && popplerHas("pdftoppm")) {
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
          workspaceRoot,
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
        expect(forward._tag, forward._tag === "unavailable" ? forward.message : undefined).toBe(
          "found",
        );
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
        `${workspaceRoot}/main.tex`,
        source.replace("\\end{document}", "\\UndefinedVisualTest\n\\end{document}"),
      );
      yield* service.requestBuild(input);
      const failed = yield* awaitLatexBuildTerminal(service, input);
      expect(failed.state).toBe("failed");
      expect(failed.visualSourceRevisions).toBeUndefined();
      expect(failed.descriptor).toMatchObject({
        revisionId: lastRevision,
        bindingStatus: "stale",
      });
      yield* fs.writeFileString(`${workspaceRoot}/main.tex`, source);
      yield* service.requestBuild(input);
      expect((yield* awaitLatexBuildTerminal(service, input)).state).toBe("succeeded");
    }),
  );
};

/** Whether a Poppler tool starts, for the scenarios that read the published PDF. */
export const popplerHas = (tool: "pdftotext" | "pdftoppm"): boolean => {
  const probe = NodeChildProcess.spawnSync(tool, ["-v"], { stdio: "ignore", timeout: 20_000 });
  return probe.error === undefined && probe.status === 0;
};
