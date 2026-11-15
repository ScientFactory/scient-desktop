import type { ScientSourcesBackupStatus, ScientSourcesRestoreStatus } from "@t3tools/contracts";

export const BACKUP_LABELS = {
  menuItem: "Back up the Library…",
  failed: "The Library was not backed up",
  done: "Library backed up",
} as const;

const count = (value: number) => value.toLocaleString();

/** The one line shown while a backup runs: changes wait for it, so it says so. */
export function backupRunningLabel(status: ScientSourcesBackupStatus): string | null {
  if (status.state !== "running") return null;
  const progress =
    status.total > 0 ? `: ${count(status.done)} of ${count(status.total)} files` : "";
  return `Backing up the Library${progress}. Changes to the Library wait until it finishes.`;
}

export function backupDoneLabel(
  status: Extract<ScientSourcesBackupStatus, { state: "done" }>,
): string {
  const megabytes = Math.max(1, Math.round(status.bytes / (1024 * 1024)));
  const notes = [
    status.unfinishedMoves > 0
      ? ` ${status.unfinishedMoves === 1 ? "One project has" : `${count(status.unfinishedMoves)} projects have`} not finished moving into the Library, so not all of ${status.unfinishedMoves === 1 ? "its" : "their"} sources are in this backup.`
      : "",
    status.skipped > 0
      ? ` ${status.skipped === 1 ? "One entry that is not a file was" : `${count(status.skipped)} entries that are not files were`} not copied; the backup's README lists ${status.skipped === 1 ? "it" : "them"}.`
      : "",
  ];
  const where = `${count(status.sources)} sources and ${count(status.pdfs)} PDFs (${count(megabytes)} MB) in ${status.path}`;
  return notes.some(Boolean) ? `${where}.${notes.join("")}` : where;
}

export const RESTORE_LABELS = {
  menuItem: "Restore from a backup…",
  failed: "The backup was not restored",
  restored: "Library restored from the backup",
  cancel: "Cancel",
} as const;

const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

const holding = (status: { readonly sources: number; readonly pdfs: number }) =>
  `${count(status.sources)} sources and ${count(status.pdfs)} PDFs`;

/** The line shown while a backup is checked and copied, and while its copy waits. */
export function restoreLine(status: ScientSourcesRestoreStatus): string | null {
  if (status.state === "preparing") {
    const progress =
      status.total > 0 ? `: ${count(status.done)} of ${count(status.total)} files` : "";
    return `Checking and copying the backup${progress}. The Library is not changed yet.`;
  }
  if (status.state !== "ready") return null;
  const problem = status.problem
    ? ` Scient could not put it in place at its last start (${status.problem}); it tries again at the next.`
    : "";
  return `The backup of ${day(status.backupCreatedAt)} is ready: ${holding(status)}. It replaces this Library the next time Scient starts. If this Library holds anything, it is kept in a folder beside the restored one.${problem}`;
}

export function restoredLabel(
  status: Extract<ScientSourcesRestoreStatus, { state: "restored" }>,
): string {
  const kept = status.kept
    ? ` The Library that was here (${count(status.kept.sources)} ${status.kept.sources === 1 ? "source" : "sources"}) is kept in ${status.kept.path}`
    : "";
  return `${holding(status)} from the backup of ${day(status.backupCreatedAt)}. Project folders were not changed.${kept}`;
}
