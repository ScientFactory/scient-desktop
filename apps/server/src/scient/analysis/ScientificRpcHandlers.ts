/**
 * Handlers for Scient's analysis and compute RPC group, and the analysis
 * runtime inspection that the shared repository group carries. ws.ts builds
 * them per connection with its authorized RPC wrappers.
 *
 * @module ScientificRpcHandlers
 */
import { WS_METHODS, WsRepositoryRpcGroup, WsScientificRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import type { makeComputeConsoleNotebook } from "../compute/ComputeConsoleNotebook.ts";
import type { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import {
  type makeNotebookReader,
  readNotebookWithAlternatives,
} from "../notebook/notebookReader.ts";
import type { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import { deliverWaitingRuns } from "../notebook/NotebookRunRecorder.ts";
import type * as NotebookStore from "../notebook/NotebookStore.ts";
import type { makeComputeOutputSave } from "../compute/ComputeOutputSave.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { profileTablePage } from "../data/TableProfile.ts";
import type { DataViews } from "../data/DataViews.ts";
import type * as DataTables from "../data/DataTables.ts";
import type { ResultHandoff } from "../results/handoff/ResultHandoff.ts";
import type { ResultOperations } from "../results/resultOperations.ts";
import type * as AnalysisService from "./AnalysisService.ts";

const ACTIVE_WORK_CHECK_INTERVAL = "1 second";

export const makeScientificRpcHandlers = ({
  observeRpcEffect,
  observeRpcStreamEffect,
  analysis,
  computeGateway,
  saveComputeOutput,
  notebooks,
  notebookReader,
  notebookRuns,
  saveConsoleNotebook,
  computeNotebookOutputs,
  dataTables,
  dataViews,
  results,
  resultHandoff,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStreamEffect"> & {
  readonly analysis: AnalysisService.AnalysisService["Service"];
  readonly computeGateway: ComputeRpcGateway;
  readonly saveComputeOutput: ReturnType<typeof makeComputeOutputSave>;
  readonly notebookReader: ReturnType<typeof makeNotebookReader>;
  readonly notebookRuns: Pick<
    ReturnType<typeof makeNotebookRuns>,
    "start" | "status" | "watch" | "stop"
  >;
  readonly notebooks: NotebookStore.NotebookStore["Service"];
  readonly saveConsoleNotebook: ReturnType<typeof makeComputeConsoleNotebook>;
  readonly computeNotebookOutputs: ReturnType<typeof makeComputeNotebookOutputs>;
  readonly dataViews: DataViews["Service"];
  readonly dataTables: DataTables.DataTables["Service"];
  readonly results: ResultOperations;
  readonly resultHandoff: ResultHandoff;
}) => {
  return WsScientificRpcGroup.of({
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
    // Counting reads memory only, so it checks here each second and sends only changes.
    [WS_METHODS.subscribeComputeActiveWork]: () =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeComputeActiveWork,
        Effect.succeed(
          Stream.tick(ACTIVE_WORK_CHECK_INTERVAL).pipe(
            Stream.mapEffect(() =>
              Effect.all([computeGateway.activeWork, analysis.activeRunCount]),
            ),
            Stream.map(([sessions, files]) => sessions + files),
            Stream.changes,
            Stream.map((count) => ({ count })),
          ),
        ),
        { "rpc.aggregate": "compute" },
      ),
    [WS_METHODS.computeRuntimeInventory]: (input) =>
      observeRpcEffect(WS_METHODS.computeRuntimeInventory, computeGateway.runtimeInventory(input), {
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
    [WS_METHODS.computeRunHistory]: (input) =>
      observeRpcEffect(
        WS_METHODS.computeRunHistory,
        computeGateway.runHistory(input, analysis.listRuns),
        {
          "rpc.aggregate": "compute",
        },
      ),
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
    [WS_METHODS.dataProfileFile]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.dataProfileFile,
        Effect.succeed(dataViews.profileFile(input)),
        {
          "rpc.aggregate": "workspace",
        },
      ),
    [WS_METHODS.dataProfileVariable]: (input) =>
      observeRpcEffect(
        WS_METHODS.dataProfileVariable,
        computeGateway
          .readTable({
            ...input,
            profile: true,
            query: { offset: 0, limit: 200, sort: null, search: "" },
          })
          .pipe(Effect.map(profileTablePage)),
        { "rpc.aggregate": "compute" },
      ),
    [WS_METHODS.dataViewRevision]: (input) =>
      observeRpcEffect(WS_METHODS.dataViewRevision, dataViews.viewRevision(input), {
        "rpc.aggregate": "filesystem",
      }),
    [WS_METHODS.dataReadView]: (input) =>
      observeRpcEffect(WS_METHODS.dataReadView, dataViews.readView(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.dataProfileView]: (input) =>
      observeRpcEffect(WS_METHODS.dataProfileView, dataViews.profileView(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.dataSaveView]: (input) =>
      observeRpcEffect(WS_METHODS.dataSaveView, dataViews.saveView(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.dataMaterializeView]: (input) =>
      observeRpcEffect(WS_METHODS.dataMaterializeView, dataViews.materializeView(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.computeSaveConsoleNotebook]: (input) =>
      observeRpcEffect(WS_METHODS.computeSaveConsoleNotebook, saveConsoleNotebook(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeSaveOutput]: (input) =>
      observeRpcEffect(WS_METHODS.computeSaveOutput, saveComputeOutput(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsResolve]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsResolve, results.resolve(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsHistory]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsHistory, results.history(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsCompare]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsCompare, results.compare(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsPreview]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsPreview, results.preview(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsSetup]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsSetup, results.setup(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsList]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsList, results.list(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsPublication]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsPublication, results.runPublication(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsAttemptOutput]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsAttemptOutput, results.attemptOutput(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsHandoffChoices]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsHandoffChoices, resultHandoff.choices(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsExport]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsExport, resultHandoff.exportPackage(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsExportProgress]: (input) =>
      observeRpcEffect(
        WS_METHODS.computeResultsExportProgress,
        resultHandoff.exportProgress(input),
        {
          "rpc.aggregate": "compute",
        },
      ),
    [WS_METHODS.computeResultsVerify]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsVerify, resultHandoff.verify(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsCancelVerification]: (input) =>
      observeRpcEffect(
        WS_METHODS.computeResultsCancelVerification,
        resultHandoff.cancelVerification(input),
        {
          "rpc.aggregate": "compute",
        },
      ),
    [WS_METHODS.computeResultsPlaceFigure]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsPlaceFigure, results.placeFigure(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsRerun]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsRerun, results.rerun(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsPlaceLatex]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsPlaceLatex, results.placeLatex(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsPlacements]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsPlacements, results.placements(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsUpdateFiles]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsUpdateFiles, results.updateFiles(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeResultsUndoUpdate]: (input) =>
      observeRpcEffect(WS_METHODS.computeResultsUndoUpdate, results.undoUpdate(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.computeSubmitCells]: (input) =>
      observeRpcEffect(WS_METHODS.computeSubmitCells, computeGateway.submitCells(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.notebookFreshStart]: (input) =>
      observeRpcEffect(WS_METHODS.notebookFreshStart, notebookRuns.start(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.notebookFreshStatus]: (input) =>
      observeRpcEffect(WS_METHODS.notebookFreshStatus, notebookRuns.status(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.notebookFreshStop]: (input) =>
      observeRpcEffect(WS_METHODS.notebookFreshStop, notebookRuns.stop(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.subscribeNotebookFreshRun]: (input) =>
      observeRpcStreamEffect(WS_METHODS.subscribeNotebookFreshRun, notebookRuns.watch(input), {
        "rpc.aggregate": "compute",
      }),
    [WS_METHODS.notebookRead]: (input) =>
      observeRpcEffect(
        WS_METHODS.notebookRead,
        readNotebookWithAlternatives(input, notebooks.read, notebookReader).pipe(
          Effect.tap((view) =>
            view === null
              ? Effect.void
              : deliverWaitingRuns(
                  computeGateway,
                  notebooks,
                  computeNotebookOutputs,
                  input,
                  view,
                ).pipe(Effect.ignore, Effect.forkDetach),
          ),
        ),
        {
          "rpc.aggregate": "workspace",
        },
      ),
    [WS_METHODS.notebookReadOutput]: (input) =>
      observeRpcEffect(WS_METHODS.notebookReadOutput, notebooks.readOutput(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.notebookEdit]: (input) =>
      observeRpcEffect(WS_METHODS.notebookEdit, notebooks.edit(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.notebookRecordRun]: (input) =>
      observeRpcEffect(
        WS_METHODS.notebookRecordRun,
        notebooks.recordRun(input, computeNotebookOutputs),
        {
          "rpc.aggregate": "workspace",
        },
      ),
    [WS_METHODS.subscribeComputeSessions]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeComputeSessions,
        computeGateway.subscribeSessions(input),
        { "rpc.aggregate": "compute" },
      ),
  });
};

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
