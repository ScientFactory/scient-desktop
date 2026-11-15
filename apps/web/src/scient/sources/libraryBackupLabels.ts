import type { ScientSourcesBackupStatus } from "@t3tools/contracts";

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
  return `${count(status.sources)} sources and ${count(status.pdfs)} PDFs (${count(megabytes)} MB) in ${status.path}`;
}
