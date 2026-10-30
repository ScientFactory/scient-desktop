import {
  ComputeGatewayError,
  type ComputeExecutionRecord,
  type ComputeNotebookOutputsResult,
  type ComputeSaveConsoleNotebookInput,
  type ComputeSaveConsoleNotebookResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { makeComputeNotebookOutputs } from "./ComputeNotebookOutputs.ts";
import type { ComputeRpcGateway } from "./ComputeRpcGateway.ts";

const MAXIMUM_NAME_ATTEMPTS = 100;
const CONSOLE_HISTORY_LIMIT = 200;

const consoleNotebookError = (message: string, cause?: unknown) =>
  new ComputeGatewayError({
    operation: "save",
    reason: "operation-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** What worked at the Console, in the order it ran. A failed try is not part of the analysis. */
export function consoleRunsWorthKeeping(
  executions: ReadonlyArray<ComputeExecutionRecord>,
): ReadonlyArray<ComputeExecutionRecord> {
  return executions
    .filter(
      (execution) =>
        execution.request.source._tag === "console" && execution.result?.status === "succeeded",
    )
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt));
}

export function consoleNotebookDocument(input: {
  readonly languageId: string;
  readonly displayName: string;
  readonly cells: ReadonlyArray<{
    readonly code: string;
    readonly outputs: ComputeNotebookOutputsResult;
  }>;
}): string {
  const document = {
    cells: input.cells.map((cell, index) => ({
      cell_type: "code",
      execution_count: cell.outputs.executionCount ?? index + 1,
      id: `console-${index + 1}`,
      metadata: {},
      outputs: cell.outputs.outputs,
      source: cell.code,
    })),
    metadata: {
      kernelspec: {
        display_name: input.displayName,
        language: input.languageId,
        name: input.languageId,
      },
      language_info: { name: input.languageId },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(document, null, 1)}\n`;
}

/** Turns what worked in a Console into a notebook in the project. */
export function makeComputeConsoleNotebook(input: {
  readonly gateway: Pick<ComputeRpcGateway, "getSession" | "listExecutions">;
  readonly notebookOutputs: ReturnType<typeof makeComputeNotebookOutputs>;
  readonly workspaceFileSystem: Pick<
    WorkspaceFileSystem.WorkspaceFileSystem["Service"],
    "createBinaryFile"
  >;
}) {
  return Effect.fn("ComputeConsoleNotebook.save")(function* (
    request: ComputeSaveConsoleNotebookInput,
  ) {
    const session = yield* input.gateway.getSession({
      cwd: request.cwd,
      sessionId: request.sessionId,
    });
    if (session === null)
      return yield* consoleNotebookError("This compute session is no longer available.");
    const executions = yield* input.gateway.listExecutions({
      cwd: request.cwd,
      sessionId: request.sessionId,
      limit: CONSOLE_HISTORY_LIMIT,
    });
    const runs = consoleRunsWorthKeeping(executions);
    if (runs.length === 0)
      return yield* consoleNotebookError("Nothing has run successfully in this Console yet.");
    const cells = yield* Effect.forEach(
      runs,
      (run) =>
        input
          .notebookOutputs({
            cwd: request.cwd,
            sessionId: request.sessionId,
            executionId: run.request.executionId,
          })
          .pipe(Effect.map((outputs) => ({ code: run.request.code, outputs }))),
      { concurrency: 4 },
    );
    const bytes = new TextEncoder().encode(
      consoleNotebookDocument({
        languageId: session.languageId,
        displayName: session.label,
        cells,
      }),
    );
    const today = DateTime.formatIsoDate(yield* DateTime.now);
    for (let attempt = 1; attempt <= MAXIMUM_NAME_ATTEMPTS; attempt += 1) {
      const relativePath =
        attempt === 1 ? `console-${today}.ipynb` : `console-${today}-${attempt}.ipynb`;
      const written = yield* input.workspaceFileSystem
        .createBinaryFile({ cwd: request.cwd, relativePath, bytes })
        .pipe(
          Effect.map((result): ComputeSaveConsoleNotebookResult => ({
            relativePath: result.relativePath,
          })),
          Effect.catchTags({ WorkspaceFileExistsError: () => Effect.succeed(null) }),
          Effect.mapError((cause) =>
            consoleNotebookError("The notebook could not be saved in the project.", cause),
          ),
        );
      if (written !== null) return written;
    }
    return yield* consoleNotebookError("Too many notebooks already use this name.");
  });
}
