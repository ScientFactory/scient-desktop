import type { ScientSourcesMoveProgress, ScientSourcesMoveStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const PHASE_WORDS: Record<ScientSourcesMoveProgress["phase"], string> = {
  sources: msg("copying sources", { $context: "a step of moving the Library" }),
  files: msg("copying PDFs", { $context: "a step of moving the Library" }),
  verifying: msg("checking the copies", { $context: "a step of moving the Library" }),
  merging: msg("merging duplicates", { $context: "a step of moving the Library" }),
  switching: msg("switching over", { $context: "a step of moving the Library" }),
  archiving: msg("keeping a copy of the old files", { $context: "a step of moving the Library" }),
  "cleaning-up": msg("removing old files", { $context: "a step of moving the Library" }),
  restoring: msg("copying back", { $context: "a step of moving the Library" }),
};

const UNDO_SENTENCE = msg("Undo history of bulk edits from before the move was not carried over.");
// The server's own wording of the same fact, shown once in the sentence above instead.
const SERVER_UNDO_LINE = "Undo for bulk edits made before the move was not kept.";

/** The move's one line in the Library, and which control it offers. */
interface LibraryMoveLine {
  readonly text: string;
  readonly action: "dismiss" | "retry" | null;
}

const RUNNING = new Set<ScientSourcesMoveStatus["state"]>(["waiting", "moving", "restoring"]);

/** While the move waits or runs, the status is asked again. */
export function libraryMoveRunning(status: ScientSourcesMoveStatus | null): boolean {
  return status !== null && RUNNING.has(status.state);
}

/** Move back is offered only on a project whose Library has moved out. */
export function libraryMoveCanGoBack(status: ScientSourcesMoveStatus | null): boolean {
  return status?.state === "done" || status?.state === "cleanup-pending";
}

const count = (value: number) => value.toLocaleString();

/** The summary after a move; empty once dismissed, or when the move had nothing to tell. */
function summary(lines: ReadonlyArray<string>, resolve: MessageResolver): string | null {
  if (lines.length === 0) return null;
  return [...lines.filter((line) => line !== SERVER_UNDO_LINE), resolve(UNDO_SENTENCE)].join(" ");
}

export function libraryMoveLine(
  status: ScientSourcesMoveStatus | null,
  options: { readonly movingBack: boolean },
  resolve: MessageResolver = m,
): LibraryMoveLine | null {
  if (status === null) return null;
  switch (status.state) {
    case "nothing-to-move":
      return null;
    case "waiting":
      return {
        text: resolve(msg("The Library is waiting to move out of this project.")),
        action: null,
      };
    case "moving":
      return {
        text: status.progress
          ? resolve(
              msg("Moving the Library out of this project: {phase} {done} of {total}.", {
                phase: resolve(PHASE_WORDS[status.progress.phase]),
                done: count(status.progress.done),
                total: count(status.progress.total),
              }),
            )
          : resolve(msg("Moving the Library out of this project.")),
        action: null,
      };
    case "done": {
      const text = summary(status.lines, resolve);
      return text ? { text, action: "dismiss" } : null;
    }
    case "cleanup-pending": {
      const files = resolve(
        msg(
          "{count, plural, =1 {1 file is still open and will be removed from the project later.} other {{shown} files are still open and will be removed from the project later.}}",
          { count: status.filesLeft, shown: count(status.filesLeft) },
        ),
      );
      const text = summary(status.lines, resolve);
      return text ? { text: `${files} ${text}`, action: "dismiss" } : { text: files, action: null };
    }
    case "restoring":
      return {
        text: status.progress
          ? resolve(
              msg("Moving the Library back into this project: {done} of {total}.", {
                done: count(status.progress.done),
                total: count(status.progress.total),
              }),
            )
          : options.movingBack
            ? resolve(msg("Moving the Library back into this project."))
            : resolve(
                msg(
                  "Moving back stopped before it finished. It finishes with the next change to the Library.",
                ),
              ),
        action: null,
      };
    case "moved-back":
      return {
        text: resolve(
          msg(
            "The Library is back in this project: {sourceCount, plural, one {{sources} source} other {{sources} sources}}, {pdfCount, plural, one {{pdfs} PDF} other {{pdfs} PDFs}}.",
            {
              sourceCount: status.restoredSources,
              sources: count(status.restoredSources),
              pdfCount: status.restoredPdfs,
              pdfs: count(status.restoredPdfs),
            },
          ),
        ),
        action: null,
      };
    case "failed":
      return {
        text: resolve(msg("Moving the Library failed: {reason}", { reason: status.reason })),
        action: "retry",
      };
  }
}
