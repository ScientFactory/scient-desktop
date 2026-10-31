import { ComputeGatewayError } from "@t3tools/contracts";
import { notebookCellRun } from "@t3tools/shared/notebookStaleness";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import { ComputeSessionService, type ComputeSettledRun } from "../compute/ComputeSessionService.ts";
import { ComputeWorkspaceAdmission } from "../compute/ComputeWorkspaceAdmission.ts";
import { NotebookStore } from "./NotebookStore.ts";

const unreadable = (cause: { readonly message: string }) =>
  new ComputeGatewayError({
    operation: "outputs",
    reason: "operation-failed",
    message: cause.message,
  });

/** A cell's results reach its notebook when the run ends, whether or not a tab is open on it. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const compute = yield* ComputeSessionService;
    const notebooks = yield* NotebookStore;
    const fileSystem = yield* FileSystem.FileSystem;

    const record = Effect.fn("NotebookRunRecorder.record")(function* ({
      projectId,
      root,
      workspace,
      execution,
    }: ComputeSettledRun) {
      const { request, result } = execution;
      const { source, sessionId, executionId } = request;
      // A queued run that never started has nothing to say about the cell.
      if (source?._tag !== "document" || source.cell === undefined || !result?.startedAt) return;
      const outputs = makeComputeNotebookOutputs({
        gateway: {
          getSession: (input) =>
            compute
              .getSession({ projectId, sessionId: input.sessionId })
              .pipe(Effect.mapError(unreadable)),
          listOutputs: (input) =>
            compute.listOutputs({ ...input, projectId }).pipe(Effect.mapError(unreadable)),
        },
        compute,
        fileSystem,
      });
      yield* notebooks
        .recordRun(
          {
            cwd: root,
            path: source.path,
            cellId: source.cell,
            sessionId,
            executionId,
            executionCount: result.executionCount ?? null,
            run: notebookCellRun(execution),
          },
          outputs,
        )
        .pipe(Effect.provideService(ComputeWorkspaceAdmission, workspace));
    });

    yield* compute.settledRuns.pipe(
      Stream.runForEach((run) =>
        record(run).pipe(
          Effect.catchCause((cause) => Effect.logWarning("notebook run not recorded", { cause })),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
