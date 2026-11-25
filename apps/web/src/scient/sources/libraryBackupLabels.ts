import type {
  ScientSourcesBackupStatus,
  ScientSourcesJoinStatus,
  ScientSourcesRestoreStatus,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { dayLabel } from "./dayLabel";

export const BACKUP_LABELS = {
  menuItem: msg("Back up My Library…"),
  failed: msg("The Library was not backed up"),
  done: msg("Library backed up"),
  stillRunning: msg("An earlier backup is still running"),
} as const;

/** A second request while one runs starts nothing; the running one goes on. */
export const STILL_RUNNING_HELP = msg("Try again when the one running ends.");

const count = (value: number) => value.toLocaleString();

/** The one line shown while a backup runs. */
export function backupRunningLabel(
  status: ScientSourcesBackupStatus,
  resolve: MessageResolver = m,
): string | null {
  if (status.state !== "running") return null;
  return status.total > 0
    ? resolve(
        msg("Backing up the Library: {done} of {total} files.", {
          done: count(status.done),
          total: count(status.total),
        }),
      )
    : resolve(msg("Backing up the Library."));
}

export function backupDoneLabel(
  status: Extract<ScientSourcesBackupStatus, { state: "done" }>,
  resolve: MessageResolver = m,
): string {
  const megabytes = Math.max(1, Math.round(status.bytes / (1024 * 1024)));
  const notes = [
    status.unfinishedMoves > 0
      ? resolve(
          msg(
            "{count, plural, one {One project has not finished moving into or out of the Library. Keep that project folder too: some of its sources may be only there.} other {{shown} projects have not finished moving into or out of the Library. Keep those project folders too: some of their sources may be only there.}}",
            { count: status.unfinishedMoves, shown: count(status.unfinishedMoves) },
          ),
        )
      : "",
    status.skipped > 0
      ? resolve(
          msg(
            "{count, plural, one {One entry that is not a file was not copied; the backup's README lists it.} other {{shown} entries that are not files were not copied; the backup's README lists them.}}",
            { count: status.skipped, shown: count(status.skipped) },
          ),
        )
      : "",
  ].filter(Boolean);
  const where = resolve(
    msg("{sources} sources and {pdfs} PDFs ({megabytes} MB) in {path}", {
      sources: count(status.sources),
      pdfs: count(status.pdfs),
      megabytes: count(megabytes),
      path: status.path,
    }),
  );
  return notes.length > 0 ? `${where}. ${notes.join(" ")}` : where;
}

export const RESTORE_LABELS = {
  menuItem: msg("Restore from a backup…"),
  failed: msg("The backup was not restored"),
  restored: msg("Library restored from the backup"),
  putBack: msg("The earlier Library is back"),
  cancel: msg("Cancel"),
} as const;

/** The line shown while a backup is checked and copied, and while its copy waits. */
export function restoreLine(
  status: ScientSourcesRestoreStatus,
  resolve: MessageResolver = m,
): string | null {
  if (status.state === "preparing") {
    return status.total > 0
      ? resolve(
          msg("Checking and copying the backup: {done} of {total} files.", {
            done: count(status.done),
            total: count(status.total),
          }),
        )
      : resolve(msg("Checking and copying the backup."));
  }
  if (status.state !== "ready") return null;
  if (status.begun) {
    return status.putBack
      ? resolve(
          msg("Putting back the Library that was replaced on {day}. Restart Scient to finish.", {
            day: dayLabel(status.backupCreatedAt),
          }),
        )
      : resolve(
          msg("Restoring the backup of {day}. Restart Scient to finish.", {
            day: dayLabel(status.backupCreatedAt),
          }),
        );
  }
  const problem = status.problem
    ? resolve(
        msg("It could not be put in place ({problem}); Scient tries again at the next start.", {
          problem: status.problem,
        }),
      )
    : "";
  const line = status.putBack
    ? resolve(
        msg(
          "The Library that was replaced on {day} is ready to come back: {sources} sources and {pdfs} PDFs. It takes this Library's place when Scient restarts.",
          {
            day: dayLabel(status.backupCreatedAt),
            sources: count(status.sources),
            pdfs: count(status.pdfs),
          },
        ),
      )
    : resolve(
        msg(
          "The backup of {day} is ready: {sources} sources and {pdfs} PDFs. It replaces this Library when Scient restarts.",
          {
            day: dayLabel(status.backupCreatedAt),
            sources: count(status.sources),
            pdfs: count(status.pdfs),
          },
        ),
      );
  return problem ? `${line} ${problem}` : line;
}

/** A later request failed while an earlier copy still waits: both facts in one message. */
export function restoreRefusedLabel(
  status: Extract<ScientSourcesRestoreStatus, { state: "ready" }>,
  resolve: MessageResolver = m,
): string | null {
  if (!status.refused) return null;
  return status.putBack
    ? resolve(
        msg("{reason} The Library that was to be put back is still waiting.", {
          reason: status.refused.reason,
        }),
      )
    : resolve(
        msg("{reason} The backup of {day} that was ready is still waiting.", {
          reason: status.refused.reason,
          day: dayLabel(status.backupCreatedAt),
        }),
      );
}

export function restoredLabel(
  status: Extract<ScientSourcesRestoreStatus, { state: "restored" }>,
  resolve: MessageResolver = m,
): string {
  const kept = status.kept
    ? resolve(
        msg(
          "{count, plural, one {The Library that was here ({shown} source) is kept in {path}} other {The Library that was here ({shown} sources) is kept in {path}}}",
          { count: status.kept.sources, shown: count(status.kept.sources), path: status.kept.path },
        ),
      )
    : "";
  const line = status.putBack
    ? resolve(
        msg(
          "This is the Library that was replaced on {day} again: {sources} sources and {pdfs} PDFs.",
          {
            day: dayLabel(status.backupCreatedAt),
            sources: count(status.sources),
            pdfs: count(status.pdfs),
          },
        ),
      )
    : resolve(
        msg("{sources} sources and {pdfs} PDFs from the backup of {day}.", {
          day: dayLabel(status.backupCreatedAt),
          sources: count(status.sources),
          pdfs: count(status.pdfs),
        }),
      );
  return kept ? `${line} ${kept}` : line;
}

export const JOIN_LABELS = {
  menuItem: msg("Add from another Library…"),
  done: msg("Sources added from the other Library"),
  nothingNew: msg("No sources added from the other Library"),
  failed: msg("Nothing was added from the other Library"),
  stopped: msg("Adding from the other Library stopped part way"),
  stillRunning: msg("Sources are still being added from another Library"),
} as const;

/** The one line shown while sources are added. */
export function joinRunningLabel(
  status: ScientSourcesJoinStatus,
  resolve: MessageResolver = m,
): string | null {
  if (status.state !== "running") return null;
  // Before the first source is added the two Libraries are compared, which can take a while.
  return status.total > 0
    ? resolve(
        msg("Adding sources from the other Library: {done} of {total} done.", {
          done: count(status.done),
          total: count(status.total),
        }),
      )
    : resolve(msg("Comparing the other Library with this one."));
}

/** What a join did, and what it left alone, in the order a person cares about. */
export function joinDoneLabel(
  status: Extract<ScientSourcesJoinStatus, { state: "done" }>,
  resolve: MessageResolver = m,
): string {
  const unplaced = status.unplacedIn.slice(0, 3).join(", ");
  const lines = [
    status.added > 0
      ? resolve(
          msg(
            "{count, plural, one {Added {shown} source with its versions, notes, PDFs and highlights.} other {Added {shown} sources with their versions, notes, PDFs and highlights.}}",
            { count: status.added, shown: count(status.added) },
          ),
        )
      : resolve(msg("The other Library has no source that is new here.")),
    status.different > 0
      ? resolve(
          msg(
            "{count, plural, one {{shown} source that both Libraries hold differs or may be the same paper and was left as it is here.} other {{shown} sources that both Libraries hold differ or may be the same paper and were left as they are here.}}",
            { count: status.different, shown: count(status.different) },
          ),
        )
      : "",
    status.removedHere > 0
      ? resolve(
          msg(
            "{count, plural, one {{shown} source in this Library's Trash or deleted here was not brought back.} other {{shown} sources in this Library's Trash or deleted here were not brought back.}}",
            { count: status.removedHere, shown: count(status.removedHere) },
          ),
        )
      : "",
    status.removedThere > 0
      ? resolve(
          msg(
            "{count, plural, one {{shown} source removed in the other Library stays here.} other {{shown} sources removed in the other Library stay here.}}",
            { count: status.removedThere, shown: count(status.removedThere) },
          ),
        )
      : "",
    status.skipped > 0
      ? resolve(
          msg(
            "{count, plural, one {{shown} source could not be added; adding again tries it once more.} other {{shown} sources could not be added; adding again tries them once more.}}",
            { count: status.skipped, shown: count(status.skipped) },
          ),
        )
      : "",
    status.missingPdfs > 0
      ? resolve(
          msg(
            "{count, plural, one {One PDF was not in the other Library's folder and did not come.} other {{shown} PDFs were not in the other Library's folder and did not come.}}",
            { count: status.missingPdfs, shown: count(status.missingPdfs) },
          ),
        )
      : "",
    status.unplacedIn.length > 0
      ? resolve(
          msg(
            "{count, plural, one {Some of them could not be put in the collection {names}{more, select, yes { and others} other {}}; you can file them there by hand.} other {Some of them could not be put in the collections {names}{more, select, yes { and others} other {}}; you can file them there by hand.}}",
            {
              count: status.unplacedIn.length,
              names: unplaced,
              more: status.unplacedIn.length > 3 ? "yes" : "no",
            },
          ),
        )
      : "",
    status.added > 0 ? resolve(msg("Recent changes lists this, with Undo.")) : "",
  ];
  return lines.filter(Boolean).join(" ");
}

/** What to say when adding stopped with an error after some sources had arrived. */
export function joinStoppedLabel(
  status: Extract<ScientSourcesJoinStatus, { state: "failed" }>,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "{count, plural, one {{shown} source was added before it stopped: {reason} Recent changes lists what was added, with Undo; adding again brings the rest.} other {{shown} sources were added before it stopped: {reason} Recent changes lists what was added, with Undo; adding again brings the rest.}}",
      { count: status.added, shown: count(status.added), reason: status.reason },
    ),
  );
}
