import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  AnalysisCancelRunInput,
  AnalysisCleanupProjectInput,
  AnalysisCleanupResult,
  AnalysisCleanupRunInput,
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
  AnalysisStartRunInput,
  AnalysisStorageSummary,
  AnalysisStorageSummaryInput,
  AnalysisSubscribeRunsInput,
} from "../scientAnalysis.ts";
import {
  ComputeExecutionRecord,
  ComputeExecutionOutputs,
  ComputeGatewayError,
  ComputeGetProjectSessionResult,
  ComputeInspectRuntimesInput,
  ComputeListProjectExecutionsInput,
  ComputeRunHistoryInput,
  ComputeRunHistoryResult,
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
  ComputeRuntimeInventoryInput,
  ComputeRuntimeVerification,
  ComputeSaveConsoleNotebookInput,
  ComputeSaveConsoleNotebookResult,
  ComputeSaveProjectOutputInput,
  ComputeSaveProjectOutputResult,
  ComputeSessionRecord,
  ComputeSessionStreamEvent,
  ComputeVariableSnapshot,
  ComputeStartProjectSessionInput,
  ComputeActiveWork,
  ComputeSubmitProjectCellsInput,
  ComputeSubmitProjectExecutionInput,
  ComputeVerifyRuntimeInput,
  ComputeAddPythonLibraryInput,
} from "../scientCompute.ts";
import {
  ComputeResultsError,
  ComputeResultsFilesChangeResult,
  ComputeResultsPlaceLatexInput,
  ComputeResultsPlaceLatexResult,
  ComputeResultsPlacementsInput,
  ComputeResultsPlacementsResult,
  ComputeResultsUndoUpdateInput,
  ComputeResultsUpdateFilesInput,
  ComputeResultsListInput,
  ComputeResultsSetupInput,
  ComputeResultsSetupResult,
  ComputeResultsPreviewInput,
  ComputeResultsPreviewResult,
  ComputeResultsCompareInput,
  ComputeResultsCompareResult,
  ComputeResultsHistoryInput,
  ComputeResultsHistoryResult,
  ComputeResultsPublicationInput,
  ComputeResultsPublicationResult,
  ComputeResultsAttemptOutputInput,
  ComputeResultsAttemptOutputResult,
  ComputeResultsListResult,
  ComputeResultsPlaceFigureInput,
  ComputeResultsPlaceFigureResult,
  ComputeResultsRerunInput,
  ComputeResultsRerunResult,
  ComputeResultsResolveInput,
  ComputeResultsResolveResult,
} from "../scientComputeResults.ts";
import {
  ResultHandoffChoices,
  ResultHandoffExportInput,
  ResultHandoffExportResult,
  ResultHandoffExportProgress,
  ResultHandoffExportProgressInput,
  ResultHandoffRevisionInput,
  ResultHandoffVerifyRequest,
  ResultHandoffCancelInput,
  ResultHandoffCancelResult,
  ResultHandoffVerifyResult,
} from "../scientResultHandoff.ts";
import {
  ComputeTableInput,
  DataFileTable,
  DataFileTableError,
  DataFileTableInput,
  DataFileProfileInput,
  DataProfile,
  DataProfileEvent,
  ComputeTableProfileInput,
  DataTablePage,
  DataViewAddress,
  DataViewError,
  DataViewPage,
  DataViewRevision,
  DataViewInput,
  DataViewPageInput,
  DataViewSaveInput,
  DataViewMaterializeInput,
} from "../scientData.ts";
import {
  NotebookEditInput,
  NotebookEditResult,
  NotebookError,
  NotebookFreshRun,
  NotebookFreshRunInput,
  NotebookFreshRunStatusInput,
  NotebookFreshRunStopInput,
  NotebookFreshRunSubscribeInput,
  NotebookFreshRunUpdate,
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
  computeAddPythonLibrary: "compute.addPythonLibrary",
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
  computeRunHistory: "compute.runHistory",
  computeListOutputs: "compute.listOutputs",
  computeInspectVariables: "compute.inspectVariables",
  computeReadTable: "compute.readTable",
  computeSaveOutput: "compute.saveOutput",
  computeSaveConsoleNotebook: "compute.saveConsoleNotebook",
  computeResultsResolve: "compute.results.resolve",
  computeResultsList: "compute.results.list",
  computeResultsSetup: "compute.results.setup",
  computeResultsPreview: "compute.results.preview",
  computeResultsCompare: "compute.results.compare",
  computeResultsHistory: "compute.results.history",
  computeResultsPublication: "compute.results.publication",
  computeResultsAttemptOutput: "compute.results.attemptOutput",
  computeResultsHandoffChoices: "compute.results.handoffChoices",
  computeResultsExport: "compute.results.export",
  computeResultsExportProgress: "compute.results.exportProgress",
  computeResultsVerify: "compute.results.verify",
  computeResultsCancelVerification: "compute.results.cancelVerification",
  computeResultsPlaceFigure: "compute.results.placeFigure",
  computeResultsRerun: "compute.results.rerun",
  computeResultsPlaceLatex: "compute.results.placeLatex",
  computeResultsPlacements: "compute.results.placements",
  computeResultsUpdateFiles: "compute.results.updateFiles",
  computeResultsUndoUpdate: "compute.results.undoUpdate",
  notebookRead: "notebook.read",
  notebookReadOutput: "notebook.readOutput",
  notebookEdit: "notebook.edit",
  notebookRecordRun: "notebook.recordRun",
  notebookFreshStart: "notebook.freshStart",
  notebookFreshStatus: "notebook.freshStatus",
  notebookFreshStop: "notebook.freshStop",
  subscribeNotebookFreshRun: "subscribe.notebookFreshRun",
  subscribeComputeSessions: "subscribe.computeSessions",
  subscribeComputeActiveWork: "subscribe.computeActiveWork",

  // Scient-owned data file viewer
  dataReadFileTable: "data.readFileTable",
  dataProfileFile: "data.profileFile",
  dataViewRevision: "data.viewRevision",
  dataReadView: "data.readView",
  dataProfileView: "data.profileView",
  dataSaveView: "data.saveView",
  dataMaterializeView: "data.materializeView",
  dataProfileVariable: "data.profileVariable",
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
    payload: ComputeRuntimeInventoryInput,
    success: ComputeRuntimeInventory,
    error: ComputeRpcError,
  },
);

/** The runs quitting would stop: the current count, then each change. */
const WsSubscribeComputeActiveWorkRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.subscribeComputeActiveWork,
  {
    payload: Schema.Struct({}),
    success: ComputeActiveWork,
    error: ComputeRpcError,
    stream: true,
  },
);

const WsComputeVerifyRuntimeRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeVerifyRuntime, {
  payload: ComputeVerifyRuntimeInput,
  success: ComputeRuntimeVerification,
  error: ComputeRpcError,
});

const WsComputeAddPythonLibraryRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeAddPythonLibrary,
  {
    payload: ComputeAddPythonLibraryInput,
    error: ComputeRpcError,
  },
);

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

const WsComputeRunHistoryRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeRunHistory, {
  payload: ComputeRunHistoryInput,
  success: ComputeRunHistoryResult,
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

const WsDataProfileFileRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataProfileFile, {
  payload: DataFileProfileInput,
  success: DataProfileEvent,
  error: Schema.Union([DataFileTableError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsDataProfileVariableRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataProfileVariable, {
  payload: ComputeTableProfileInput,
  success: DataProfile,
  error: ComputeRpcError,
});

const dataViewRpcError = Schema.Union([DataViewError, EnvironmentAuthorizationError]);
const writtenDataPath = Schema.Struct({ path: DataViewInput.fields.path });

const WsDataViewRevisionRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataViewRevision, {
  payload: DataViewAddress,
  success: DataViewRevision,
  error: dataViewRpcError,
});

const WsDataReadViewRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataReadView, {
  payload: DataViewPageInput,
  success: DataViewPage,
  error: dataViewRpcError,
});

const WsDataProfileViewRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataProfileView, {
  payload: DataViewInput,
  success: DataProfile,
  error: dataViewRpcError,
});

const WsDataSaveViewRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataSaveView, {
  payload: DataViewSaveInput,
  success: writtenDataPath,
  error: dataViewRpcError,
});

const WsDataMaterializeViewRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.dataMaterializeView, {
  payload: DataViewMaterializeInput,
  success: writtenDataPath,
  error: dataViewRpcError,
});

const WsComputeSaveOutputRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeSaveOutput, {
  payload: ComputeSaveProjectOutputInput,
  success: ComputeSaveProjectOutputResult,
  error: ComputeRpcError,
});

const ComputeResultsRpcError = Schema.Union([
  ComputeResultsError,
  ComputeGatewayError,
  ComputeOperationError,
  EnvironmentAuthorizationError,
]);

const WsComputeResultsResolveRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsResolve, {
  payload: ComputeResultsResolveInput,
  success: ComputeResultsResolveResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsHistoryRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsHistory, {
  payload: ComputeResultsHistoryInput,
  success: ComputeResultsHistoryResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsCompareRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsCompare, {
  payload: ComputeResultsCompareInput,
  success: ComputeResultsCompareResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsPreviewRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsPreview, {
  payload: ComputeResultsPreviewInput,
  success: ComputeResultsPreviewResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsSetupRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsSetup, {
  payload: ComputeResultsSetupInput,
  success: ComputeResultsSetupResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsListRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsList, {
  payload: ComputeResultsListInput,
  success: ComputeResultsListResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsPublicationRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsPublication,
  {
    payload: ComputeResultsPublicationInput,
    success: ComputeResultsPublicationResult,
    error: ComputeResultsRpcError,
  },
);

const WsResultHandoffChoicesRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsHandoffChoices,
  {
    payload: ResultHandoffRevisionInput,
    success: ResultHandoffChoices,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsAttemptOutputRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsAttemptOutput,
  {
    payload: ComputeResultsAttemptOutputInput,
    success: ComputeResultsAttemptOutputResult,
    error: ComputeResultsRpcError,
  },
);

const WsResultHandoffExportRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsExport, {
  payload: ResultHandoffExportInput,
  success: ResultHandoffExportResult,
  error: ComputeResultsRpcError,
});

const WsResultHandoffExportProgressRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsExportProgress,
  {
    payload: ResultHandoffExportProgressInput,
    success: ResultHandoffExportProgress,
    error: ComputeResultsRpcError,
  },
);

const WsResultHandoffVerifyRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsVerify, {
  payload: ResultHandoffVerifyRequest,
  success: ResultHandoffVerifyResult,
  error: ComputeResultsRpcError,
});

const WsResultHandoffCancelRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsCancelVerification,
  {
    payload: ResultHandoffCancelInput,
    success: ResultHandoffCancelResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsPlaceFigureRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsPlaceFigure,
  {
    payload: ComputeResultsPlaceFigureInput,
    success: ComputeResultsPlaceFigureResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsRerunRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeResultsRerun, {
  payload: ComputeResultsRerunInput,
  success: ComputeResultsRerunResult,
  error: ComputeResultsRpcError,
});

const WsComputeResultsPlaceLatexRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsPlaceLatex,
  {
    payload: ComputeResultsPlaceLatexInput,
    success: ComputeResultsPlaceLatexResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsPlacementsRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsPlacements,
  {
    payload: ComputeResultsPlacementsInput,
    success: ComputeResultsPlacementsResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsUpdateFilesRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsUpdateFiles,
  {
    payload: ComputeResultsUpdateFilesInput,
    success: ComputeResultsFilesChangeResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeResultsUndoUpdateRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeResultsUndoUpdate,
  {
    payload: ComputeResultsUndoUpdateInput,
    success: ComputeResultsFilesChangeResult,
    error: ComputeResultsRpcError,
  },
);

const WsComputeSaveConsoleNotebookRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.computeSaveConsoleNotebook,
  {
    payload: ComputeSaveConsoleNotebookInput,
    success: ComputeSaveConsoleNotebookResult,
    error: ComputeRpcError,
  },
);

const WsComputeSubmitCellsRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.computeSubmitCells, {
  payload: ComputeSubmitProjectCellsInput,
  success: Schema.Array(ComputeExecutionRecord),
  error: ComputeRpcError,
});

const NotebookRpcError = Schema.Union([NotebookError, EnvironmentAuthorizationError]);

const WsNotebookFreshStartRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookFreshStart, {
  payload: NotebookFreshRunInput,
  success: NotebookFreshRun,
  error: Schema.Union([ComputeResultsError, EnvironmentAuthorizationError]),
});

const WsNotebookFreshStatusRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookFreshStatus, {
  payload: NotebookFreshRunStatusInput,
  success: Schema.NullOr(NotebookFreshRun),
  error: Schema.Union([ComputeResultsError, EnvironmentAuthorizationError]),
});

const WsNotebookFreshStopRpc = Rpc.make(SCIENT_SCIENTIFIC_WS_METHODS.notebookFreshStop, {
  payload: NotebookFreshRunStopInput,
  success: Schema.NullOr(NotebookFreshRun),
  error: Schema.Union([ComputeResultsError, EnvironmentAuthorizationError]),
});

const WsSubscribeNotebookFreshRunRpc = Rpc.make(
  SCIENT_SCIENTIFIC_WS_METHODS.subscribeNotebookFreshRun,
  {
    payload: NotebookFreshRunSubscribeInput,
    success: NotebookFreshRunUpdate,
    error: Schema.Union([ComputeResultsError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

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
  WsSubscribeComputeActiveWorkRpc,
  WsComputeVerifyRuntimeRpc,
  WsComputeManagedRuntimeStatusRpc,
  WsComputeManageRuntimeRpc,
  WsComputeCancelManagedRuntimeRpc,
  WsComputeAddPythonLibraryRpc,
  WsComputeStartSessionRpc,
  WsComputeListSessionsRpc,
  WsComputeGetSessionRpc,
  WsComputeRestartSessionRpc,
  WsComputeStopSessionRpc,
  WsComputeSubmitExecutionRpc,
  WsComputeCancelExecutionRpc,
  WsComputeInterruptSessionRpc,
  WsComputeListExecutionsRpc,
  WsComputeRunHistoryRpc,
  WsComputeListOutputsRpc,
  WsComputeInspectVariablesRpc,
  WsComputeReadTableRpc,
  WsDataReadFileTableRpc,
  WsDataProfileFileRpc,
  WsDataViewRevisionRpc,
  WsDataReadViewRpc,
  WsDataProfileViewRpc,
  WsDataSaveViewRpc,
  WsDataMaterializeViewRpc,
  WsDataProfileVariableRpc,
  WsComputeSaveOutputRpc,
  WsComputeSaveConsoleNotebookRpc,
  WsComputeResultsResolveRpc,
  WsComputeResultsListRpc,
  WsComputeResultsSetupRpc,
  WsComputeResultsPreviewRpc,
  WsComputeResultsCompareRpc,
  WsComputeResultsHistoryRpc,
  WsComputeResultsPublicationRpc,
  WsComputeResultsAttemptOutputRpc,
  WsResultHandoffChoicesRpc,
  WsResultHandoffExportRpc,
  WsResultHandoffExportProgressRpc,
  WsResultHandoffVerifyRpc,
  WsResultHandoffCancelRpc,
  WsComputeResultsPlaceFigureRpc,
  WsComputeResultsRerunRpc,
  WsComputeResultsPlaceLatexRpc,
  WsComputeResultsPlacementsRpc,
  WsComputeResultsUpdateFilesRpc,
  WsComputeResultsUndoUpdateRpc,
  WsComputeSubmitCellsRpc,
  WsNotebookReadRpc,
  WsNotebookReadOutputRpc,
  WsNotebookEditRpc,
  WsNotebookRecordRunRpc,
  WsNotebookFreshStartRpc,
  WsNotebookFreshStatusRpc,
  WsNotebookFreshStopRpc,
  WsSubscribeNotebookFreshRunRpc,
  WsSubscribeComputeSessionsRpc,
);
