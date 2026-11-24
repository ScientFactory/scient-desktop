import type { NotebookFreshRun } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { Button } from "~/components/ui/button";

// Shows a fresh run while it runs and anything that went wrong; a run that succeeded says nothing.
export function NotebookFreshRunStatus(props: {
  readonly job: NotebookFreshRun | null;
  readonly running: boolean;
  readonly message: string | null;
  readonly onStop?: () => void;
}) {
  const { job, running } = props;
  const outcome = job?.outcome;
  const message =
    props.message ??
    (outcome?._tag === "failed" ? outcome.message : (outcome?.notebookMessage ?? null));
  const publicationMessage = outcome?._tag === "completed" ? outcome.message : undefined;
  const progress = job?.progress;
  const sweep =
    job?.outcome === undefined || job.sweepSummary?.failures.length === 0
      ? undefined
      : job.sweepSummary;
  if (!running && message === null && publicationMessage === undefined && sweep === undefined)
    return null;
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
      <div role="status" className="min-w-0 tabular-nums">
        {running ? (
          <>
            <p className="font-medium text-foreground">
              {progress?.phase === "stopping" ? (
                <T>Stopping notebook…</T>
              ) : progress?.phase === "saving" ? (
                <T>Saving notebook run…</T>
              ) : progress?.phase === "running" ? (
                <T>
                  Cell <Var>{progress.cell}</Var> of <Var>{progress.total}</Var>
                </T>
              ) : (
                <T>Starting notebook…</T>
              )}
            </p>
            <p>
              <T>Editing resumes when the fresh run finishes</T>
            </p>
          </>
        ) : null}
        {publicationMessage === undefined ? null : <p>{publicationMessage}</p>}
        {sweep === undefined ? null : (
          <>
            <p>
              <T>
                <Var>{sweep.saved}</Var> of <Var>{sweep.total}</Var> runs saved
              </T>
            </p>
            <ul className="max-h-20 overflow-auto">
              {sweep.failures.map(({ parameters, message, index }) => (
                <li key={index}>
                  {Object.entries(parameters)
                    .map(([name, value]) => `${name} = ${value}`)
                    .join(", ")}{" "}
                  · {message}
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
      {running && job && props.onStop ? (
        <Button
          size="xs"
          variant="outline"
          disabled={progress?.phase === "saving" || progress?.phase === "stopping"}
          onClick={props.onStop}
        >
          <T>Stop</T>
        </Button>
      ) : null}
    </div>
  );
}
