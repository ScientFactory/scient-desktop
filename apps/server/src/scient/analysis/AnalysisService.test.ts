import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import {
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRuntimeAdapter,
  type AnalysisRuntimeProfile,
  type AnalysisRunSnapshot,
} from "@scientfactory/analysis";
import {
  ExecutionRunId,
  type ExecutionOutputChunk,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as AnalysisRunIndex from "./AnalysisRunIndex.ts";
import {
  AnalysisService,
  layerWithAdapters,
  recoveredOutputContentHash,
} from "./AnalysisService.ts";
import * as LocalAnalysisStore from "./LocalAnalysisStore.ts";

const output: ReadonlyArray<ExecutionOutputChunk> = [
  {
    sequence: 0,
    stream: "stdout",
    text: "partial output\n",
    observedAt: "2026-08-13T00:00:00.000Z",
  },
];

const runtimeId = AnalysisRuntimeId.make("matlab:test");
const sourceRevision = AnalysisSourceRevision.make("sha256:test-source");

const runtimeProfile = (
  inspectedAt: string,
  executablePath = "/test/matlab",
): AnalysisRuntimeProfile => ({
  id: runtimeId,
  kind: "matlab",
  label: "MATLAB test runtime",
  availability: "available",
  source: "custom",
  executablePath,
  version: "test",
  detail: null,
  capabilities: ["run-file", "stream-output", "cancel-process-tree"],
  inspectedAt,
  verification: null,
});

const testAdapter: AnalysisRuntimeAdapter = {
  id: runtimeId,
  kind: "matlab",
  fileExtensions: [".m"],
  inspect: async ({ customExecutablePath, inspectedAt }) =>
    runtimeProfile(inspectedAt, customExecutablePath),
  prepareVerification: async (profile) => ({
    executableIdentity: `identity:${profile.executablePath ?? "missing"}`,
    executable: profile.executablePath ?? "/test/matlab",
    args: ["verify"],
    cwd: "/tmp",
    environment: {},
    timeoutMs: 1_000,
    collect: async (result) => ({
      status: result.exitCode === 0 ? "ready" : "startup-failed",
      verifiedAt: result.verifiedAt,
      durationMs: result.durationMs,
      executableIdentity: `identity:${profile.executablePath ?? "missing"}`,
      release: "test",
      version: "test",
      architecture: "test",
      installationRoot: profile.executablePath,
      javaAvailable: true,
      javaVersion: "test",
      toolboxes: [],
      detail: "Test runtime is ready.",
    }),
    cleanup: async () => undefined,
  }),
  prepare: (context) => ({
    executable: "/test/matlab",
    args: [context.source.relativePath],
    cwd: context.source.cwd,
    environment: {},
  }),
};

const serviceTestLayer = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const projectRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-project-",
  });
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-state-",
  });
  yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
  const projectIdentity = yield* Effect.promise(() => readScientProjectIdentity(projectRoot));

  const startedRuns = yield* Queue.unbounded<ExecutionRunId>();
  const processStartCount = yield* Ref.make(0);
  const processPort: ExecutionProcessPort = {
    start: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(processStartCount, (count) => count + 1);
        if (request.args[0] === "verify") {
          return {
            output: Stream.empty,
            exitCode: Effect.succeed(0),
            cancel: Effect.void,
          };
        }
        const exitCode = yield* Deferred.make<number>();
        yield* Queue.offer(startedRuns, request.runId);
        return {
          output: Stream.empty,
          exitCode: Deferred.await(exitCode),
          cancel: Deferred.succeed(exitCode, 130).pipe(Effect.asVoid),
        };
      }),
  };
  const workspaceFileSystem = WorkspaceFileSystem.WorkspaceFileSystem.of({
    inspectWriteTarget: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        canonicalRelativePath: input.relativePath,
        traversesSymlink: false,
      }),
    readFile: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents: "% test source\n",
        byteLength: 14,
        truncated: false,
        revision: sourceRevision,
      }),
    writeFile: () => Effect.die("writeFile is not used by the analysis service test"),
    renameFile: () => Effect.die("renameFile is not used by the analysis service test"),
    watchFile: () => Stream.empty,
  });
  const workspacePaths = WorkspacePaths.WorkspacePaths.of({
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: (input) =>
      Effect.succeed({
        absolutePath: `${input.workspaceRoot}/${input.relativePath}`,
        relativePath: input.relativePath,
      }),
  });
  const indexLayer = AnalysisRunIndex.layer.pipe(Layer.provide(SqlitePersistenceMemory));
  const localStoreLayer = LocalAnalysisStore.layer.pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(projectRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const analysisLayer = layerWithAdapters([testAdapter]).pipe(
    Layer.provide(localStoreLayer),
    Layer.provide(indexLayer),
    Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, processPort)),
    Layer.provide(Layer.succeed(WorkspaceFileSystem.WorkspaceFileSystem, workspaceFileSystem)),
    Layer.provide(Layer.succeed(WorkspacePaths.WorkspacePaths, workspacePaths)),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    analysisLayer,
    localStoreLayer,
    processStartCount,
    projectId: projectIdentity.projectId,
    projectRoot,
    startedRuns,
  };
});

describe("analysis restart recovery", () => {
  it("preserves a fidelity hash only when recovered output is known complete", () => {
    expect(recoveredOutputContentHash(output, false)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(recoveredOutputContentHash(output, true)).toBeNull();
  });
});

describe("analysis service coordination", () => {
  it.effect("serializes concurrent starts so one file cannot acquire two active runs", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const input = {
            cwd: harness.projectRoot,
            relativePath: "analysis.m",
            sourceRevision,
            runtimeId,
          };
          const results = yield* Effect.all(
            [service.startRun(input).pipe(Effect.exit), service.startRun(input).pipe(Effect.exit)],
            { concurrency: "unbounded" },
          );

          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(results.filter(Exit.isFailure)).toHaveLength(1);
          const startedRunId = yield* Queue.take(harness.startedRuns);
          yield* service.cancelRun({ cwd: harness.projectRoot, runId: startedRunId });
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("cancels a queued run without ever starting its process", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const first = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "first.m",
            sourceRevision,
            runtimeId,
          });
          yield* Queue.take(harness.startedRuns);
          const second = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "second.m",
            sourceRevision,
            runtimeId,
          });

          const cancelled = yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: second.receipt.runId,
          });
          expect(cancelled.receipt.status).toBe("cancelled");
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);
          yield* service.cancelRun({ cwd: harness.projectRoot, runId: first.receipt.runId });
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers a persisted non-terminal run as lost on the first history read", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const runId = ExecutionRunId.make("interrupted-run");
      const interruptedRun: AnalysisRunSnapshot = {
        contractVersion: 1,
        projectId: harness.projectId,
        action: "run-file",
        runtime: runtimeProfile("2026-08-13T00:00:00.000Z"),
        source: {
          cwd: harness.projectRoot,
          relativePath: "interrupted.m",
          revision: sourceRevision,
        },
        phase: "running",
        queuePosition: null,
        diagnostics: [],
        artifacts: [],
        artifactReceipt: { status: "not-requested", failureMessage: null },
        localStorage: {
          status: "retained",
          outputBytes: 0,
          artifactBytes: 0,
          totalBytes: 0,
          removedAt: null,
        },
        receipt: {
          runId,
          status: "running",
          startedAt: "2026-08-13T00:00:00.000Z",
          finishedAt: null,
          exitCode: null,
          failureMessage: null,
          cancellationRequested: false,
          outputTruncated: false,
          outputByteLength: 0,
          outputContentHash: null,
          output: [],
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore.LocalAnalysisStore;
          yield* store.persistRun(interruptedRun);
        }).pipe(Effect.provide(harness.localStoreLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const history = yield* service.listRuns({ cwd: harness.projectRoot, limit: 20 });
          expect(history.runs).toHaveLength(1);
          expect(history.runs[0]?.receipt).toMatchObject({
            runId,
            status: "lost",
            outputContentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          });
          expect(history.runs[0]?.receipt.finishedAt).not.toBeNull();
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reuses verification only until runtime configuration changes", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const first = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          const cached = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          expect(first.verification?.status).toBe("ready");
          expect(cached.verification?.executableIdentity).toBe(
            first.verification?.executableIdentity,
          );
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);

          yield* service.configureRuntime({
            cwd: harness.projectRoot,
            runtimeKind: "matlab",
            executablePath: "/test/other-matlab",
          });
          const refreshed = yield* service.verifyRuntime({
            cwd: harness.projectRoot,
            runtimeId,
          });
          expect(refreshed.verification?.executableIdentity).toBe("identity:/test/other-matlab");
          expect(yield* Ref.get(harness.processStartCount)).toBe(2);
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("promotes a persisted terminal run into its initialized project", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const runId = ExecutionRunId.make("promoted-run");
      const run: AnalysisRunSnapshot = {
        contractVersion: 1,
        projectId: harness.projectId,
        action: "run-file",
        runtime: runtimeProfile("2026-08-14T10:00:00.000Z"),
        source: {
          cwd: harness.projectRoot,
          relativePath: "promote.m",
          revision: sourceRevision,
        },
        phase: "finished",
        queuePosition: null,
        diagnostics: [],
        artifacts: [],
        artifactReceipt: { status: "succeeded", failureMessage: null },
        localStorage: {
          status: "retained",
          outputBytes: 9,
          artifactBytes: 0,
          totalBytes: 9,
          removedAt: null,
        },
        receipt: {
          runId,
          status: "succeeded",
          startedAt: "2026-08-14T10:00:00.000Z",
          finishedAt: "2026-08-14T10:00:01.000Z",
          exitCode: 0,
          failureMessage: null,
          cancellationRequested: false,
          outputTruncated: false,
          outputByteLength: 9,
          outputContentHash: null,
          output,
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore.LocalAnalysisStore;
          yield* store.persistRun(run);
          yield* Effect.forEach(
            output,
            (chunk) => store.appendOutput(harness.projectId, runId, chunk),
            {
              discard: true,
            },
          );
        }).pipe(Effect.provide(harness.localStoreLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const promotedResults = yield* Effect.all(
            [
              service.promoteRun({ cwd: harness.projectRoot, runId }),
              service.promoteRun({ cwd: harness.projectRoot, runId }),
            ],
            { concurrency: "unbounded" },
          );
          expect(promotedResults.map((result) => result.reused).toSorted()).toEqual([false, true]);
          const promoted = promotedResults[0]!;
          expect(promoted).toMatchObject({
            directoryRelativePath: "results/promote/20260814T100000Z-promoted-run",
            artifactFileCount: 0,
          });
          const fs = yield* FileSystem.FileSystem;
          expect(
            yield* fs.readFileString(`${harness.projectRoot}/${promoted.readmeRelativePath}`),
          ).toContain("MATLAB test runtime analysis result");
          expect(
            yield* fs.readFileString(
              `${harness.projectRoot}/${promoted.directoryRelativePath}/output.txt`,
            ),
          ).toBe("partial output\n");
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
