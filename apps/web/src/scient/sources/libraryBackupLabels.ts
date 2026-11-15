import type {
  ScientSourcesBackupStatus,
  ScientSourcesJoinStatus,
  ScientSourcesRestoreStatus,
} from "@t3tools/contracts";

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
      ? ` ${status.unfinishedMoves === 1 ? "One project has" : `${count(status.unfinishedMoves)} projects have`} not finished moving into or out of the Library. Keep ${status.unfinishedMoves === 1 ? "that project folder" : "those project folders"} too: some of ${status.unfinishedMoves === 1 ? "its" : "their"} sources may be only there.`
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

/** A later request failed while an earlier copy still waits: both facts in one message. */
export function restoreRefusedLabel(
  status: Extract<ScientSourcesRestoreStatus, { state: "ready" }>,
): string | null {
  return status.refused
    ? `${status.refused.reason} The backup of ${day(status.backupCreatedAt)} that was ready is still waiting.`
    : null;
}

export function restoredLabel(
  status: Extract<ScientSourcesRestoreStatus, { state: "restored" }>,
): string {
  const kept = status.kept
    ? ` The Library that was here (${count(status.kept.sources)} ${status.kept.sources === 1 ? "source" : "sources"}) is kept in ${status.kept.path}`
    : "";
  return `${holding(status)} from the backup of ${day(status.backupCreatedAt)}. Project folders were not changed.${kept}`;
}

export const JOIN_LABELS = {
  menuItem: "Add from another Library…",
  done: "Sources added from the other Library",
  nothingNew: "Nothing new in the other Library",
  failed: "Nothing was added from the other Library",
  stopped: "Adding from the other Library stopped part way",
} as const;

const sourcesWord = (value: number) => (value === 1 ? "1 source" : `${count(value)} sources`);

/** The one line shown while sources are added. */
export function joinRunningLabel(status: ScientSourcesJoinStatus): string | null {
  if (status.state !== "running") return null;
  const progress = status.total > 0 ? `: ${count(status.done)} of ${count(status.total)} done` : "";
  return `Adding sources from the other Library${progress}. Nothing that is in this Library is changed.`;
}

/** What a join did, and what it left alone, in the order a person cares about. */
export function joinDoneLabel(status: Extract<ScientSourcesJoinStatus, { state: "done" }>): string {
  const lines = [
    status.added > 0
      ? `Added ${sourcesWord(status.added)}, each with its versions, note, PDFs and highlights.`
      : "Every source of the other Library is already here, or was removed here.",
    status.different > 0
      ? `${sourcesWord(status.different)} that both Libraries hold ${status.different === 1 ? "differs or may be the same paper and was" : "differ or may be the same paper and were"} left as ${status.different === 1 ? "it is" : "they are"} here.`
      : "",
    status.removedHere > 0
      ? `${sourcesWord(status.removedHere)} in this Library's Trash or deleted here ${status.removedHere === 1 ? "was" : "were"} not brought back.`
      : "",
    status.removedThere > 0
      ? `${sourcesWord(status.removedThere)} removed in the other Library ${status.removedThere === 1 ? "stays" : "stay"} here.`
      : "",
    status.skipped > 0
      ? `${sourcesWord(status.skipped)} could not be added; adding again tries ${status.skipped === 1 ? "it" : "them"} once more.`
      : "",
    status.missingPdfs > 0
      ? `${status.missingPdfs === 1 ? "One PDF was" : `${count(status.missingPdfs)} PDFs were`} not in the other Library's folder and did not come.`
      : "",
    status.added > 0 ? "Recent changes lists this, with Undo." : "",
  ];
  return lines.filter(Boolean).join(" ");
}

/** What to say when adding stopped with an error after some sources had arrived. */
export function joinStoppedLabel(
  status: Extract<ScientSourcesJoinStatus, { state: "failed" }>,
): string {
  return `${sourcesWord(status.added)} ${status.added === 1 ? "was" : "were"} added before it stopped: ${status.reason} Recent changes lists what was added, with Undo; adding again brings the rest.`;
}
