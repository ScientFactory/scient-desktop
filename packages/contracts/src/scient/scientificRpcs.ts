import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  AnalysisCancelRunInput,
  AnalysisCleanupProjectInput,
  AnalysisCleanupResult,
  AnalysisCleanupRunInput,
  AnalysisConfigureRuntimeInput,
  AnalysisGetRunInput,
  AnalysisInspectRuntimesInput,
  AnalysisListRunsInput,
  AnalysisListRunsResult,
  AnalysisOperationError,
  AnalysisPromoteRunInput,
  AnalysisPromoteRunResult,
  AnalysisRunSnapshot,
  AnalysisRunStreamEvent,
  AnalysisRuntimeInspection,
  AnalysisRuntimeProfile,
  AnalysisStartRunInput,
  AnalysisStorageSummary,
  AnalysisStorageSummaryInput,
  AnalysisSubscribeRunsInput,
  AnalysisVerifyRuntimeInput,
} from "../scientAnalysis.ts";
import {
  ComputeExecutionRecord,
  ComputeExecutionOutputs,
  ComputeGatewayError,
  ComputeGetProjectSessionResult,
  ComputeInspectRuntimesInput,
  ComputeListProjectExecutionsInput,
  ComputeListProjectExecutionsResult,
  ComputeListProjectOutputsInput,
  ComputeListProjectSessionsResult,
  ComputeManagedRuntimeInput,
  ComputeManagedRuntimeStatus,
  ComputeManagedRuntimeStatusInput,
  ComputeOperationError,
  ComputeProjectExecutionCommandInput,
  ComputeProjectInput,
  ComputeProjectSessionCommandInput,
  ComputeStopProjectSessionInput,
  ComputeProjectSessionInput,
  ComputeRuntimeInspection,
  ComputeRuntimeInventory,
  ComputeRuntimeVerification,
  ComputeSaveProjectOutputInput,
  ComputeSaveProjectOutputResult,
  ComputeSessionRecord,
  ComputeSessionStreamEvent,
  ComputeVariableSnapshot,
  ComputeStartProjectSessionInput,
  ComputeSubmitProjectCellsInput,
  ComputeSubmitProjectExecutionInput,
  ComputeVerifyRuntimeInput,
} from "../scientCompute.ts";
import {
  ComputeTableInput,
  DataFileTable,
  DataFileTableError,
  DataFileTableInput,
  DataTablePage,
} from "../scientData.ts";
import {
  NotebookEditInput,
  NotebookEditResult,
  NotebookError,
  NotebookOutputJson,
  NotebookReadInput,
  NotebookReadOutputInput,
  NotebookRecordRunInput,
  NotebookRecordRunResult,
  NotebookView,
} from "../scientNotebook.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_SCIENTIFIC_WS_METHODS = {
  // Scient-owned scientific analysis runtime methods
  analysisInspectRuntimes: "analysis.inspectRuntimes",
  analysisConfigureRuntime: "analysis.configureRuntime",
  analysisVerifyRuntime: "analysis.verifyRuntime",
  analysisStartRun: "analysis.startRun",
  analysisCancelRun: "analysis.cancelRun",
  analysisListRuns: "analysis.listRuns",
  analysisGetRun: "analysis.getRun",
  analysisStorageSummary: "analysis.storageSummary",
  analysisCleanupRun: "analysis.cleanupRun",
  analysisCleanupProject: "analysis.cleanupProject",
  analysisPromoteRun: "analysis.promoteRun",

  // Scient-owned stateful scientific compute methods
  computeInspectRuntimes: "compute.inspectRuntimes",
  computeRuntimeInventory: "compute.runtimeInventory",
  computeVerifyRuntime: "compute.verifyRuntime",
  computeManagedRuntimeStatus: "compute.managedRuntimeStatus",
  computeManageRuntime: "compute.manageRuntime",
  computeCancelManagedRuntime: "compute.cancelManagedRuntime",
  computeStartSession: "compute.startSession",
  computeListSessions: "compute.listSessions",
  computeGetSession: "compute.getSession",
  computeRestartSession: "compute.restartSession",
  computeStopSession: "compute.stopSession",
  computeSubmitExecution: "compute.submitExecution",
  computeSubmitCells: "compute.submitCells",
  computeCancelExecution: "compute.cancelExecution",
  computeInterruptSession: "compute.interruptSession",
  computeListExecutions: "compute.listExecutions",
  computeListOutputs: "compute.listOutputs",
  computeInspectVariables: "compute.inspectVariables",
  computeReadTable: "compute.readTable",
  computeSaveOutput: "compute.saveOutput",
  notebookRead: "notebook.read",
  notebookReadOutput: "notebook.readOutput",
  notebookEdit: "notebook.edit",
  notebookRecordRun: "notebook.recordRun",
  subscribeComputeSessions: "subscribe.computeSessions",

  // Scient-owned data file viewer
  dataReadFileTable: "data.readFileTable",
} as const;

/** Spread into the streaming subscriptions at the end of rpc.ts WS_METHODS. */
export const SCIENT_ANALYSIS_STREAM_WS_METHODS = {
  subscribeAnalysisRuns: "subscribeAnalysisRuns",
} as const;

const AnalysisRpcError = Schema.Union([AnalysisOperationError, EnvironmentAuthorizationError]);

export const WsAnalysisInspectRuntimesRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.analysisInspectRuntimes,
  {
    payload: AnalysisInspectRuntimesInput,
    success: AnalysisRuntimeInspection,
    error: AnalysisRpcError,
  },
);

const WsAnalysisConfigureRuntimeRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.analysisConfigureRuntime,
  {
    payload: AnalysisConfigureRuntimeInput,
    success: AnalysisRuntimeInspection,
    error: AnalysisRpcError,
  },
);

const WsAnalysisVerifyRuntimeRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisVerifyRuntime, {
  payload: AnalysisVerifyRuntimeInput,
  success: AnalysisRuntimeProfile,
  error: AnalysisRpcError,
});

const WsAnalysisStartRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisStartRun, {
  payload: AnalysisStartRunInput,
  success: AnalysisRunSnapshot,
  error: AnalysisRpcError,
});

const WsAnalysisCancelRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisCancelRun, {
  payload: AnalysisCancelRunInput,
  success: AnalysisRunSnapshot,
  error: AnalysisRpcError,
});

const WsAnalysisListRunsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisListRuns, {
  payload: AnalysisListRunsInput,
  success: AnalysisListRunsResult,
  error: AnalysisRpcError,
});

const WsAnalysisGetRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisGetRun, {
  payload: AnalysisGetRunInput,
  success: AnalysisRunSnapshot,
  error: AnalysisRpcError,
});

const WsAnalysisStorageSummaryRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisStorageSummary, {
  payload: AnalysisStorageSummaryInput,
  success: AnalysisStorageSummary,
  error: AnalysisRpcError,
});

const WsAnalysisCleanupRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisCleanupRun, {
  payload: AnalysisCleanupRunInput,
  success: AnalysisCleanupResult,
  error: AnalysisRpcError,
});

const WsAnalysisCleanupProjectRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisCleanupProject, {
  payload: AnalysisCleanupProjectInput,
  success: AnalysisCleanupResult,
  error: AnalysisRpcError,
});

const WsAnalysisPromoteRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.analysisPromoteRun, {
  payload: AnalysisPromoteRunInput,
  success: AnalysisPromoteRunResult,
  error: AnalysisRpcError,
});

const WsSubscribeAnalysisRunsRpc = Rpc.make(
  SCIENT_ANALYSIS_STREAM_WS_METHODS.subscribeAnalysisRuns,
  {
    payload: AnalysisSubscribeRunsInput,
    success: AnalysisRunStreamEvent,
    error: AnalysisRpcError,
    stream: true,
  },
);

const ComputeRpcError = Schema.Union([
  ComputeGatewayError,
  ComputeOperationError,
  EnvironmentAuthorizationError,
]);

const WsComputeInspectRuntimesRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeInspectRuntimes, {
  payload: ComputeInspectRuntimesInput,
  success: ComputeRuntimeInspection,
  error: ComputeRpcError,
});

const WsComputeRuntimeInventoryRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeRuntimeInventory,
  {
    payload: Schema.Struct({ versions: Schema.optionalKey(Schema.Boolean) }),
    success: ComputeRuntimeInventory,
    error: ComputeRpcError,
  },
);

const WsComputeVerifyRuntimeRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeVerifyRuntime, {
  payload: ComputeVerifyRuntimeInput,
  success: ComputeRuntimeVerification,
  error: ComputeRpcError,
});

const WsComputeManagedRuntimeStatusRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeManagedRuntimeStatus,
  {
    payload: ComputeManagedRuntimeStatusInput,
    success: ComputeManagedRuntimeStatus,
    error: ComputeRpcError,
  },
);

const WsComputeManageRuntimeRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeManageRuntime, {
  payload: ComputeManagedRuntimeInput,
  success: ComputeManagedRuntimeStatus,
  error: ComputeRpcError,
});

const WsComputeCancelManagedRuntimeRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeCancelManagedRuntime,
  {
    payload: ComputeManagedRuntimeStatusInput,
    success: ComputeManagedRuntimeStatus,
    error: ComputeRpcError,
  },
);

const WsComputeStartSessionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeStartSession, {
  payload: ComputeStartProjectSessionInput,
  success: ComputeSessionRecord,
  error: ComputeRpcError,
});

const WsComputeListSessionsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeListSessions, {
  payload: ComputeProjectInput,
  success: ComputeListProjectSessionsResult,
  error: ComputeRpcError,
});

const WsComputeGetSessionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeGetSession, {
  payload: ComputeProjectSessionInput,
  success: ComputeGetProjectSessionResult,
  error: ComputeRpcError,
});

const WsComputeRestartSessionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeRestartSession, {
  payload: ComputeProjectSessionCommandInput,
  success: ComputeSessionRecord,
  error: ComputeRpcError,
});

const WsComputeStopSessionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeStopSession, {
  payload: ComputeStopProjectSessionInput,
  success: ComputeSessionRecord,
  error: ComputeRpcError,
});

const WsComputeSubmitExecutionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeSubmitExecution, {
  payload: ComputeSubmitProjectExecutionInput,
  success: ComputeExecutionRecord,
  error: ComputeRpcError,
});

const WsComputeCancelExecutionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeCancelExecution, {
  payload: ComputeProjectExecutionCommandInput,
  success: ComputeExecutionRecord,
  error: ComputeRpcError,
});

const WsComputeInterruptSessionRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeInterruptSession,
  {
    payload: ComputeProjectSessionCommandInput,
    success: ComputeSessionRecord,
    error: ComputeRpcError,
  },
);

const WsComputeListExecutionsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeListExecutions, {
  payload: ComputeListProjectExecutionsInput,
  success: ComputeListProjectExecutionsResult,
  error: ComputeRpcError,
});

const WsComputeListOutputsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeListOutputs, {
  payload: ComputeListProjectOutputsInput,
  success: ComputeExecutionOutputs,
  error: ComputeRpcError,
});

const WsComputeInspectVariablesRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeInspectVariables,
  {
    payload: ComputeProjectSessionCommandInput,
    success: ComputeVariableSnapshot,
    error: ComputeRpcError,
  },
);

const WsComputeReadTableRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeReadTable, {
  payload: ComputeTableInput,
  success: DataTablePage,
  error: ComputeRpcError,
});

const WsDataReadFileTableRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataReadFileTable, {
  payload: DataFileTableInput,
  success: DataFileTable,
  error: Schema.Union([DataFileTableError, EnvironmentAuthorizationError]),
});

const WsComputeSaveOutputRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeSaveOutput, {
  payload: ComputeSaveProjectOutputInput,
  success: ComputeSaveProjectOutputResult,
  error: ComputeRpcError,
});

const WsComputeSubmitCellsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeSubmitCells, {
  payload: ComputeSubmitProjectCellsInput,
  success: Schema.Array(ComputeExecutionRecord),
  error: ComputeRpcError,
});

const NotebookRpcError = Schema.Union([NotebookError, EnvironmentAuthorizationError]);

const WsNotebookReadRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookRead, {
  payload: NotebookReadInput,
  success: Schema.NullOr(NotebookView),
  error: NotebookRpcError,
});

const WsNotebookReadOutputRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookReadOutput, {
  payload: NotebookReadOutputInput,
  success: NotebookOutputJson,
  error: NotebookRpcError,
});

const WsNotebookEditRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookEdit, {
  payload: NotebookEditInput,
  success: NotebookEditResult,
  error: NotebookRpcError,
});

const WsNotebookRecordRunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookRecordRun, {
  payload: NotebookRecordRunInput,
  success: NotebookRecordRunResult,
  error: NotebookRpcError,
});

const WsSubscribeComputeSessionsRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.subscribeComputeSessions,
  {
    payload: ComputeProjectInput,
    success: ComputeSessionStreamEvent,
    error: ComputeRpcError,
    stream: true,
  },
);

export const WsScientificRpcGroup = RpcGroup.make(
  WsAnalysisConfigureRuntimeRpc,
  WsAnalysisVerifyRuntimeRpc,
  WsAnalysisStartRunRpc,
  WsAnalysisCancelRunRpc,
  WsAnalysisListRunsRpc,
  WsAnalysisGetRunRpc,
  WsAnalysisStorageSummaryRpc,
  WsAnalysisCleanupRunRpc,
  WsAnalysisCleanupProjectRpc,
  WsAnalysisPromoteRunRpc,
  WsSubscribeAnalysisRunsRpc,
  WsComputeInspectRuntimesRpc,
  WsComputeRuntimeInventoryRpc,
  WsComputeVerifyRuntimeRpc,
  WsComputeManagedRuntimeStatusRpc,
  WsComputeManageRuntimeRpc,
  WsComputeCancelManagedRuntimeRpc,
  WsComputeStartSessionRpc,
  WsComputeListSessionsRpc,
  WsComputeGetSessionRpc,
  WsComputeRestartSessionRpc,
  WsComputeStopSessionRpc,
  WsComputeSubmitExecutionRpc,
  WsComputeCancelExecutionRpc,
  WsComputeInterruptSessionRpc,
  WsComputeListExecutionsRpc,
  WsComputeListOutputsRpc,
  WsComputeInspectVariablesRpc,
  WsComputeReadTableRpc,
  WsDataReadFileTableRpc,
  WsComputeSaveOutputRpc,
  WsComputeSubmitCellsRpc,
  WsNotebookReadRpc,
  WsNotebookReadOutputRpc,
  WsNotebookEditRpc,
  WsNotebookRecordRunRpc,
  WsSubscribeComputeSessionsRpc,
);
