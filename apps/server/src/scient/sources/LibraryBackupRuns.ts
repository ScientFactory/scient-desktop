// @effect-diagnostics globalDate:off -- A backup's end is reported with an interoperable ISO timestamp.
import { backUpScientLibrary } from "@scientfactory/scient-sources/library-backup";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import type { ScientSourcesBackupStatus } from "@t3tools/contracts";

/**
 * The Library's backup in this server, by Library folder: one at a time, running on after the
 * request that started it. The last one's end is kept until the next starts or the server stops.
 */
const runs = new Map<string, ScientSourcesBackupStatus>();

export function libraryBackupStatus(library: ScientLibraryLocation): ScientSourcesBackupStatus {
  return runs.get(library.root) ?? { state: "none" };
}

const libraryBackupRunning = (library: ScientLibraryLocation) =>
  runs.get(library.root)?.state === "running";

const reasonOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The backup could not be written.";

/** Starts a backup into a new dated folder inside `destination`, unless one is running. */
export function startLibraryBackup(
  library: ScientLibraryLocation,
  destination: string,
): { readonly outcome: "backup-started" | "backup-running" } {
  if (libraryBackupRunning(library)) return { outcome: "backup-running" };
  runs.set(library.root, { state: "running", done: 0, total: 0 });
  const ended = (status: ScientSourcesBackupStatus) => runs.set(library.root, status);
  const failed = (reason: string) =>
    ended({ state: "failed", finishedAt: new Date().toISOString(), reason });
  void backUpScientLibrary({
    library,
    destination,
    onProgress: ({ done, total }) => runs.set(library.root, { state: "running", done, total }),
  }).then(
    (result) => {
      switch (result.outcome) {
        case "backed-up":
          ended({
            state: "done",
            path: result.path,
            finishedAt: new Date().toISOString(),
            sources: result.counts.sources,
            pdfs: result.counts.pdfs,
            bytes: result.counts.bytes,
            unfinishedMoves: result.unfinishedMoves,
            skipped: result.skipped,
          });
          return;
        case "busy":
          failed("A project is moving into or out of the Library. Back up when it has finished.");
          return;
        case "unsafe-destination":
          failed("Choose a folder that exists and is not inside the Library.");
          return;
        case "stopped":
          failed("The backup was stopped.");
      }
    },
    (cause: unknown) => failed(reasonOf(cause)),
  );
  return { outcome: "backup-started" };
}
