import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import { makeComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import * as ComputeSessionService from "../compute/ComputeSessionService.ts";
import { ScientificRuntimePreferences } from "../compute/ScientificRuntimePreferences.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { makeNotebookReader } from "../notebook/notebookReader.ts";
import { NotebookRunJobs } from "../notebook/NotebookRunJobs.ts";
import { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import * as NotebookStore from "../notebook/NotebookStore.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import { ComputeResults } from "../results/ComputeResults.ts";
import { makeResultHandoff } from "../results/handoff/ResultHandoff.ts";
import { makeResultOperations } from "../results/resultOperations.ts";

const make = Effect.gen(function* () {
  const { computeDir } = yield* ServerConfig;
  const compute = yield* ComputeSessionService.ComputeSessionService;
  const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const computeGateway = makeComputeRpcGateway({
    compute,
    workspaceResolver: yield* WorkspaceBindingResolver,
    serverSettings: yield* ScientificRuntimePreferences,
    workspaceFileSystem: workspace,
  });
  const computeNotebookOutputs = makeComputeNotebookOutputs({
    gateway: computeGateway,
    compute,
    fileSystem: yield* FileSystem.FileSystem,
  });
  const notebookRuns = makeNotebookRuns({
    computeDir,
    jobs: yield* NotebookRunJobs,
    workspacePaths: yield* WorkspacePaths,
    gateway: computeGateway,
    notebooks: yield* NotebookStore.NotebookStore,
    notebookOutputs: computeNotebookOutputs,
  });
  return {
    computeGateway,
    computeNotebookOutputs,
    notebookRuns,
    notebookReader: makeNotebookReader(computeDir, computeGateway),
    results: makeResultOperations({
      gateway: computeGateway,
      results: yield* ComputeResults,
      runNotebookFresh: notebookRuns.run,
      runtimeDescriptors: compute.runtimeDescriptors,
      workspace,
    }),
    resultHandoff: makeResultHandoff({
      layout: { computeDir },
      gateway: computeGateway,
      process: yield* ExecutionProcess,
    }),
  };
});

export class ScientificRunServices extends Context.Service<
  ScientificRunServices,
  Effect.Success<typeof make>
>()("t3/scient/analysis/ScientificRunServices") {}

export const layer = Layer.effect(ScientificRunServices, make);
