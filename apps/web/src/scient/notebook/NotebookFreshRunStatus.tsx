import type { NotebookFreshRun } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";

/** What a running fresh run is doing, short enough to sit in the Run button. */
export function useNotebookFreshRunProgress(
  job: NotebookFreshRun | null,
  running: boolean,
): string | null {
  const gt = useGT();
  if (!running) return null;
  const progress = job?.progress;
  switch (progress?.phase) {
    case "stopping":
      return gt("Stopping…");
    case "saving":
      return gt("Saving…");
    case "running":
      return gt("Cell {cell} of {total}", { cell: progress.cell, total: progress.total });
    default:
      return gt("Starting…");
  }
}

export interface NotebookFreshRunProblems {
  readonly key: string;
  readonly message: string | null;
  readonly publicationMessage: string | undefined;
  readonly sweep: NonNullable<NotebookFreshRun["sweepSummary"]> | undefined;
}

/** The problems a finished fresh run left, or null when it succeeded. */
export function notebookFreshRunProblems(
  job: NotebookFreshRun | null,
  running: boolean,
  error: string | null,
): NotebookFreshRunProblems | null {
  if (running) return null;
  const outcome = job?.outcome;
  const message =
    error ?? (outcome?._tag === "failed" ? outcome.message : (outcome?.notebookMessage ?? null));
  const publicationMessage = outcome?._tag === "completed" ? outcome.message : undefined;
  const sweep =
    outcome === undefined || job?.sweepSummary?.failures.length === 0
      ? undefined
      : job?.sweepSummary;
  if (message === null && publicationMessage === undefined && sweep === undefined) return null;
  return { key: `${job?.runId ?? ""}:${message ?? ""}`, message, publicationMessage, sweep };
}

export function NotebookFreshRunProblemText({
  problems: { message, publicationMessage, sweep },
}: {
  readonly problems: NotebookFreshRunProblems;
}) {
  return (
    <div className="min-w-0 space-y-1 tabular-nums">
      {publicationMessage === undefined ? null : <p>{publicationMessage}</p>}
      {sweep === undefined ? null : (
        <>
          <p>
            <T>
              <Var>{sweep.saved}</Var> of <Var>{sweep.total}</Var> runs saved
            </T>
          </p>
          <ul className="max-h-20 overflow-auto text-muted-foreground">
            {sweep.failures.map(({ parameters, message: failure, index }) => (
              <li key={index}>
                {Object.entries(parameters)
                  .map(([name, value]) => `${name} = ${value}`)
                  .join(", ")}{" "}
                · {failure}
              </li>
            ))}
          </ul>
        </>
      )}
      {message !== null &&
      (sweep === undefined || sweep.failures.every((failure) => failure.message !== message)) ? (
        <p>{message}</p>
      ) : null}
    </div>
  );
}
