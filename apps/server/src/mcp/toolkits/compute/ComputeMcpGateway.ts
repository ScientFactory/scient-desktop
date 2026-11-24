import type { ComputeOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { ScientificRunServices } from "../../../scient/analysis/ScientificRunServices.ts";
import type { ComputeRpcGateway } from "../../../scient/compute/ComputeRpcGateway.ts";
import type { makeComputeNotebookOutputs } from "../../../scient/compute/ComputeNotebookOutputs.ts";
import * as ComputeSessionService from "../../../scient/compute/ComputeSessionService.ts";
import type { makeNotebookReader } from "../../../scient/notebook/notebookReader.ts";
import type { makeNotebookRuns } from "../../../scient/notebook/notebookRuns.ts";
import * as NotebookStore from "../../../scient/notebook/NotebookStore.ts";
import { AnalysisService } from "../../../scient/analysis/AnalysisService.ts";
import type { ComputeOutputResourceRef } from "@scientfactory/compute";
import { DataViews } from "../../../scient/data/DataViews.ts";
import type { ResultHandoff } from "../../../scient/results/handoff/ResultHandoff.ts";
import type { ResultOperations } from "../../../scient/results/resultOperations.ts";

export interface ComputeOutputBytes {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The same project-scoped operations the app uses, so agent and user share sessions. */
export interface ComputeMcpGatewayShape extends ComputeRpcGateway {
  /** Bytes of a stored figure or resource, for returning figures to the agent. */
  readonly readOutput: (
    ref: ComputeOutputResourceRef,
    kind: "image" | "resource",
  ) => Effect.Effect<ComputeOutputBytes | null, ComputeOperationError>;
  /** A finished run as nbformat outputs, for writing into its notebook cell. */
  readonly notebookOutputs: ReturnType<typeof makeComputeNotebookOutputs>;
  /** The same notebooks the app has open. */
  readonly readNotebook: NotebookStore.NotebookStore["Service"]["read"];
  readonly readNotebookOutput: NotebookStore.NotebookStore["Service"]["readOutput"];
  readonly editNotebook: NotebookStore.NotebookStore["Service"]["edit"];
  readonly recordNotebookRun: NotebookStore.NotebookStore["Service"]["recordRun"];
  readonly notebookAlternatives: ReturnType<typeof makeNotebookReader>;
  readonly runNotebookFresh: ReturnType<typeof makeNotebookRuns>["start"];
  readonly notebookFreshStatus: ReturnType<typeof makeNotebookRuns>["status"];
  readonly stopNotebookFresh: ReturnType<typeof makeNotebookRuns>["stop"];
  readonly waitNotebookFresh: ReturnType<typeof makeNotebookRuns>["wait"];
  readonly flushNotebook: NotebookStore.NotebookStore["Service"]["flush"];
  /** The same runs the app's Run button starts, for files in languages without a session. */
  readonly getFileRun: AnalysisService["Service"]["getRun"];
  readonly inspectFileRuntimes: AnalysisService["Service"]["inspectRuntimes"];
  readonly startFileRun: AnalysisService["Service"]["startRun"];
  readonly subscribeFileRuns: AnalysisService["Service"]["subscribeRuns"];
  readonly readFile: WorkspaceFileSystem.WorkspaceFileSystem["Service"]["readFile"];
  readonly profileDataset: DataViews["Service"]["profileDataset"];
  readonly previewDataView: DataViews["Service"]["readView"];
  readonly saveDataView: DataViews["Service"]["saveView"];
  readonly materializeDataView: DataViews["Service"]["materializeView"];
  /** Linked results: what fresh script runs published, for agents to cite and check. */
  readonly resultHandoffChoices: ResultHandoff["choices"];
  readonly exportResultPackage: ResultHandoff["exportPackage"];
  readonly verifyResultPackage: ResultHandoff["verify"];
  readonly resolveResults: ResultOperations["resolve"];
  readonly resultOutputContent: ResultOperations["outputContent"];
  readonly listResults: ResultOperations["list"];
  readonly resultSetup: ResultOperations["setup"];
  readonly resultHistory: ResultOperations["history"];
  readonly compareResults: ResultOperations["compare"];
  readonly placeResultFigure: ResultOperations["placeFigure"];
  readonly rerunResults: ResultOperations["rerun"];
  readonly checkResults: ResultOperations["check"];
  readonly placeLatexResult: ResultOperations["placeLatex"];
  readonly latexResultFiles: ResultOperations["placements"];
}

export class ComputeMcpGateway extends Context.Service<ComputeMcpGateway, ComputeMcpGatewayShape>()(
  "t3/mcp/toolkits/compute/ComputeMcpGateway",
) {}

export const ComputeMcpGatewayLive = Layer.effect(
  ComputeMcpGateway,
  Effect.gen(function* () {
    const compute = yield* ComputeSessionService.ComputeSessionService;
    const fileSystem = yield* FileSystem.FileSystem;
    const {
      computeGateway: rpc,
      computeNotebookOutputs: notebookOutputs,
      notebookReader,
      notebookRuns,
      results: resultOperations,
      resultHandoff,
    } = yield* ScientificRunServices;
    const readOutput = Effect.fn("ComputeMcpGateway.readOutput")(function* (
      ref: ComputeOutputResourceRef,
      kind: "image" | "resource",
    ) {
      const resolved =
        kind === "image"
          ? yield* compute.resolveOutputImage(ref)
          : yield* compute.resolveOutputResource(ref);
      if (resolved === null) return null;
      const bytes = yield* fileSystem.readFile(resolved.path).pipe(Effect.option);
      return Option.isSome(bytes) ? { mediaType: resolved.mediaType, bytes: bytes.value } : null;
    });
    const dataViews = yield* DataViews;
    const notebooks = yield* NotebookStore.NotebookStore;
    const fileRuns = yield* AnalysisService;
    const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return ComputeMcpGateway.of({
      resultHandoffChoices: resultHandoff.choices,
      exportResultPackage: resultHandoff.exportPackage,
      verifyResultPackage: resultHandoff.verify,
      ...rpc,
      runHistory: Effect.fn("ComputeMcpGateway.runHistory")((request) =>
        rpc.runHistory(request, fileRuns.listRuns),
      ),
      readOutput,
      notebookOutputs,
      runNotebookFresh: notebookRuns.start,
      notebookFreshStatus: notebookRuns.status,
      stopNotebookFresh: notebookRuns.stop,
      waitNotebookFresh: notebookRuns.wait,
      notebookAlternatives: notebookReader,
      readNotebook: notebooks.read,
      readNotebookOutput: notebooks.readOutput,
      editNotebook: notebooks.edit,
      recordNotebookRun: notebooks.recordRun,
      flushNotebook: notebooks.flush,
      getFileRun: fileRuns.getRun,
      inspectFileRuntimes: fileRuns.inspectRuntimes,
      startFileRun: fileRuns.startRun,
      subscribeFileRuns: fileRuns.subscribeRuns,
      readFile: workspaceFiles.readFile,
      profileDataset: dataViews.profileDataset,
      previewDataView: dataViews.readView,
      saveDataView: dataViews.saveView,
      materializeDataView: dataViews.materializeView,
      resolveResults: resultOperations.resolve,
      listResults: resultOperations.list,
      resultOutputContent: resultOperations.outputContent,
      resultSetup: resultOperations.setup,
      resultHistory: resultOperations.history,
      compareResults: resultOperations.compare,
      placeResultFigure: resultOperations.placeFigure,
      rerunResults: resultOperations.rerun,
      checkResults: resultOperations.check,
      placeLatexResult: resultOperations.placeLatex,
      latexResultFiles: resultOperations.placements,
    });
  }),
);
