import { msg, T } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import type { TurnDiffSummary } from "~/types";

/**
 * A checkpoint the server could not capture leaves a diagnostics affordance
 * in the revert dialog, so a missing diff is explainable rather than silent.
 */
export function findFileHistoryIssue(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
): TurnDiffSummary | null {
  return turnDiffSummaries.findLast((checkpoint) => checkpoint.status === "error") ?? null;
}

/** Why the revert dialog leaves the files as they are; it then offers only "Rewind chat". */
export function describeUnrestorableRevertFiles(
  reason: "outside-worktree" | "no-snapshot",
  resolve: MessageResolver = m,
): string {
  return reason === "no-snapshot"
    ? resolve(
        msg(
          "Your files stay as they are: Scient could not save a snapshot of them from before this message.",
        ),
      )
    : resolve(msg("Your files stay as they are."));
}

/**
 * The revert dialog's diagnostics: a checkpoint the server could not capture,
 * so a missing diff is explainable rather than silent, and the last rewind
 * failure.
 */
export function ScientRevertDialogDiagnostics(props: {
  readonly fileHistoryIssue: TurnDiffSummary | null;
  readonly error: string | undefined;
}) {
  const { fileHistoryIssue, error } = props;
  return (
    <>
      {fileHistoryIssue ? (
        <details className="text-sm text-muted-foreground">
          <summary>
            <T>File history diagnostics</T>
          </summary>
          <p>
            <T>
              Some file history or change comparisons were unavailable in this conversation. This
              does not affect the agent’s answers.
            </T>
          </p>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(
              {
                runId: fileHistoryIssue.runId,
                scopeId: fileHistoryIssue.scopeId,
                checkpointId: fileHistoryIssue.checkpointId,
                status: fileHistoryIssue.status,
              },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            <T>
              Could not rewind this conversation. Your current conversation and files may need
              review before retrying.
            </T>
          </p>
          <details>
            <summary>
              <T>Details</T>
            </summary>
            <pre className="whitespace-pre-wrap break-words">{error}</pre>
          </details>
        </div>
      ) : null}
    </>
  );
}
