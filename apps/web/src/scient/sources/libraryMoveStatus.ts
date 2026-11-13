import type { ScientSourcesMoveProgress, ScientSourcesMoveStatus } from "@t3tools/contracts";

const PHASE_WORDS: Record<ScientSourcesMoveProgress["phase"], string> = {
  sources: "copying sources",
  files: "copying PDFs",
  verifying: "checking the copies",
  merging: "merging duplicates",
  switching: "switching over",
  "cleaning-up": "removing old files",
  restoring: "copying back",
};

const UNDO_SENTENCE = "Undo history of bulk edits from before the move was not carried over.";
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
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;

/** The summary after a move; empty once dismissed, or when the move had nothing to tell. */
function summary(lines: ReadonlyArray<string>): string | null {
  if (lines.length === 0) return null;
  return [...lines.filter((line) => line !== SERVER_UNDO_LINE), UNDO_SENTENCE].join(" ");
}

export function libraryMoveLine(
  status: ScientSourcesMoveStatus | null,
  options: { readonly movingBack: boolean },
): LibraryMoveLine | null {
  if (status === null) return null;
  switch (status.state) {
    case "nothing-to-move":
      return null;
    case "waiting":
      return { text: "The Library is waiting to move out of this project.", action: null };
    case "moving":
      return {
        text: status.progress
          ? `Moving the Library out of this project: ${PHASE_WORDS[status.progress.phase]} ${count(status.progress.done)} of ${count(status.progress.total)}.`
          : "Moving the Library out of this project.",
        action: null,
      };
    case "done": {
      const text = summary(status.lines);
      return text ? { text, action: "dismiss" } : null;
    }
    case "cleanup-pending": {
      const files = `${status.filesLeft === 1 ? "1 file is" : `${count(status.filesLeft)} files are`} still open and will be removed from the project later.`;
      const text = summary(status.lines);
      return text ? { text: `${files} ${text}`, action: "dismiss" } : { text: files, action: null };
    }
    case "restoring":
      return {
        text: status.progress
          ? `Moving the Library back into this project: ${count(status.progress.done)} of ${count(status.progress.total)}.`
          : options.movingBack
            ? "Moving the Library back into this project."
            : "Moving back stopped before it finished. It finishes with the next change to the Library.",
        action: null,
      };
    case "moved-back":
      return {
        text: `The Library is back in this project: ${plural(status.restoredSources, "source", "sources")}, ${plural(status.restoredPdfs, "PDF", "PDFs")}.`,
        action: null,
      };
    case "failed":
      return { text: `Moving the Library failed: ${status.reason}`, action: "retry" };
  }
}
