// @effect-diagnostics globalDate:off -- A join's end is reported with an interoperable ISO timestamp.
import {
  joinScientLibrary,
  undoScientLibraryJoin,
} from "@scientfactory/scient-sources/library-join";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import type { ScientSourceActor } from "@scientfactory/scient-sources";
import type { ScientSourcesJoinStatus } from "@t3tools/contracts";

/**
 * Adding another Library's new sources in this server, by Library folder: one at a time,
 * running on after the request that started it. How the last one ended is kept until the next
 * starts or the server stops; the Library's own record of each join is what lasts.
 */
const runs = new Map<string, ScientSourcesJoinStatus>();
/** The join under way for a Library, once it has its record. */
const running = new Map<string, string>();

export function libraryJoinStatus(library: ScientLibraryLocation): ScientSourcesJoinStatus {
  return runs.get(library.root) ?? { state: "none" };
}

/** The joins under way in this server: any other unfinished one stopped part way. */
export function runningLibraryJoins(library: ScientLibraryLocation): ReadonlySet<string> {
  const joinId = running.get(library.root);
  return new Set(joinId ? [joinId] : []);
}

const reasonOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The other Library could not be read.";

/** Starts adding from a backup folder or a Library a restore moved aside, unless one runs. */
export function startLibraryJoin(
  library: ScientLibraryLocation,
  fromFolder: string,
  actor: ScientSourceActor,
): { readonly outcome: "join-started" | "join-running" } {
  if (runs.get(library.root)?.state === "running") return { outcome: "join-running" };
  runs.set(library.root, { state: "running", done: 0, total: 0 });
  let added = 0;
  const failed = (reason: string) =>
    runs.set(library.root, {
      state: "failed",
      failedAt: new Date().toISOString(),
      reason,
      added,
    });
  void joinScientLibrary({
    library,
    folder: fromFolder,
    actor,
    onStarted: (joinId) => running.set(library.root, joinId),
    onProgress: (progress) => {
      added = progress.added;
      runs.set(library.root, { state: "running", done: progress.done, total: progress.total });
    },
  })
    .then(
      (result) => {
        switch (result.outcome) {
          case "joined":
            runs.set(library.root, {
              state: "done",
              joinId: result.joinId,
              finishedAt: new Date().toISOString(),
              added: result.added,
              skipped: result.skipped,
              different: result.different,
              removedHere: result.removedHere,
              removedThere: result.removedThere,
              missingPdfs: result.missingPdfs,
              unplacedIn: [...result.unplacedIn],
            });
            return;
          case "busy":
            failed(
              "Another addition, or the Undo of one, is running. Try again when it has finished.",
            );
            return;
          case "damaged":
            failed(
              "The backup is damaged: its files do not match its own list. Nothing was added.",
            );
            return;
          case "same-library":
            failed("That folder is this Library itself.");
            return;
          case "not-a-library":
            failed(
              "Choose a Scient Library backup folder. A Library that another Scient is using cannot be added from; back it up there first.",
            );
        }
      },
      (cause: unknown) => failed(reasonOf(cause)),
    )
    .finally(() => running.delete(library.root));
  return { outcome: "join-started" };
}

/** Moves what a join added to the Trash, each source only if unchanged since; as the panel answers. */
export async function undoLibraryJoin(
  library: ScientLibraryLocation,
  joinId: string,
  actor: ScientSourceActor,
) {
  const undone = await undoScientLibraryJoin({ library, joinId, actor });
  switch (undone.outcome) {
    case "undone":
      return {
        outcome: "join-undone" as const,
        joinUndone: { trashed: undone.trashed, left: undone.left },
      };
    case "not-found":
      return { outcome: "join-not-found" as const };
    case "running":
      return { outcome: "join-busy" as const };
    case "already-undone":
      return { outcome: "already-undone" as const };
  }
}
