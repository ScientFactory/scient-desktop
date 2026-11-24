import {
  ComputeGatewayError,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type NotebookView,
} from "@t3tools/contracts";
import { notebookCellRun } from "@t3tools/shared/notebookStaleness";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeComputeNotebookOutputs } from "../compute/ComputeNotebookOutputs.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { ComputeSessionService, type ComputeSettledRun } from "../compute/ComputeSessionService.ts";
import { ComputeWorkspaceAdmission } from "../compute/ComputeWorkspaceAdmission.ts";
import { NotebookStore, notebookPathAllowed } from "./NotebookStore.ts";

const unreadable = (cause: { readonly message: string }) =>
  new ComputeGatewayError({
    operation: "outputs",
    reason: "operation-failed",
    message: cause.message,
  });

const DELIVERY_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
/** Deliveries being attempted at once; ones waiting to try again hold none. */
const DELIVERY_ATTEMPTS = 4;

/**
 * A cell's results reach its notebook when the run ends, whether or not a tab is open on it.
 * The session keeps the run's output until the notebook holding it is saved, the cell is gone,
 * or the notebook file is. Fresh notebook jobs copy their own cells' output.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const compute = yield* ComputeSessionService;
    const notebooks = yield* NotebookStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Effect.scope;
    const attempts = yield* Semaphore.make(DELIVERY_ATTEMPTS);

    const deliver = Effect.fn("NotebookRunRecorder.deliver")(function* ({
      projectId,
      root,
      workspace,
      execution,
    }: ComputeSettledRun) {
      const { request, result } = execution;
      const { source, sessionId, executionId } = request;
      if (source?._tag !== "document" || source.cell === undefined) return;
      const address = { cwd: root, path: source.path };
      if (!result?.startedAt) {
        // Cancelled before it started: the cell keeps its output and stops waiting.
        yield* notebooks.forgetRun({ ...address, cellId: source.cell, executionId });
      } else {
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
              ...address,
              cellId: source.cell,
              sessionId,
              executionId,
              executionCount: result.executionCount ?? null,
              run: notebookCellRun(execution),
            },
            outputs,
          )
          .pipe(Effect.provideService(ComputeWorkspaceAdmission, workspace));
      }
      // Delivered once the file holds the result, or no longer holds the cell.
      yield* notebooks.flush(address);
    });

    /** A notebook that is gone, or was never inside the project, has nothing to deliver to. */
    const deliverable = Effect.fn("NotebookRunRecorder.deliverable")(function* ({
      root,
      execution,
    }: ComputeSettledRun) {
      const { source } = execution.request;
      if (source?._tag !== "document" || !notebookPathAllowed(source.path)) return false;
      return yield* fileSystem
        .exists(path.resolve(root, source.path))
        .pipe(Effect.orElseSucceed(() => true));
    });

    yield* compute.settledRuns.pipe(
      Stream.filter((run) => !run.notebookJob),
      Stream.runForEach((run) =>
        attempts
          .withPermits(1)(deliver(run))
          .pipe(
            Effect.tapCause((cause) =>
              Effect.logWarning("notebook run not delivered yet", { cause }),
            ),
            Effect.retry({ schedule: DELIVERY_RETRY, while: () => deliverable(run) }),
            // Stopping leaves the run unacknowledged; its notebook still names it as pending.
            Effect.onExit((exit) =>
              Exit.hasInterrupts(exit)
                ? Effect.void
                : compute.settledRunRecorded(
                    run.execution.request.sessionId,
                    run.execution.request.executionId,
                  ),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          ),
      ),
      Effect.forkScoped,
    );
  }),
);

/**
 * Delivers the runs a notebook still waits for that settled with nothing there to record them,
 * such as before the server restarted. It runs for a reader holding the workspace's admission.
 */
export const deliverWaitingRuns = Effect.fn("NotebookRunRecorder.deliverWaitingRuns")(function* (
  gateway: Pick<ComputeRpcGateway, "listSessions" | "listAllExecutions">,
  notebooks: NotebookStore["Service"],
  notebookOutputs: Parameters<NotebookStore["Service"]["recordRun"]>[1],
  address: { readonly cwd: string; readonly path: string },
  view: NotebookView,
) {
  const waiting = new Map(
    view.cells.flatMap((cell) =>
      cell.pendingExecution === null ? [] : [[cell.pendingExecution, cell.id] as const],
    ),
  );
  if (waiting.size === 0) return;
  for (const session of yield* gateway.listSessions({ cwd: address.cwd })) {
    if (session.owner?._tag !== "file" || session.owner.path !== address.path) continue;
    const executions = yield* gateway.listAllExecutions({
      cwd: address.cwd,
      sessionId: session.sessionId,
    });
    const settled = executions
      .filter(
        ({ request, result }) =>
          waiting.has(request.executionId) &&
          result !== null &&
          TERMINAL_COMPUTE_EXECUTION_STATUSES.has(result.status),
      )
      .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt));
    for (const execution of settled) {
      const { executionId, sessionId } = execution.request;
      const cellId = waiting.get(executionId) ?? "";
      if (!execution.result?.startedAt) {
        yield* notebooks.forgetRun({ ...address, cellId, executionId });
      } else {
        yield* notebooks.recordRun(
          {
            ...address,
            cellId,
            sessionId,
            executionId,
            executionCount: execution.result.executionCount ?? null,
            run: notebookCellRun(execution),
          },
          notebookOutputs,
        );
      }
    }
  }
  yield* notebooks.flush(address);
});
