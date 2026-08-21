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
import * as Schema from "effect/Schema";
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
import * as SyncTexRuntime from "./SyncTexRuntime.ts";

const LegacyNavigationMetadataJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    workspaceRoot: Schema.String,
    rootRelativePath: Schema.String,
    compileDirectory: Schema.String,
    outputFileName: Schema.String,
    command: Schema.String,
    binDirectory: Schema.NullOr(Schema.String),
  }),
);
const encodeLegacyNavigationMetadata = Schema.encodeSync(LegacyNavigationMetadataJson);

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
  const compileDirectory = workspaceRoot;
  const buildDirectory = path.join(baseDir, "compile");
  yield* fileSystem.makeDirectory(path.join(workspaceRoot, "chapters"), { recursive: true });
  yield* fileSystem.makeDirectory(buildDirectory, { recursive: true });
  const bodyPath = path.join(workspaceRoot, "chapters", "body.tex");
  yield* fileSystem.writeFileString(path.join(workspaceRoot, "main.tex"), "\\input{chapters/body}");
  yield* fileSystem.writeFileString(bodyPath, "Body");

  const liveRevisions = yield* Ref.make(new Set<string>([revisionKey(firstRevisionId)]));
  const invocations = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
  const navigationOutput = yield* Ref.make<ProcessRunner.ProcessRunOutput | "spawn-error" | null>(
    null,
  );
  const runtimeError = yield* Ref.make<SyncTexRuntime.SyncTexRuntimeError | null>(null);
  const inverseInputPath = yield* Ref.make(bodyPath);
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
      Effect.gen(function* () {
        yield* Ref.update(invocations, (previous) => [...previous, input]);
        const overridden = yield* Ref.get(navigationOutput);
        if (overridden === "spawn-error") {
          return yield* new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("spawn failed"),
          });
        }
        if (overridden !== null) return overridden;
        return input.args[0] === "view"
          ? processOutput(`SyncTeX result begin
Page:2
h:18
v:72
W:9
H:12
SyncTeX result end`)
          : processOutput(`SyncTeX result begin
Input:${yield* Ref.get(inverseInputPath)}
Line:17
Column:4
SyncTeX result end`);
      }),
  });
  const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  });
  const runtime = SyncTexRuntime.SyncTexRuntime.of({
    resolve: Ref.get(runtimeError).pipe(
      Effect.flatMap((error) =>
        error === null
          ? Effect.succeed({ command: "/bundled/synctex", source: "bundled" } as const)
          : Effect.fail(error),
      ),
    ),
  });
  const serviceLayer = Layer.effect(LatexSyncTex, makeSyncTex).pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
    Layer.provide(Layer.succeed(SyncTexRuntime.SyncTexRuntime, runtime)),
    Layer.provide(Layer.succeed(GeneratedDocumentStore, store)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, serverEnvironment)),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  const publish = (revisionId: ArtifactRevisionId) =>
    Effect.gen(function* () {
      const syncTexPath = path.join(buildDirectory, `main-${revisionId}.synctex.gz`);
      yield* fileSystem.writeFileString(syncTexPath, `index for ${revisionId}`);
      const service = yield* LatexSyncTex;
      yield* service.publishIndex({
        artifactId,
        revisionId,
        workspaceRoot,
        rootRelativePath: "main.tex",
        compileDirectory,
        syncTexPath,
      });
    }).pipe(Effect.provide(serviceLayer));

  const navigationDirectory = (revisionId: ArtifactRevisionId) =>
    path.join(baseDir, "userdata", "latex", "synctex", artifactId, revisionId);

  return {
    workspaceRoot,
    bodyPath,
    compileDirectory,
    baseDir,
    liveRevisions,
    invocations,
    navigationOutput,
    runtimeError,
    inverseInputPath,
    serviceLayer,
    publish,
    navigationDirectory,
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
      expect(forward).toEqual({ _tag: "found", page: 2, x: 18, y: 72 });

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

  it.effect("confines forward and inverse source paths to the workspace", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      const forward = yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "../outside.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 1,
      });
      expect(forward).toMatchObject({ _tag: "unavailable", reason: "invalid-source" });
      expect(yield* Ref.get(harness.invocations)).toHaveLength(0);

      yield* Ref.set(harness.inverseInputPath, path.join(harness.baseDir, "outside.tex"));
      const inverse = yield* service.inverse({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        artifactId,
        revisionId: firstRevisionId,
        page: 2,
        x: 18,
        y: 72,
      });
      expect(inverse).toMatchObject({ _tag: "unavailable", reason: "invalid-source" });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("uses the first workspace-contained inverse candidate in helper order", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      yield* Ref.set(
        harness.navigationOutput,
        processOutput(`SyncTeX result begin
Output:main.pdf
Input:${path.join(harness.baseDir, "texmf", "article.cls")}
Line:900
Column:-1
Output:main.pdf
Input:${harness.bodyPath}
Line:51
Column:-1
Output:main.pdf
Input:${harness.bodyPath}
Line:52
Column:-1
SyncTeX result end`),
      );
      expect(
        yield* service.inverse({
          workspaceRoot: harness.workspaceRoot,
          rootRelativePath: "main.tex",
          artifactId,
          revisionId: firstRevisionId,
          page: 1,
          x: 100,
          y: 600,
        }),
      ).toEqual({
        _tag: "found",
        relativePath: "chapters/body.tex",
        line: 51,
        column: null,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("passes source column and current PDF page as forward-search context", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "chapters/body.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 17,
        column: 11,
        pageHint: 3,
      });

      expect((yield* Ref.get(harness.invocations)).at(-1)?.args).toEqual([
        "view",
        "-i",
        `17:11:3:${harness.bodyPath}`,
        "-o",
        expect.stringMatching(/main-revision-latex-synctex-first\.pdf$/u),
        "-d",
        expect.stringMatching(/revision-latex-synctex-first$/u),
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("uses the bundled runtime and ignores legacy persisted command paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));

      yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "chapters/body.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 17,
      });
      expect((yield* Ref.get(harness.invocations)).at(-1)?.command).toBe("/bundled/synctex");

      // Version 1 persisted an executable and bin directory. Treat both as
      // untrusted migration input. The current verified bundled runtime still
      // supplies the command, independently of the producing LaTeX engine.
      const navigationDirectory = harness.navigationDirectory(firstRevisionId);
      const outputFileName = "main-revision-latex-synctex-first.pdf";
      yield* fileSystem.writeFileString(
        path.join(navigationDirectory, "navigation.json"),
        `${encodeLegacyNavigationMetadata({
          schemaVersion: 1,
          workspaceRoot: harness.workspaceRoot,
          rootRelativePath: "main.tex",
          compileDirectory: harness.compileDirectory,
          outputFileName,
          command: path.join(harness.baseDir, "outside", "synctex"),
          binDirectory: path.join(harness.baseDir, "outside"),
        })}\n`,
      );
      yield* service.forward({
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "chapters/body.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 17,
      });
      expect((yield* Ref.get(harness.invocations)).at(-1)?.command).toBe("/bundled/synctex");
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

  it.effect("reports each native navigation failure without collapsing its cause", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.publish(firstRevisionId);
      const service = yield* LatexSyncTex.pipe(Effect.provide(harness.serviceLayer));
      const request = {
        workspaceRoot: harness.workspaceRoot,
        rootRelativePath: "main.tex",
        sourceRelativePath: "chapters/body.tex",
        artifactId,
        revisionId: firstRevisionId,
        line: 17,
      } as const;

      yield* Ref.set(harness.navigationOutput, {
        ...processOutput(""),
        code: null,
        timedOut: true,
      });
      expect(yield* service.forward(request)).toMatchObject({
        _tag: "unavailable",
        reason: "query-timed-out",
      });

      yield* Ref.set(harness.navigationOutput, {
        ...processOutput(""),
        code: ChildProcessSpawner.ExitCode(2),
      });
      expect(yield* service.forward(request)).toMatchObject({
        _tag: "unavailable",
        reason: "navigator-failed",
      });

      yield* Ref.set(harness.navigationOutput, processOutput("not a SyncTeX result"));
      expect(yield* service.forward(request)).toMatchObject({
        _tag: "unavailable",
        reason: "position-unmapped",
      });

      yield* Ref.set(harness.navigationOutput, "spawn-error");
      expect(yield* service.forward(request)).toMatchObject({
        _tag: "unavailable",
        reason: "navigator-failed",
      });

      yield* Ref.set(harness.navigationOutput, null);
      yield* Ref.set(
        harness.runtimeError,
        new SyncTexRuntime.SyncTexRuntimeError({
          reason: "damaged",
          detail: "Scient's source-navigation helper failed its integrity check.",
        }),
      );
      expect(yield* service.forward(request)).toMatchObject({
        _tag: "unavailable",
        reason: "navigator-unavailable",
        message: expect.stringContaining("integrity check"),
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
