import type { NotebookFreshRun } from "@t3tools/contracts";
import { T } from "gt-react";
import { Button } from "~/components/ui/button";

export function NotebookFreshRunStatus(props: {
  readonly job: NotebookFreshRun | null;
  readonly running: boolean;
  readonly message: string | null;
  readonly onStop?: () => void;
}) {
  const { job, message, running } = props;
  const progress = job?.progress;
  const sweep = job?.outcome === undefined ? undefined : job.sweepSummary;
  const published =
    job?.outcome?._tag === "published" && sweep === undefined ? job.publishedResults : undefined;
  if (!running && message === null && sweep === undefined && published === undefined) return null;
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
                  Cell {progress.cell} of {progress.total}
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
            {published === 1 ? <T>Published 1 result</T> : <T>Published {published} results</T>}
          </p>
        ) : null}
        {sweep === undefined ? null : (
          <>
            <p>
              <T>
                {sweep.saved} of {sweep.total} runs saved
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
