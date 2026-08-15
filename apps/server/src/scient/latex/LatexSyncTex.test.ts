// @effect-diagnostics nodeBuiltinImport:off -- The navigation boundary is filesystem-backed.
import { ArtifactId, ArtifactRevisionId } from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  GeneratedDocumentStore,
  GeneratedDocumentStoreError,
  type ResolvedGeneratedDocumentRevision,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import { LatexSyncTex, make as makeSyncTex } from "./LatexSyncTex.ts";

const environmentId = EnvironmentId.make("environment-latex-synctex-test");
const artifactId = ArtifactId.make("artifact-latex-synctex-test");
const firstRevisionId = ArtifactRevisionId.make("revision-latex-synctex-first");
const secondRevisionId = ArtifactRevisionId.make("revision-latex-synctex-second");

const processOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const revisionKey = (revisionId: ArtifactRevisionId) => `${artifactId}/${revisionId}`;

const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-latex-synctex-workspace-",
  });
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-latex-synctex-state-",
  });
  const compileDirectory = path.join(baseDir, "compile");
  yield* fileSystem.makeDirectory(path.join(workspaceRoot, "chapters"), { recursive: true });
  yield* fileSystem.makeDirectory(compileDirectory, { recursive: true });
  const bodyPath = path.join(workspaceRoot, "chapters", "body.tex");
  yield* fileSystem.writeFileString(path.join(workspaceRoot, "main.tex"), "\\input{chapters/body}");
  yield* fileSystem.writeFileString(bodyPath, "Body");

  const liveRevisions = yield* Ref.make(new Set<string>([revisionKey(firstRevisionId)]));
  const invocations = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
  const resolvedRevision = {
    artifact: {},
    path: path.join(baseDir, "unused.pdf"),
    fileName: "main.pdf",
    title: "main.tex",
    revision: { size: 1, mtimeMs: 1 },
  } as ResolvedGeneratedDocumentRevision;

  const revisionIsLive = (revisionId: ArtifactRevisionId) =>
    Ref.get(liveRevisions).pipe(Effect.map((live) => live.has(revisionKey(revisionId))));
  const missingRevision = () =>
    new GeneratedDocumentStoreError({
      operation: "resolve",
      reason: "missing-revision",
      detail: "The revision is gone.",
    });
  const store = GeneratedDocumentStore.of({
    beginProduction: () => Effect.die("unused"),
    publishPdf: () => Effect.die("unused"),
    failProduction: () => Effect.die("unused"),
    abandonProduction: () => Effect.die("unused"),
    getDescriptor: () => Effect.die("unused"),
    resolveRevision: (input) =>
      revisionIsLive(input.revisionId).pipe(
        Effect.flatMap((live) =>
          live ? Effect.succeed(resolvedRevision) : Effect.fail(missingRevision()),
        ),
      ),
    revisionExists: (input) => revisionIsLive(input.revisionId),
    resolveRevisionForAsset: () => Effect.die("unused"),
    retainRevision: () => Effect.void,
    changes: Stream.empty,
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Ref.update(invocations, (previous) => [...previous, input]).pipe(
        Effect.as(
          input.args[0] === "view"
            ? processOutput(`SyncTeX result begin
Page:2
h:18
v:72
W:9
H:12
SyncTeX result end`)
            : processOutput(`SyncTeX result begin
Input:${bodyPath}
Line:17
Column:4
SyncTeX result end`),
        ),
      ),
  });
  const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  });
  const serviceLayer = Layer.effect(LatexSyncTex, makeSyncTex).pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
    Layer.provide(Layer.succeed(GeneratedDocumentStore, store)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, serverEnvironment)),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  const publish = (revisionId: ArtifactRevisionId) =>
    Effect.gen(function* () {
      const syncTexPath = path.join(compileDirectory, `main-${revisionId}.synctex.gz`);
      yield* fileSystem.writeFileString(syncTexPath, `index for ${revisionId}`);
      const service = yield* LatexSyncTex;
      yield* service.publishIndex({
        artifactId,
        revisionId,
        workspaceRoot,
        rootRelativePath: "main.tex",
        compileDirectory,
        syncTexPath,
        toolchainExecutable: "latexmk",
        managed: false,
      });
    }).pipe(Effect.provide(serviceLayer));

  return {
    workspaceRoot,
    bodyPath,
    compileDirectory,
    baseDir,
    liveRevisions,
    invocations,
    serviceLayer,
    publish,
  };
});

describe("LatexSyncTex", () => {
  it.effect("publishes an exact-revision index and runs forward and inverse navigation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const navigationDirectory = path.join(
        harness.baseDir,
        "userdata",
        "latex",
        "synctex",
        artifactId,
        firstRevisionId,
      );
      expect(
        yield* fileSystem.exists(
          path.join(navigationDirectory, "main-revision-latex-synctex-first.pdf"),
        ),
      ).toBe(true);
      expect(
        (yield* fileSystem.stat(
          path.join(navigationDirectory, "main-revision-latex-synctex-first.pdf"),
        )).size,
      ).toBe(0n);

      const forward = yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "chapters/body.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 17,
        column: 4,
      });
      expect(forward).toEqual({ _tag: "found", page: 2, x: 18, y: 72, width: 9, height: 12 });

      const inverse = yield* service.inverse({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        artifactId,
        revisionId: firstRevisionId,
        page: 2,
        x: 18,
        y: 72,
      });
      expect(inverse).toEqual({
        _tag: "found",
        relativePath: "chapters/body.tex",
        line: 17,
        column: 4,
      });

      const invocations = yield* Ref.get(harness.invocations);
      expect(invocations.map((invocation) => invocation.args[0])).toEqual(["view", "edit"]);
      expect(invocations[0]?.args).toEqual([
        "view",
        "-i",
        `17:4:${harness.bodyPath}`,
        "-o",
        expect.stringMatching(/main-revision-latex-synctex-first\.pdf$/u),
        "-d",
        expect.stringMatching(/revision-latex-synctex-first$/u),
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses stale revisions and removes their orphaned index", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      yield* Ref.set(harness.liveRevisions, new Set());
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      const result = yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "main.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 1,
      });
      expect(result).toMatchObject({ _tag: "unavailable", reason: "revision-unavailable" });
      expect(
        yield* fileSystem.exists(
          path.join(harness.baseDir, "userdata", "latex", "synctex", artifactId, firstRevisionId),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("sweeps indexes after the PDF store evicts their revision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      yield* Ref.set(harness.liveRevisions, new Set([revisionKey(secondRevisionId)]));
      yield* harness.publish(secondRevisionId);

      const indexRoot = path.join(harness.baseDir, "userdata", "latex", "synctex", artifactId);
      expect(yield* fileSystem.exists(path.join(indexRoot, firstRevisionId))).toBe(false);
      expect(yield* fileSystem.exists(path.join(indexRoot, secondRevisionId))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
