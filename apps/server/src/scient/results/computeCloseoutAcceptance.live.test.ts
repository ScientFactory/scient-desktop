// @effect-diagnostics nodeBuiltinImport:off -- opts in to a provided fixture and native Python.
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as OwnedLocalEndpoints from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import { ComputeMcpGateway } from "../../mcp/toolkits/compute/ComputeMcpGateway.ts";
import { stopScientNotebook } from "../../mcp/toolkits/compute/notebookHandlers.ts";
import { listScientResults, runScientResults } from "../../mcp/toolkits/compute/resultHandlers.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import { makeComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { ComputeSessionService } from "../compute/ComputeSessionService.ts";
import { computeWorkspaceResolverForTest } from "../compute/ComputeWorkspaceTestUtils.ts";
import * as LocalComputeStore from "../compute/LocalComputeStore.ts";
import * as PythonComputeRuntime from "../compute/PythonComputeRuntime.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { makeNotebookRunJobs } from "../notebook/NotebookRunJobs.ts";
import { makeNotebookStore } from "../notebook/NotebookStore.ts";
import { makeNotebookReader } from "../notebook/notebookReader.ts";
import { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";
import { ComputeResults, layer as resultsLayer } from "./ComputeResults.ts";
import { notebookCode } from "./handoff/notebookSource.ts";
import { makeResultHandoff } from "./handoff/ResultHandoff.ts";
import { makeResultOperations } from "./resultOperations.ts";
import { makeResultsReader } from "./resultRevisions.ts";

const python = NodeProcess.env.SCIENT_TEST_PYTHON;
const fixture = NodeProcess.env.SCIENT_TEST_THRESHOLD_PROJECT;
const recipientPython = NodeProcess.env.HANDOFF_TEST_RECIPIENT ?? python;

const makeAcceptanceLayers = (cwd: string, stateDir: string) => {
  const config = ServerConfig.layerTest(cwd, stateDir);
  const compute = PythonComputeRuntime.layer.pipe(
    Layer.provide(LocalComputeStore.layer),
    Layer.provide(LocalExecutionProcess.layer),
    Layer.provide(LocalDuplexProcess.layer),
    Layer.provide(OwnedLocalEndpoints.layer),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  const paths = WorkspacePaths.layer;
  const files = WorkspaceFileSystem.layer.pipe(
    Layer.provide(layerKnownWorkspacesAllowAll),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(paths))),
    Layer.provide(paths),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    compute,
    files,
    paths,
    config,
    resultsLayer.pipe(Layer.provide(compute), Layer.provide(config)),
    LocalExecutionProcess.layer.pipe(Layer.provide(NodeServices.layer)),
  );
};

describe.runIf(Boolean(python && fixture))("compute closeout live acceptance", () => {
  it.live(
    "covers setup failure skip/replay with inline animation and observed writes, sweep/reader/handoff, fail/retain, compare, and parameterized agent history",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const instance = yield* fs.makeTempDirectoryScoped({ prefix: "scient-acceptance-" });
        const cwd = `${instance}/project`;
        yield* fs.copy(fixture!, cwd);
        yield* Effect.promise(() => initializeScientProject({ root: cwd }));

        const layers = makeAcceptanceLayers(cwd, `${instance}/state`);
        yield* Effect.gen(function* () {
          const computeService = yield* ComputeSessionService;
          const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const { computeDir } = yield* ServerConfig.ServerConfig;
          const gateway = makeComputeRpcGateway({
            workspaceResolver: computeWorkspaceResolverForTest,
            compute: computeService,
            workspaceFileSystem: workspace,
            serverSettings: {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                scientificComputing: {
                  schemaVersion: 1,
                  languages: { python: { executable: python! } },
                },
              }),
            },
          });
          const notebooks = makeNotebookRuns({
            computeDir,
            jobs: yield* makeNotebookRunJobs,
            workspacePaths: yield* WorkspacePaths.WorkspacePaths,
            gateway,
            notebooks: yield* makeNotebookStore,
            notebookOutputs: makeComputeNotebookOutputs({
              gateway,
              compute: computeService,
              fileSystem: fs,
            }),
          });
          const results = yield* ComputeResults;
          const operations = makeResultOperations({
            gateway,
            results,
            runNotebookFresh: notebooks.run,
            runtimeDescriptors: computeService.runtimeDescriptors,
            workspace,
          });
          const notebookReader = makeNotebookReader(computeDir, gateway);
          const project = yield* gateway.project({ cwd });
          const reader = () => makeResultsReader({ computeDir }, project.projectId, project.root);

          // 1. Synthetic setup failure -> dependent cells skipped -> explicit replay -> inline SVG + GIF write attribution
          const sessionId = ComputeSessionId.make("acceptance-notebook-session");
          const started = yield* gateway.startSession({
            cwd,
            sessionId,
            languageId: ComputeLanguageId.make("python"),
            executable: null,
            owner: { _tag: "file", path: "animation.ipynb" },
          });
          const outsidePath = NodePath.join(instance, "scient-outside.txt");

          const waitExecutions = (ids: ReadonlyArray<ComputeExecutionId>) =>
            gateway.listAllExecutions({ cwd, sessionId }).pipe(
              Effect.map((list) =>
                ids.map((id) => list.find((entry) => entry.request.executionId === id)),
              ),
              Effect.repeat({
                // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- polling live kernel execution records until terminal
                schedule: Schedule.spaced(Duration.millis(50)),
                until: (records) =>
                  records.every(
                    (record) =>
                      record?.result !== null &&
                      record?.result !== undefined &&
                      TERMINAL_COMPUTE_EXECUTION_STATUSES.has(record.result.status),
                  ),
              }),
            );

          const failExecIds = [
            ComputeExecutionId.make("fail-setup"),
            ComputeExecutionId.make("fail-compute"),
            ComputeExecutionId.make("fail-animate"),
          ];
          yield* gateway.submitCells({
            cwd,
            sessionId,
            path: "animation.ipynb",
            expectedGeneration: started.generation,
            runAll: true,
            cells: [
              {
                cellId: "cell-setup",
                executionId: failExecIds[0]!,
                code: 'raise RuntimeError("missing synthetic config")',
              },
              {
                cellId: "cell-compute",
                executionId: failExecIds[1]!,
                code: "series = [value * scale for value in [1, 2, 3]]",
              },
              {
                cellId: "cell-animate",
                executionId: failExecIds[2]!,
                code: "print(sum(series))",
              },
            ],
          });
          const failedBatch = yield* waitExecutions(failExecIds);
          expect(failedBatch[0]?.result?.status).toBe("failed");
          expect(failedBatch[1]?.result?.status).toBe("cancelled");
          expect(failedBatch[1]?.result?.startedAt).toBeNull();
          expect(failedBatch[2]?.result?.status).toBe("cancelled");
          expect(failedBatch[2]?.result?.startedAt).toBeNull();
          const afterFailure = yield* gateway.getSession({ cwd, sessionId });
          expect(afterFailure?.lastNotebookBatch).toEqual({
            id: failExecIds[0],
            mode: "all",
            status: "failed",
            failedCell: 1,
            firstFailure: {
              path: "animation.ipynb",
              cell: "cell-setup",
              generation: started.generation,
            },
            count: 3,
            notRun: 2,
          });

          // Explicit replay with fixed setup -> inline SVG display + workspace GIF write (outside write excluded)
          const replayExecIds = [
            ComputeExecutionId.make("replay-setup"),
            ComputeExecutionId.make("replay-compute"),
            ComputeExecutionId.make("replay-animate"),
          ];
          yield* gateway.submitCells({
            cwd,
            sessionId,
            path: "animation.ipynb",
            expectedGeneration: started.generation,
            runAll: false,
            cells: [
              {
                cellId: "cell-setup",
                executionId: replayExecIds[0]!,
                code: "scale = 3",
              },
              {
                cellId: "cell-compute",
                executionId: replayExecIds[1]!,
                code: "series = [value * scale for value in [1, 2, 3]]",
              },
              {
                cellId: "cell-animate",
                executionId: replayExecIds[2]!,
                code: [
                  "import base64",
                  "from pathlib import Path",
                  "from IPython.display import SVG, display",
                  // Valid minimal 1x1 GIF written inside project
                  'gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")',
                  'Path("animation.gif").write_bytes(gif)',
                  `Path(${JSON.stringify(outsidePath)}).write_text("outside", encoding="utf-8")`,
                  'display(SVG(f\'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="14">{sum(series)}</text></svg>\'))',
                ].join("\n"),
              },
            ],
          });
          const replayed = yield* waitExecutions(replayExecIds);
          expect(replayed.map((entry) => entry?.result?.status)).toEqual([
            "succeeded",
            "succeeded",
            "succeeded",
          ]);
          const animateRecord = replayed[2]!;
          expect(animateRecord.result?.writtenFiles).toContain("animation.gif");
          expect(animateRecord.result?.writtenFiles).not.toContain(outsidePath);
          const animateOutputs = yield* gateway.listOutputs({
            cwd,
            sessionId,
            executionId: replayExecIds[2]!,
          });
          expect(
            animateOutputs.outputs.some(
              (output) =>
                output._tag === "display-data" &&
                output.bundle.representations.some((rep) => rep.mediaType === "image/svg+xml"),
            ),
          ).toBe(true);
          yield* gateway.stopSession({
            cwd,
            sessionId,
            expectedGeneration: started.generation,
          });
          yield* fs.remove(outsidePath).pipe(Effect.ignore);

          // 2. Publish a baseline, then sweep through a failure and preserve the baseline.
          const notebookAddress = { cwd, scriptPath: "threshold.ipynb" };
          const notebookFile = NodePath.join(cwd, notebookAddress.scriptPath);
          const source: { cells: unknown[] } = JSON.parse(yield* fs.readFileString(notebookFile));
          source.cells.splice(1, 0, {
            cell_type: "code",
            metadata: {},
            source: " ",
            execution_count: null,
            outputs: [],
          });
          yield* fs.writeFileString(notebookFile, JSON.stringify(source));
          const baseline = yield* operations.rerun({
            ...notebookAddress,
            parameters: { threshold: "0.5" },
          });
          if (baseline._tag !== "published")
            return yield* Effect.die(baseline.message ?? "No linked results were published.");
          const savedNotebook = yield* fs.readFile(notebookFile);

          const { runId } = yield* notebooks.start({
            ...notebookAddress,
            sweep: [{ threshold: "0.3" }, { threshold: "1.1" }, { threshold: "0.7" }],
          });
          const sweepOutcome = yield* notebooks.wait({ ...notebookAddress, runId });
          if (sweepOutcome._tag !== "published")
            return yield* Effect.die(sweepOutcome.message ?? "No linked results were published.");
          const sweepJob = yield* notebooks.status({ ...notebookAddress, runId });
          expect(sweepJob?.sweepSummary).toMatchObject({
            total: 3,
            saved: 2,
            failures: [{ index: 1, parameters: { threshold: "1.1" } }],
          });

          const alternatives = yield* notebookReader({ cwd, path: notebookAddress.scriptPath });
          const byThreshold = new Map(
            alternatives.runs.map((run) => [
              run.parameters.find((param) => param.name === "threshold")?.value,
              run,
            ]),
          );
          expect(alternatives.publishedRevision).toBe(baseline.summary.revision);
          expect(byThreshold.get("0.3")?.revision).toBeDefined();
          expect(byThreshold.get("0.5")?.revision).toBe(baseline.summary.revision);
          expect(byThreshold.get("0.7")?.revision).toBe(sweepOutcome.summary.revision);
          expect(byThreshold.has("1.1")).toBe(false);
          expect(yield* fs.readFile(notebookFile)).toEqual(savedNotebook);
          expect(byThreshold.get("0.5")?.values).toContainEqual(
            expect.objectContaining({ output: "metrics.json", pointer: "/recall", value: "0.8" }),
          );
          expect(byThreshold.get("0.7")?.values).toContainEqual(
            expect.objectContaining({ output: "metrics.json", pointer: "/recall", value: "0.6" }),
          );

          const handoff = makeResultHandoff({
            layout: { computeDir },
            process: yield* LocalExecutionProcess.ExecutionProcess,
            gateway,
          });
          const selectedRevision = sweepOutcome.summary.revision;
          expect(
            (yield* Effect.promise(() => reader().revisions())).find(
              ({ revision }) => revision === selectedRevision,
            )?.environment?.packages,
          ).toContainEqual(expect.objectContaining({ name: "ipython" }));
          const exported = yield* handoff.exportPackage({
            cwd,
            destination: instance,
            revision: selectedRevision,
            includeInputs: ["data/predictions.csv"],
          });
          const manifest = JSON.parse(
            yield* fs.readFileString(NodePath.join(exported.folder, "manifest.json")),
          );
          expect(manifest).toMatchObject({
            revision: selectedRevision,
            parameters: [{ name: "threshold", value: "0.7", source: "override" }],
          });
          const verified = yield* handoff.verify({
            packageFolder: exported.folder,
            executable: recipientPython!,
            allowExecution: true,
          });
          expect(verified.report).toMatchObject({ status: "verified" });
          expect(verified.report.outputs.map(({ path, status }) => [path, status])).toEqual([
            ["confusion.csv", "matched"],
            ["metrics.json", "matched"],
            ["roc.png", "matched"],
          ]);

          const failure = yield* notebooks.run({
            ...notebookAddress,
            parameters: { threshold: "1.1" },
          });
          expect(failure._tag).toBe("failed");
          const attempt = yield* Effect.promise(() =>
            reader().lastAttempt(notebookAddress.scriptPath),
          );
          expect(attempt).toMatchObject({
            status: "failed",
            cellId: expect.any(String),
            cellExecutionId: expect.any(String),
          });
          expect(attempt?.cellExecutionId).not.toBe(attempt?.executionId);
          const failedOutput = yield* operations.attemptOutput({
            ...notebookAddress,
            finishedAt: attempt!.finishedAt,
          });
          expect(failedOutput).toMatchObject({
            cellId: attempt?.cellId,
            executionId: attempt?.cellExecutionId,
            output: {
              outputs: expect.arrayContaining([expect.objectContaining({ _tag: "diagnostic" })]),
            },
          });
          expect(
            (yield* Effect.promise(() => reader().latestPublished(notebookAddress.scriptPath)))
              ?.revision,
          ).toBe(baseline.summary.revision);

          const defaults = { cwd, scriptPath: "defaults.ipynb" };
          const defaultsPath = NodePath.join(cwd, defaults.scriptPath);
          const sourceCells = [
            "import json, os\nfrom pathlib import Path\nassert json.loads(os.environ['SCIENT_PARAMETERS']) == {}",
            "from __future__ import annotations\nPath(os.environ['SCIENT_RESULTS_DIR'], 'counts.json').write_text(json.dumps({'n': 1}))",
          ];
          const writeNotebook = (path: string, cells: ReadonlyArray<string>, parameters = false) =>
            fs.writeFileString(
              path,
              JSON.stringify({
                nbformat: 4,
                nbformat_minor: 5,
                metadata: {},
                cells: cells.map((source, index) => ({
                  id: `cell-${index}`,
                  cell_type: "code",
                  metadata: parameters && index === 0 ? { tags: ["parameters"] } : {},
                  source,
                  execution_count: null,
                  outputs: [],
                })),
              }),
            );
          yield* writeNotebook(defaultsPath, sourceCells);
          const defaultRun = yield* notebooks.start(defaults);
          const defaultOutcome = yield* notebooks.wait({ ...defaults, runId: defaultRun.runId });
          if (defaultOutcome._tag !== "published")
            return yield* Effect.die(defaultOutcome.message ?? "Expected publication.");
          expect(
            (yield* notebooks.status({ ...defaults, runId: defaultRun.runId }))?.publishedResults,
          ).toEqual({ values: 1, tables: 0, figures: 0, files: 0 });
          yield* writeNotebook(defaultsPath, [sourceCells.join("\n")]);
          const defaultAlternatives = yield* notebookReader({ cwd, path: defaults.scriptPath });
          expect(defaultAlternatives.runs[0]?.source?.cells.map(({ source }) => source)).toEqual(
            sourceCells,
          );
          const defaultExport = yield* handoff.exportPackage({
            cwd,
            destination: instance,
            revision: defaultOutcome.summary.revision,
            includeInputs: [],
          });
          const readme = yield* fs.readFileString(NodePath.join(defaultExport.folder, "README.md"));
          expect(readme).toContain("Set `SCIENT_PARAMETERS` to this JSON.\n\n       {}");
          expect(readme.indexOf("SCIENT_PARAMETERS")).toBeLessThan(
            readme.indexOf("Open the notebook"),
          );
          expect(
            notebookCode(
              yield* fs.readFileString(
                NodePath.join(defaultExport.folder, "source", defaults.scriptPath),
              ),
            ),
          ).toEqual(sourceCells);
          const defaultVerify = yield* handoff.verify({
            packageFolder: defaultExport.folder,
            executable: recipientPython!,
            allowExecution: true,
          });
          expect(defaultVerify.report).toMatchObject({ status: "verified" });
          yield* writeNotebook(defaultsPath, ["print('inline output')"]);
          expect(yield* notebooks.run(defaults)).toEqual({
            _tag: "completed",
            notebookSaved: true,
          });
          expect(
            (yield* Effect.promise(() => reader().latestPublished(defaults.scriptPath)))?.revision,
          ).toBe(defaultOutcome.summary.revision);

          // 3. Threshold script publish 0.5 -> fail 1.1 retains 0.5 -> parameterized agent run 0.7 records actual History -> compare 0.5 vs 0.7
          const rev05Run = yield* operations.rerun({
            cwd,
            scriptPath: "threshold.py",
            parameters: { threshold: "0.5" },
          });
          if (rev05Run._tag !== "published")
            return yield* Effect.die(rev05Run.message ?? "No linked results were published.");
          const rev05 = rev05Run.summary.revision;

          const failedRun = yield* operations.rerun({
            cwd,
            scriptPath: "threshold.py",
            parameters: { threshold: "1.1" },
          });
          expect(failedRun._tag).toBe("failed");
          const historyAfterFail = yield* operations.history({
            cwd,
            scriptPath: "threshold.py",
            includeLatest: true,
          });
          expect(historyAfterFail.latest?.revision).toBe(rev05);
          expect(
            (yield* Effect.promise(() => reader().lastAttempt("threshold.py")))?.parameters,
          ).toEqual([{ name: "threshold", value: "1.1", source: "override" }]);

          // Parameterized agent MCP call wired to real operations + real History
          const workspaceBinding = yield* computeWorkspaceResolverForTest.resolveWorkspaceRoot(cwd);
          const mcpGateway = Layer.mock(ComputeMcpGateway)({
            listResults: (request) => operations.list(request),
            resultHistory: (request) => operations.history(request),
            resultSetup: (request) => operations.setup(request),
            rerunResults: (request) => operations.rerun(request),
            resultOutputContent: (request) => operations.outputContent(request),
            stopNotebookFresh: notebooks.stop,
          });
          const runAsAgent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provide(mcpGateway),
              Effect.provideService(WorkspaceBindingResolver, computeWorkspaceResolverForTest),
              Effect.provideService(AgentInvocationContext, {
                environmentId: workspaceBinding.binding.environmentId,
                threadId: ThreadId.make("acceptance-agent-thread"),
                providerSessionId: "acceptance-agent-session",
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                capabilities: new Set(["compute"] as const),
                issuedAt: 1,
                workspace: workspaceBinding,
              }),
            );

          const cancelAddress = { cwd, scriptPath: "stop.ipynb" };
          yield* writeNotebook(
            NodePath.join(cwd, cancelAddress.scriptPath),
            [
              "step = 0",
              [
                "import json, os, time",
                "from pathlib import Path",
                "if step == 2: time.sleep(90)",
                "Path(os.environ['SCIENT_RESULTS_DIR'], 'counts.json').write_text(json.dumps({'step': step}))",
              ].join("\n"),
            ],
            true,
          );
          const cancelRun = yield* notebooks.start({
            ...cancelAddress,
            sweep: [{ step: "1" }, { step: "2" }, { step: "3" }],
          });
          const updates = yield* notebooks.watch(cancelAddress);
          yield* updates.pipe(
            Stream.filter(
              ({ job }) =>
                job?.runId === cancelRun.runId &&
                job.parameters?.step === "2" &&
                job.progress?.phase === "running",
            ),
            Stream.runHead,
          );
          expect(
            yield* runAsAgent(
              stopScientNotebook({
                path: cancelAddress.scriptPath,
                runId: cancelRun.runId,
              }),
            ),
          ).toMatchObject({
            status: "stopped",
            completedSettings: 1,
            freshRun: { outcome: { _tag: "failed" }, sweepSummary: { saved: 1, failures: [] } },
          });
          expect(
            (yield* notebookReader({ cwd, path: cancelAddress.scriptPath })).runs.map(
              ({ parameters }) => parameters[0]?.value,
            ),
          ).toEqual(["1"]);
          expect(
            yield* Effect.promise(() => reader().lastAttempt(cancelAddress.scriptPath)),
          ).toBeNull();

          const stopFresh = yield* notebooks.start({ ...cancelAddress, parameters: { step: "2" } });
          yield* updates.pipe(
            Stream.filter(
              ({ job }) => job?.runId === stopFresh.runId && job.progress?.phase === "running",
            ),
            Stream.runHead,
          );
          expect(
            yield* runAsAgent(
              stopScientNotebook({
                path: cancelAddress.scriptPath,
                runId: stopFresh.runId,
              }),
            ),
          ).toMatchObject({ status: "stopped", completedSettings: 0 });
          expect(
            yield* Effect.promise(() => reader().lastAttempt(cancelAddress.scriptPath)),
          ).toMatchObject({ status: "cancelled" });

          const agentRun = yield* runAsAgent(
            runScientResults({
              path: "threshold.py",
              parameters: { threshold: 0.7 },
            }),
          );
          expect(agentRun).toMatchObject({ status: "published" });
          const rev07 =
            agentRun.status === "published"
              ? agentRun.revision.revision
              : yield* Effect.die("expected published");

          const agentHistory = yield* runAsAgent(listScientResults({ path: "threshold.py" }));
          expect(agentHistory).toMatchObject({
            latestRecord: {
              revision: rev07,
              parameters: [{ name: "threshold", value: "0.7", source: "override" }],
            },
          });
          const historyAll = yield* operations.history({
            cwd,
            scriptPath: "threshold.py",
            includeLatest: true,
          });
          expect(historyAll.revisions.map((item) => item.revision)).toEqual(
            expect.arrayContaining([rev07, rev05]),
          );

          // 4. Compare 0.5 vs 0.7 -> recall 0.8 -> 0.6, precision 2/3 -> 0.75, n = 10
          const comparison = yield* operations.compare({
            cwd,
            from: rev05,
            to: rev07,
          });
          const valueByPointer = new Map(
            comparison.values.map((entry) => [`${entry.output}:${entry.pointer}`, entry]),
          );
          expect(valueByPointer.get("metrics.json:/recall")).toMatchObject({
            from: "0.8",
            to: "0.6",
          });
          expect(Number(valueByPointer.get("metrics.json:/precision")?.from)).toBeCloseTo(
            2 / 3,
            10,
          );
          expect(Number(valueByPointer.get("metrics.json:/precision")?.to)).toBeCloseTo(0.75, 10);
          expect(valueByPointer.get("metrics.json:/n")).toMatchObject({
            from: "10",
            to: "10",
          });
        }).pipe(Effect.provide(layers));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
