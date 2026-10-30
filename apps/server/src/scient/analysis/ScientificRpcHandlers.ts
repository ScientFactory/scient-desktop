/**
 * Handlers for Scient's analysis and compute RPC group, and the analysis
 * runtime inspection that the shared repository group carries. ws.ts builds
 * them per connection with its authorized RPC wrappers.
 *
 * @module ScientificRpcHandlers
 */
import { WS_METHODS, WsRepositoryRpcGroup, WsScientificRpcGroup } from "@t3tools/contracts";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import type { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import type { makeComputeOutputSave } from "../compute/ComputeOutputSave.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import type * as DataTables from "../data/DataTables.ts";
import type * as AnalysisService from "./AnalysisService.ts";

export const makeScientificRpcHandlers = ({
  observeRpcEffect,
  observeRpcStreamEffect,
  analysis,
  computeGateway,
  saveComputeOutput,
  computeNotebookOutputs,
  dataTables,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStreamEffect"> & {
  readonly analysis: AnalysisService.AnalysisService["Service"];
  readonly computeGateway: ComputeRpcGateway;
  readonly saveComputeOutput: ReturnType<typeof makeComputeOutputSave>;
  readonly computeNotebookOutputs: ReturnType<typeof makeComputeNotebookOutputs>;
  readonly dataTables: DataTables.DataTables["Service"];
}) =>
  WsScientificRpcGroup.of({
    [WS_METHODS.analysisConfigureRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.analysisConfigureRuntime, analysis.configureRuntime(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisVerifyRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.analysisVerifyRuntime, analysis.verifyRuntime(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisStartRun]: (input) =>
      observeRpcEffect(WS_METHODS.analysisStartRun, analysis.startRun(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisCancelRun]: (input) =>
      observeRpcEffect(WS_METHODS.analysisCancelRun, analysis.cancelRun(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisListRuns]: (input) =>
      observeRpcEffect(WS_METHODS.analysisListRuns, analysis.listRuns(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisGetRun]: (input) =>
      observeRpcEffect(WS_METHODS.analysisGetRun, analysis.getRun(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisStorageSummary]: (input) =>
      observeRpcEffect(WS_METHODS.analysisStorageSummary, analysis.storageSummary(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisCleanupRun]: (input) =>
      observeRpcEffect(WS_METHODS.analysisCleanupRun, analysis.cleanupRun(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisCleanupProject]: (input) =>
      observeRpcEffect(WS_METHODS.analysisCleanupProject, analysis.cleanupProject(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.analysisPromoteRun]: (input) =>
      observeRpcEffect(WS_METHODS.analysisPromoteRun, analysis.promoteRun(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.subscribeAnalysisRuns]: (input) =>
      observeRpcStreamEffect(WS_METHODS.subscribeAnalysisRuns, analysis.subscribeRuns(input), {
        "rpc.aggregate": "analysis",
      }),
    [WS_METHODS.computeInspectRuntimes]: (input) =>
      observeRpcEffect(WS_METHODS.computeInspectRuntimes, computeGateway.inspectRuntimes(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeRuntimeInventory]: () =>
      observeRpcEffect(WS_METHODS.computeRuntimeInventory, computeGateway.runtimeInventory(), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeVerifyRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.computeVerifyRuntime, computeGateway.verifyRuntime(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeManagedRuntimeStatus]: (input) =>
      observeRpcEffect(
        WS_METHODS.computeManagedRuntimeStatus,
        computeGateway.managedRuntimeStatus(input),
        { "rpc.aggregate": "compute" },
      ),
    [WS_METHODS.computeManageRuntime]: (input) =>
      observeRpcEffect(WS_METHODS.computeManageRuntime, computeGateway.manageRuntime(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeCancelManagedRuntime]: (input) =>
      observeRpcEffect(
        WS_METHODS.computeCancelManagedRuntime,
        computeGateway.cancelManagedRuntime(input),
        { "rpc.aggregate": "compute" },
      ),
    [WS_METHODS.computeStartSession]: (input) =>
      observeRpcEffect(WS_METHODS.computeStartSession, computeGateway.startSession(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeListSessions]: (input) =>
      observeRpcEffect(WS_METHODS.computeListSessions, computeGateway.listSessions(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeGetSession]: (input) =>
      observeRpcEffect(WS_METHODS.computeGetSession, computeGateway.getSession(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeRestartSession]: (input) =>
      observeRpcEffect(WS_METHODS.computeRestartSession, computeGateway.restartSession(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeStopSession]: (input) =>
      observeRpcEffect(WS_METHODS.computeStopSession, computeGateway.stopSession(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeSubmitExecution]: (input) =>
      observeRpcEffect(WS_METHODS.computeSubmitExecution, computeGateway.submitExecution(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeCancelExecution]: (input) =>
      observeRpcEffect(WS_METHODS.computeCancelExecution, computeGateway.cancelExecution(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeInterruptSession]: (input) =>
      observeRpcEffect(WS_METHODS.computeInterruptSession, computeGateway.interruptSession(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeListExecutions]: (input) =>
      observeRpcEffect(WS_METHODS.computeListExecutions, computeGateway.listExecutions(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeListOutputs]: (input) =>
      observeRpcEffect(WS_METHODS.computeListOutputs, computeGateway.listOutputs(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeInspectVariables]: (input) =>
      observeRpcEffect(WS_METHODS.computeInspectVariables, computeGateway.inspectVariables(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeReadTable]: (input) =>
      observeRpcEffect(WS_METHODS.computeReadTable, computeGateway.readTable(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.dataReadFileTable]: (input) =>
      observeRpcEffect(WS_METHODS.dataReadFileTable, dataTables.readFileTable(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.computeSaveOutput]: (input) =>
      observeRpcEffect(WS_METHODS.computeSaveOutput, saveComputeOutput(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeNotebookOutputs]: (input) =>
      observeRpcEffect(WS_METHODS.computeNotebookOutputs, computeNotebookOutputs(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.subscribeComputeSessions]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeComputeSessions,
        computeGateway.subscribeSessions(input),
        { "rpc.aggregate": "compute" },
      ),
  });

export const makeAnalysisRuntimeInspectionHandlers = ({
  observeRpcEffect,
  analysis,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly analysis: AnalysisService.AnalysisService["Service"];
}) =>
  ({
    [WS_METHODS.analysisInspectRuntimes]: (input) =>
      observeRpcEffect(WS_METHODS.analysisInspectRuntimes, analysis.inspectRuntimes(input), {
        "rpc.aggregate": "analysis",
      }),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsRepositoryRpcGroup,
    typeof WS_METHODS.analysisInspectRuntimes
  >;
