// @effect-diagnostics nodeBuiltinImport:off -- Promise adapter fixtures write only scoped synthetic staging.
import * as NodeFSP from "node:fs/promises";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { ComputeLanguageId } from "@t3tools/contracts";
import {
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisOperationError,
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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ScientificRuntimePreferences from "../compute/ScientificRuntimePreferences.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { AnalyticsService, type AnalyticsStatus } from "../../telemetry/AnalyticsService.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import * as AnalysisRunIndex from "./AnalysisRunIndex.ts";
import {
  AnalysisService,
  layerWithAdapters,
  recoveredOutputContentHash,
} from "./AnalysisService.ts";
import * as LocalAnalysisStore from "./LocalAnalysisStore.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";

const output: ReadonlyArray<ExecutionOutputChunk> = [
  {
    sequence: 0,
    stream: "stdout",
    text: "partial output\n",
    observedAt: "2026-08-13T00:00:00.000Z",
  },
];

const runtimeId = AnalysisRuntimeId.make("matlab:test");
const sourceContents = "% test source\n";
const sourceRevision = AnalysisSourceRevision.make(bytesRevision(Buffer.from(sourceContents)));
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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
  prepare: (context) => ({
    executable: "/test/matlab",
    args: [context.source.relativePath],
    cwd: context.source.cwd,
    environment: {},
  }),
};

const makeServiceTestLayer = Effect.fn("makeServiceTestLayer")(function* (
  adapter: AnalysisRuntimeAdapter = testAdapter,
  transformStore?: (
    store: LocalAnalysisStore.LocalAnalysisStore["Service"],
  ) => LocalAnalysisStore.LocalAnalysisStore["Service"],
  onProcessClose?: Effect.Effect<void>,
  /** Leaves the folder plain and registers it to the host under this name. */
  registeredFolder?: string,
  /** What each started program prints. */
  printed?: (executable: string) => string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projectRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-project-",
  });
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "scient-analysis-service-state-",
  });
  if (registeredFolder === undefined)
    yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
  const projectId =
    registeredFolder ??
    (yield* Effect.promise(() => readScientProjectIdentity(projectRoot))).projectId;
  yield* Effect.forEach(
    [
      "cancel-publishing.m",
      "launch-error.m",
      "first-capture.m",
      "cancel-capture.m",
      "private-study.m",
      "later-error.m",
      "consent.m",
      "first.m",
      "queued.m",
      "cleanup.m",
      "owned.m",
      "wait.m",
      "disabled.m",
      "analysis.m",
      "second.m",
      "interrupted.m",
      "promote.m",
    ],
    (relativePath) => fileSystem.writeFileString(`${projectRoot}/${relativePath}`, sourceContents),
  );

  const startedRuns = yield* Queue.unbounded<ExecutionRunId>();
  const processExits = new Map<ExecutionRunId, Deferred.Deferred<number>>();
  const processStartCount = yield* Ref.make(0);
  const processPort: ExecutionProcessPort = {
    start: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(processStartCount, (count) => count + 1);
        const exitCode = yield* Deferred.make<number>();
        if (onProcessClose !== undefined) yield* Effect.addFinalizer(() => onProcessClose);
        processExits.set(request.runId, exitCode);
        yield* Queue.offer(startedRuns, request.runId);
        const text = printed?.(request.executable) ?? "";
        return {
          output: text === "" ? Stream.empty : Stream.make({ stream: "stdout" as const, text }),
          exitCode: Deferred.await(exitCode),
          cancel: Deferred.succeed(exitCode, 130).pipe(Effect.asVoid),
        };
      }),
  };
  const workspaceLayer = WorkspaceFileSystem.layer.pipe(
    Layer.provide(layerKnownWorkspacesAllowAll),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(ServerConfig.layerTest(projectRoot, baseDir)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const indexLayer = AnalysisRunIndex.layer.pipe(Layer.provide(SqlitePersistenceMemory));
  const localStoreLayer = LocalAnalysisStore.layer.pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(projectRoot, baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const serviceStoreLayer = transformStore
    ? Layer.effect(
        LocalAnalysisStore.LocalAnalysisStore,
        Effect.map(LocalAnalysisStore.LocalAnalysisStore, transformStore),
      ).pipe(Layer.provide(localStoreLayer))
    : localStoreLayer;
  const settingsLayer = ServerSettings.layerTest({
    scientificComputing: { languages: { [ComputeLanguageId.make("matlab")]: {} } },
  });
  const analysisLayer = layerWithAdapters([adapter]).pipe(
    Layer.provide(
      registeredFolder === undefined
        ? Layer.empty
        : Layer.succeed(WorkspaceBindingResolver, {
            resolveWorkspaceRoot: () =>
              Effect.succeed({ binding: { bindingId: registeredFolder } }),
          } as never),
    ),
    Layer.provide(
      ScientificRuntimePreferences.layer.pipe(
        Layer.provide(serviceStoreLayer),
        Layer.provide(settingsLayer),
      ),
    ),
    Layer.provideMerge(settingsLayer),
    Layer.provide(serviceStoreLayer),
    Layer.provide(indexLayer),
    Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, processPort)),
    Layer.provide(workspaceLayer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return {
    analysisLayer,
    localStoreLayer,
    processStartCount,
    processExits,
    projectId,
    projectRoot,
    startedRuns,
  };
});

const serviceTestLayer = makeServiceTestLayer();

const analyticsFixture = Effect.gen(function* () {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  const terminalEvents = yield* Queue.unbounded<string>();
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const service = AnalyticsService.of({
    recordOwners: () => Effect.void,
    record: (name, properties) =>
      Effect.gen(function* () {
        events.push({ name, properties });
        if (name !== "scient.operation.started") yield* Queue.offer(terminalEvents, name);
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    flush: Effect.void,
  });
  const setConsent = (consent: AnalyticsStatus["consent"]) =>
    Effect.sync(() => {
      status = { available: true, consent };
      epoch += 1;
    });
  return { events, terminalEvents, service, setConsent };
});

type ArtifactFixtureMode =
  | "captured"
  | "empty"
  | "warning"
  | "collection-error"
  | "publication-error";

const artifactTestAdapter = (mode: ArtifactFixtureMode): AnalysisRuntimeAdapter => ({
  ...testAdapter,
  prepareRun: async ({ artifactStagingDirectory }) => {
    await NodeFSP.mkdir(`${artifactStagingDirectory}/files`, { recursive: true });
    await NodeFSP.writeFile(
      `${artifactStagingDirectory}/files/private-figure.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg"><title>private-result</title></svg>',
    );
  },
  collectArtifacts: async () => {
    if (mode === "collection-error") throw new Error("private capture detail /private/source");
    return {
      failureMessage: mode === "warning" ? "private partial capture warning" : null,
      candidates:
        mode === "empty"
          ? []
          : [
              {
                artifactId: AnalysisArtifactId.make("private-figure-id"),
                kind: "figure",
                label: "Private scientific figure",
                representations: [
                  {
                    representationId: AnalysisArtifactRepresentationId.make(
                      "private-representation-id",
                    ),
                    fileName: AnalysisArtifactFileName.make(
                      mode === "publication-error" ? "missing.svg" : "private-figure.svg",
                    ),
                    mediaType: "image/svg+xml",
                    presentation: "static",
                    requiresNetworkForFullExperience: false,
                  },
                ],
              },
            ],
    };
  },
});

describe("analysis artifact analytics", () => {
  it.effect.each(
    (["captured", "warning"] as const).map((mode) => ({
      caseTitle: `preserves ${mode} publication independently of concurrent cancellation`,
      mode,
    })),
  )("$caseTitle", ({ mode }) =>
    Effect.gen(function* () {
      const publishing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeServiceTestLayer(artifactTestAdapter(mode), (store) => ({
        ...store,
        publishArtifacts: (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(publishing, undefined);
            yield* Deferred.await(release);
            return yield* store.publishArtifacts(input);
          }),
      }));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "cancel-publishing.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
          yield* Deferred.await(publishing);
          yield* service.cancelRun({ cwd: harness.projectRoot, runId });
          yield* Deferred.succeed(release, undefined);
          const expected = mode === "warning" ? "failed" : "completed";
          expect(yield* Queue.take(analytics.terminalEvents)).toBe(`scient.operation.${expected}`);
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.receipt.status).toBe("cancelled");
          expect(persisted.artifacts).toHaveLength(1);
          expect(persisted.artifactReceipt.status).toBe(
            mode === "warning" ? "failed" : "succeeded",
          );
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual(["scient.operation.started", `scient.operation.${expected}`]);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("runs once on another install, and only one the runtime offered", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer({
        ...testAdapter,
        inspect: async ({ inspectedAt }) => ({
          ...runtimeProfile(inspectedAt),
          alternatives: [
            { executablePath: "/older/matlab", label: "MATLAB test runtime 1", version: "1" },
            { executablePath: "/other/matlab", label: "MATLAB test runtime 2", version: "2" },
          ],
        }),
      });
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const request = {
            cwd: harness.projectRoot,
            relativePath: "launch-error.m",
            sourceRevision,
            runtimeId,
          };
          const refused = yield* Effect.flip(
            service.startRun({ ...request, executablePath: "/not/offered" }),
          );
          expect(refused.reason).toBe("runtime-invalid");
          const runId = ExecutionRunId.make("alternative-run");
          const run = yield* service.startRun({
            ...request,
            runId,
            executablePath: "/older/matlab",
          });
          expect(run.runtime.executablePath).toBe("/older/matlab");
          expect(run.runtime.version).toBe("1");
          const retried = yield* service.startRun({
            ...request,
            runId,
            executablePath: "/older/matlab",
          });
          expect(retried.receipt.runId).toBe(runId);
          const conflicting = yield* Effect.flip(
            service.startRun({ ...request, runId, executablePath: "/other/matlab" }),
          );
          expect(conflicting.reason).toBe("run-already-active");
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("reports a failed requested capture when preparation prevents process launch", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer({
        ...artifactTestAdapter("captured"),
        prepareRun: async () => {
          throw new Error("private setup detail");
        },
      });
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const run = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "launch-error.m",
            sourceRevision,
            runtimeId,
          });
          yield* Queue.take(analytics.terminalEvents);
          yield* Queue.take(analytics.terminalEvents);
          const persisted = yield* service.getRun({
            cwd: harness.projectRoot,
            runId: run.receipt.runId,
          });
          expect(persisted.receipt.status).toBe("failed");
          expect(persisted.artifactReceipt.status).toBe("failed");
          expect(persisted.artifacts).toHaveLength(0);
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual(["scient.operation.started", "scient.operation.failed"]);
          expect(yield* Ref.get(harness.processStartCount)).toBe(0);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("reports queued capture cancellation without launching its process", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "first-capture.m",
            sourceRevision,
            runtimeId,
          });
          const firstId = yield* Queue.take(harness.startedRuns);
          const queued = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "cancel-capture.m",
            sourceRevision,
            runtimeId,
          });
          const cancelled = yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: queued.receipt.runId,
          });
          expect(cancelled.receipt.status).toBe("cancelled");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.cancelled");
          yield* Deferred.succeed(harness.processExits.get(firstId)!, 0);
          yield* Queue.take(analytics.terminalEvents);
          yield* Queue.take(analytics.terminalEvents);
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual([
            "scient.operation.started",
            "scient.operation.started",
            "scient.operation.cancelled",
            "scient.operation.completed",
          ]);
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect.each(
    (
      [
        { mode: "captured", exitCode: 0, outcome: "completed", artifacts: 1 },
        { mode: "captured", exitCode: 1, outcome: "completed", artifacts: 1 },
        { mode: "empty", exitCode: 0, outcome: "skipped", artifacts: 0 },
        { mode: "warning", exitCode: 0, outcome: "failed", artifacts: 1 },
        { mode: "collection-error", exitCode: 0, outcome: "failed", artifacts: 0 },
        { mode: "publication-error", exitCode: 0, outcome: "failed", artifacts: 0 },
      ] as const
    ).map((scenario) => ({
      caseTitle: `separates ${scenario.mode} capture from process exit ${scenario.exitCode}`,
      scenario,
    })),
  )("$caseTitle", ({ scenario }) =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(artifactTestAdapter(scenario.mode));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const run = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "private-study.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          expect(analytics.events.map((event) => event.properties?.operationKind)).toEqual([
            "compute-run",
            "compute-artifact",
          ]);
          yield* Deferred.succeed(harness.processExits.get(runId)!, scenario.exitCode);
          expect(yield* Queue.take(analytics.terminalEvents)).toBe(
            `scient.operation.${scenario.outcome}`,
          );
          expect(yield* Queue.take(analytics.terminalEvents)).toBe(
            scenario.exitCode === 0 ? "scient.operation.completed" : "scient.operation.failed",
          );
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.receipt.status).toBe(scenario.exitCode === 0 ? "succeeded" : "failed");
          expect(persisted.artifactReceipt.status).toBe(
            scenario.outcome === "failed" ? "failed" : "succeeded",
          );
          expect(persisted.artifacts).toHaveLength(scenario.artifacts);
          yield* service.listRuns({ cwd: harness.projectRoot });
          const captureEvents = analytics.events.filter(
            (event) => event.properties?.operationKind === "compute-artifact",
          );
          expect(captureEvents.map((event) => event.name)).toEqual([
            "scient.operation.started",
            `scient.operation.${scenario.outcome}`,
          ]);
          expect(captureEvents[1]?.properties).toMatchObject({
            operationKind: "compute-artifact",
            trigger: "user",
            durationMs: expect.any(Number),
            failureClass: "unknown",
            captureSchemaVersion: 2,
            captureSource: "run-file",
          });
          if (scenario.outcome === "failed") {
            expect(captureEvents[1]?.properties).not.toHaveProperty("rejectedOutputCount");
          } else {
            expect(captureEvents[1]?.properties).toHaveProperty("rejectedOutputCount", 0);
          }
          const payload = yield* encodeUnknownJson(analytics.events);
          for (const privateValue of [
            harness.projectRoot,
            harness.projectId,
            String(run.receipt.runId),
            "private-",
            "Private scientific",
            "private partial",
            "private capture",
            "missing.svg",
          ]) {
            expect(payload).not.toContain(privateValue);
          }
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("keeps the saved capture outcome when later run bookkeeping fails", () =>
    Effect.gen(function* () {
      let failed = false;
      const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"), (store) => ({
        ...store,
        measureRunStorage: (projectId, runId) =>
          Effect.suspend(() => {
            if (failed) return store.measureRunStorage(projectId, runId);
            failed = true;
            return Effect.fail(
              new LocalAnalysisStore.LocalAnalysisStoreError({
                operation: "measure-run-storage",
                path: "/private/fixture",
                cause: "private bookkeeping failure",
              }),
            );
          }),
      }));
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "later-error.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.completed");
          expect(yield* Queue.take(analytics.terminalEvents)).toBe("scient.operation.failed");
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.artifactReceipt.status).toBe("succeeded");
          expect(persisted.artifacts).toHaveLength(1);
          expect(persisted.receipt.status).toBe("failed");
          expect(
            analytics.events
              .filter((event) => event.properties?.operationKind === "compute-artifact")
              .map((event) => event.name),
          ).toEqual(["scient.operation.started", "scient.operation.completed"]);
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect.each(
    (["off", "epoch-change", "broken"] as const).map((mode) => ({
      caseTitle: `keeps capture functional with ${mode} analytics without replay`,
      mode,
    })),
  )("$caseTitle", ({ mode }) =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(artifactTestAdapter("captured"));
      const analytics = yield* analyticsFixture;
      if (mode === "off") yield* analytics.setConsent("off");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "consent.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          if (mode === "epoch-change") yield* analytics.setConsent("off");
          yield* analytics.setConsent("product");
          const updates = yield* service.subscribeRuns({ cwd: harness.projectRoot });
          yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
          yield* updates.pipe(
            Stream.filter(
              (event) =>
                event._tag !== "run-output" &&
                event.run.receipt.runId === runId &&
                event.run.receipt.status === "succeeded",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.artifacts).toHaveLength(1);
          expect(persisted.artifactReceipt.status).toBe("succeeded");
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  AnalyticsService,
                  mode === "broken"
                    ? {
                        ...analytics.service,
                        record: () => Effect.die("private analytics failure"),
                      }
                    : analytics.service,
                ),
              ),
            ),
          ),
        ),
      );
      expect(analytics.events.map((event) => event.name)).toEqual(
        mode === "epoch-change" ? ["scient.operation.started", "scient.operation.started"] : [],
      );
      expect(yield* Ref.get(harness.processStartCount)).toBe(1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});

describe("analysis outcome analytics", () => {
  it.effect.each(
    (["off", "epoch-change", "broken"] as const).map((mode) => ({
      caseTitle: `keeps execution intact with ${mode} analytics and does not replay active work`,
      mode,
    })),
  )("$caseTitle", ({ mode }) =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const analytics = yield* analyticsFixture;
      if (mode === "off") yield* analytics.setConsent("off");
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
          const queued = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "queued.m",
            sourceRevision,
            runtimeId,
          });
          if (mode === "epoch-change") yield* analytics.setConsent("off");
          yield* analytics.setConsent("product");
          const cancelled = yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: queued.receipt.runId,
          });
          expect(cancelled.receipt.status).toBe("cancelled");
          yield* service.cancelRun({ cwd: harness.projectRoot, runId: first.receipt.runId });
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  AnalyticsService,
                  mode === "broken"
                    ? {
                        ...analytics.service,
                        status: Effect.die("private observer failure"),
                      }
                    : analytics.service,
                ),
              ),
            ),
          ),
        ),
      );
      expect(analytics.events.map((event) => event.name)).toEqual(
        mode === "epoch-change" ? ["scient.operation.started", "scient.operation.started"] : [],
      );
      expect(yield* Ref.get(harness.processStartCount)).toBe(1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
  it.effect.each(
    (["completed", "failed", "cancelled"] as const).map((outcome) => ({
      caseTitle: `observes one durable ${outcome} outcome without exporting run data`,
      outcome,
    })),
  )("$caseTitle", ({ outcome }) =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const analytics = yield* analyticsFixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const run = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "private-study.m",
            sourceRevision,
            runtimeId,
          });
          const runId = yield* Queue.take(harness.startedRuns);
          expect(analytics.events.map((event) => event.name)).toEqual(["scient.operation.started"]);
          if (outcome === "cancelled") {
            yield* service.cancelRun({ cwd: harness.projectRoot, runId });
          } else {
            yield* Deferred.succeed(harness.processExits.get(runId)!, outcome === "failed" ? 1 : 0);
          }
          expect(yield* Queue.take(analytics.terminalEvents)).toBe(`scient.operation.${outcome}`);
          const persisted = yield* service.getRun({ cwd: harness.projectRoot, runId });
          expect(persisted.receipt.status).toBe(outcome === "completed" ? "succeeded" : outcome);
          yield* service.listRuns({ cwd: harness.projectRoot, limit: 20 });
          expect(analytics.events).toEqual([
            {
              name: "scient.operation.started",
              properties: {
                operationKind: "compute-run",
                trigger: "user",
                durationMs: undefined,
                failureClass: "unknown",
              },
            },
            {
              name: `scient.operation.${outcome}`,
              properties: {
                operationKind: "compute-run",
                trigger: "user",
                durationMs: expect.any(Number),
                failureClass: "unknown",
              },
            },
          ]);
          const payload = yield* encodeUnknownJson(analytics.events);
          for (const privateValue of [
            harness.projectRoot,
            harness.projectId,
            String(run.receipt.runId),
            "private-study",
            "test-source",
            "test/matlab",
          ]) {
            expect(payload).not.toContain(privateValue);
          }
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});

describe("analysis restart recovery", () => {
  it("preserves a fidelity hash only when recovered output is known complete", () => {
    expect(recoveredOutputContentHash(output, false)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(recoveredOutputContentHash(output, true)).toBeNull();
  });
});

describe("analysis service coordination", () => {
  it.effect("reports native cleanup failure instead of acknowledging a completed close", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(
        testAdapter,
        undefined,
        Effect.die(new Error("synthetic process cleanup failure")),
      );
      yield* Effect.gen(function* () {
        const service = yield* AnalysisService;
        const run = yield* service.startRun({
          cwd: harness.projectRoot,
          relativePath: "cleanup.m",
          sourceRevision,
          runtimeId,
        });
        yield* Queue.take(harness.startedRuns);
        const close = { cwd: harness.projectRoot, runId: run.receipt.runId, waitForExit: true };
        expect((yield* Effect.flip(service.cancelRun(close))).reason).toBe("process-failed");
        expect((yield* service.getRun(close)).receipt.failureMessage).toContain(
          "could not be cleaned up",
        );
        expect((yield* Effect.flip(service.cancelRun(close))).reason).toBe("process-failed");
      }).pipe(Effect.provide(harness.analysisLayer), Effect.scoped);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
  it.effect("retries a caller-owned batch identity without replaying its process", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      yield* Effect.gen(function* () {
        const service = yield* AnalysisService;
        const input = {
          cwd: harness.projectRoot,
          relativePath: "owned.m",
          sourceRevision,
          runtimeId,
          runId: ExecutionRunId.make("owned-batch"),
        };
        const first = yield* service.startRun(input);
        yield* Queue.take(harness.startedRuns);
        expect((yield* service.startRun(input)).receipt.runId).toBe(first.receipt.runId);
        const stopped = yield* service.cancelRun({
          cwd: harness.projectRoot,
          runId: first.receipt.runId,
          waitForExit: true,
        });
        expect(stopped.receipt.status).toBe("cancelled");
        expect((yield* service.startRun(input)).receipt.status).toBe("cancelled");
        expect(yield* Ref.get(harness.processStartCount)).toBe(1);
        expect(
          (yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: first.receipt.runId,
            waitForExit: true,
          })).receipt.status,
        ).toBe("cancelled");
      }).pipe(Effect.provide(harness.analysisLayer), Effect.scoped);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("tab close waits for the native process scope, not only its terminal receipt", () =>
    Effect.gen(function* () {
      const cleanupEntered = yield* Deferred.make<void>();
      const cleanupRelease = yield* Deferred.make<void>();
      const harness = yield* makeServiceTestLayer(
        testAdapter,
        undefined,
        Deferred.succeed(cleanupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(cleanupRelease)),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* AnalysisService;
        const run = yield* service.startRun({
          cwd: harness.projectRoot,
          relativePath: "wait.m",
          sourceRevision,
          runtimeId,
        });
        yield* Queue.take(harness.startedRuns);
        const returned = yield* Ref.make(false);
        const closing = yield* service
          .cancelRun({ cwd: harness.projectRoot, runId: run.receipt.runId, waitForExit: true })
          .pipe(
            Effect.tap(() => Ref.set(returned, true)),
            Effect.forkChild,
          );
        yield* Deferred.await(cleanupEntered);
        expect(yield* Ref.get(returned)).toBe(false);
        yield* Deferred.succeed(cleanupRelease, undefined);
        expect((yield* Fiber.join(closing)).receipt.status).toBe("cancelled");
      }).pipe(Effect.provide(harness.analysisLayer), Effect.scoped);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("says what is missing when an adapter names it, and keeps other failures plain", () =>
    Effect.gen(function* () {
      for (const [thrown, shown] of [
        [
          new AnalysisOperationError({
            operation: "start",
            reason: "runtime-missing",
            message: "Install Lean with elan, which brings Lake.",
          }),
          "Install Lean with elan, which brings Lake.",
        ],
        [new Error("private detail"), "MATLAB test runtime could not be started or completed."],
      ] as const) {
        const harness = yield* makeServiceTestLayer({
          ...testAdapter,
          prepare: () => {
            throw thrown;
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            const run = yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "launch-error.m",
              sourceRevision,
              runtimeId,
            });
            const failed = yield* service
              .getRun({ cwd: harness.projectRoot, runId: run.receipt.runId })
              .pipe(Effect.repeat({ until: (current) => current.receipt.status === "failed" }));
            expect(failed.receipt.failureMessage).toBe(shown);
            expect(yield* Ref.get(harness.processStartCount)).toBe(0);
          }).pipe(Effect.provide(harness.analysisLayer)),
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("lets an adapter whose results are files show them and say how the run went", () =>
    Effect.gen(function* () {
      const diagnostic = {
        diagnosticId: "stata-error-1",
        severity: "error",
        source: "runtime",
        code: "r(601)",
        message: "file nothere.dta not found",
        relativePath: "analysis.m",
        line: 2,
        column: null,
        frames: [],
        related: [],
      } as const;
      const terminal = new Set(["succeeded", "failed", "cancelled"]);
      for (const scenario of [
        { exitCode: 0, failureMessage: "file nothere.dta not found (r(601))", status: "failed" },
        { exitCode: 1, failureMessage: null, status: "succeeded" },
        { exitCode: 0, throws: true, status: "failed" },
        { exitCode: 3, throws: true, status: "failed" },
        { cancel: true, failureMessage: null, status: "cancelled" },
      ] as const) {
        const harness = yield* makeServiceTestLayer({
          ...testAdapter,
          concludeRun: async () => {
            if ("throws" in scenario) throw new Error("private detail");
            return {
              output: [{ stream: "stdout", text: "the log\n" }],
              failureMessage: scenario.failureMessage,
              diagnostics: scenario.failureMessage === null ? [] : [diagnostic],
              writtenFiles: ["analysis.log"],
            };
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "analysis.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            if ("cancel" in scenario) yield* service.cancelRun({ cwd: harness.projectRoot, runId });
            else yield* Deferred.succeed(harness.processExits.get(runId)!, scenario.exitCode);
            const finished = yield* service
              .getRun({ cwd: harness.projectRoot, runId })
              .pipe(Effect.repeat({ until: (current) => terminal.has(current.receipt.status) }));
            expect(finished.receipt.status).toBe(scenario.status);
            if ("throws" in scenario) {
              expect(finished.receipt.output).toEqual([]);
              // Unreadable results never pass a run whose exit code cannot be trusted.
              expect(finished.receipt.failureMessage).toBe(
                scenario.exitCode === 0
                  ? "Scient could not read the MATLAB test runtime results."
                  : "MATLAB test runtime exited with code 3, and Scient could not read its results.",
              );
              return;
            }
            expect(finished.receipt.output.map((chunk) => chunk.text)).toEqual(["the log\n"]);
            expect(finished.writtenFiles).toEqual(["analysis.log"]);
            if ("exitCode" in scenario) expect(finished.receipt.exitCode).toBe(scenario.exitCode);
            if (scenario.status !== "cancelled") {
              expect(finished.receipt.failureMessage).toBe(scenario.failureMessage);
              expect(finished.diagnostics).toEqual(
                scenario.failureMessage === null ? [] : [diagnostic],
              );
            }
          }).pipe(Effect.provide(harness.analysisLayer)),
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("shows a build step's output only when the build fails", () =>
    Effect.gen(function* () {
      const terminal = new Set(["succeeded", "failed", "cancelled"]);
      for (const scenario of [
        { build: 0, output: ["the result\n"], status: "succeeded" },
        { build: 2, output: ["the build error\n"], status: "failed" },
        { cancel: true, output: [], status: "cancelled" },
      ] as const) {
        const harness = yield* makeServiceTestLayer(
          {
            ...testAdapter,
            prepare: (context) => ({
              executable: "/test/result",
              args: [],
              cwd: context.source.cwd,
              environment: {},
              before: [
                {
                  executable: "/test/build",
                  args: [],
                  cwd: context.source.cwd,
                  environment: {},
                  showOutput: "on-failure",
                },
              ],
            }),
          },
          undefined,
          undefined,
          undefined,
          (executable) => (executable === "/test/build" ? "the build error\n" : "the result\n"),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* AnalysisService;
            yield* service.startRun({
              cwd: harness.projectRoot,
              relativePath: "analysis.m",
              sourceRevision,
              runtimeId,
            });
            const runId = yield* Queue.take(harness.startedRuns);
            if ("cancel" in scenario) {
              yield* service.cancelRun({ cwd: harness.projectRoot, runId });
            } else {
              yield* Deferred.succeed(harness.processExits.get(runId)!, scenario.build);
              if (scenario.build === 0) {
                yield* Queue.take(harness.startedRuns);
                yield* Deferred.succeed(harness.processExits.get(runId)!, 0);
              }
            }
            const finished = yield* service
              .getRun({ cwd: harness.projectRoot, runId })
              .pipe(Effect.repeat({ until: (current) => terminal.has(current.receipt.status) }));
            expect(finished.receipt.status).toBe(scenario.status);
            expect(finished.receipt.output.map((chunk) => chunk.text)).toEqual(scenario.output);
          }).pipe(Effect.provide(harness.analysisLayer)),
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("never runs a file that changed while its run was waiting", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const fileSystem = yield* FileSystem.FileSystem;
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
          const waiting = yield* service.startRun({
            cwd: harness.projectRoot,
            relativePath: "queued.m",
            sourceRevision,
            runtimeId,
          });
          yield* fileSystem.writeFileString(`${harness.projectRoot}/queued.m`, "% changed\n");
          yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: first.receipt.runId,
            waitForExit: true,
          });
          const refused = yield* service
            .getRun({ cwd: harness.projectRoot, runId: waiting.receipt.runId })
            .pipe(Effect.repeat({ until: (run) => run.receipt.status === "failed" }));
          expect(refused.receipt.failureMessage).toContain("changed while the run was waiting");
          expect(yield* Ref.get(harness.processStartCount)).toBe(1);
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("runs files in a registered folder, and keeps them after the folder is set up", () =>
    Effect.gen(function* () {
      const harness = yield* makeServiceTestLayer(testAdapter, undefined, undefined, "folder-1");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalysisService;
          const request = {
            cwd: harness.projectRoot,
            relativePath: "first.m",
            sourceRevision,
            runtimeId,
          };
          const run = yield* service.startRun(request);
          expect(run.projectId).toBe("folder-1");
          yield* Queue.take(harness.startedRuns);
          yield* service.cancelRun({
            cwd: harness.projectRoot,
            runId: run.receipt.runId,
            waitForExit: true,
          });

          yield* Effect.promise(() => initializeScientProject({ root: harness.projectRoot }));

          const history = yield* service.listRuns({ cwd: harness.projectRoot, limit: 10 });
          expect(history.runs.map(({ receipt }) => receipt.runId)).toEqual([run.receipt.runId]);
          expect((yield* service.startRun(request)).projectId).toBe("folder-1");
          yield* Queue.take(harness.startedRuns);
        }).pipe(Effect.provide(harness.analysisLayer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("recovers a persisted non-terminal run as lost on the first history read", () =>
    Effect.gen(function* () {
      const harness = yield* serviceTestLayer;
      const analytics = yield* analyticsFixture;
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
        }).pipe(
          Effect.provide(
            harness.analysisLayer.pipe(
              Layer.provide(Layer.succeed(AnalyticsService, analytics.service)),
            ),
          ),
        ),
      );
      expect(analytics.events).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );

  it.effect("never caches an old MATLAB profile under a failed new settings choice", () =>
    Effect.gen(function* () {
      let failNewChoice = true;
      const harness = yield* makeServiceTestLayer({
        ...testAdapter,
        inspect: async (input) => {
          if (input.customExecutablePath === "/new/matlab" && failNewChoice)
            throw new Error("Installation is temporarily unavailable");
          return testAdapter.inspect(input);
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* AnalysisService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* service.inspectRuntimes({ cwd: harness.projectRoot });
        yield* settings.updateSettings({
          scientificComputing: {
            languages: {
              [ComputeLanguageId.make("matlab")]: { executable: "/new/matlab" },
            },
          },
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            Exit.isFailure(
              yield* Effect.exit(service.inspectRuntimes({ cwd: harness.projectRoot })),
            ),
          ).toBe(true);
        }
        failNewChoice = false;
        const recovered = yield* service.inspectRuntimes({ cwd: harness.projectRoot });
        expect(recovered.runtimes[0]?.executablePath).toBe("/new/matlab");
      }).pipe(Effect.provide(harness.analysisLayer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});
