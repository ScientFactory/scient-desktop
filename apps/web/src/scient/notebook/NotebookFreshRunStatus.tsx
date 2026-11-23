import type { NotebookFreshRun } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { Button } from "~/components/ui/button";
import { PublishedResultText } from "../compute/PublishedResultText";

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
  const notebookSaved = outcome?._tag === "completed" && outcome.notebookSaved;
  const progress = job?.progress;
  const sweep = job?.outcome === undefined ? undefined : job.sweepSummary;
  const published =
    job?.outcome?._tag === "published" && sweep === undefined ? job.publishedResults : undefined;
  if (
    !running &&
    message === null &&
    publicationMessage === undefined &&
    !notebookSaved &&
    sweep === undefined &&
    published === undefined
  )
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
        {published !== undefined ? (
          <p>
            <PublishedResultText counts={published} />
          </p>
        ) : null}
        {notebookSaved ? (
          <p>
            <T>Notebook saved</T>
          </p>
        ) : null}
        {publicationMessage === undefined ? null : <p>{publicationMessage}</p>}
        {sweep === undefined ? null : (
          <>
            <p>
              <T>
                <Var>{sweep.saved}</Var> of <Var>{sweep.total}</Var> runs saved
              </T>
            </p>
            {sweep.failures.length === 0 ? null : (
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
            )}
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
