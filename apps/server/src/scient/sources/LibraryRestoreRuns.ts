// @effect-diagnostics globalDate:off -- A restore's failure is reported with an interoperable ISO timestamp.
import {
  cancelScientLibraryRestore,
  finishScientLibraryRestore,
  prepareScientLibraryPutBack,
  prepareScientLibraryRestore,
  readScientLibraryRestorePending,
  type ScientLibraryRestoreFinished,
  type ScientLibraryRestorePrepared,
} from "@scientfactory/scient-sources/library-restore";
import { scientLibraryRootFor } from "@scientfactory/scient-sources/library-root";
import type { ScientSourcesRestoreStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ScientSourcesBackend } from "./SourcesBackend.ts";

type Ended = Extract<ScientSourcesRestoreStatus, { readonly state: "restored" | "failed" }>;

/**
 * Restoring the Library in this server, by Library folder. `preparing` is the copy this server
 * is making now; `ended` is how the last restore ended (the copy that failed, or what this
 * start put in place), kept until the next one or until the server stops.
 */
const preparing = new Map<string, Extract<ScientSourcesRestoreStatus, { state: "preparing" }>>();
const ended = new Map<string, Ended>();
/** Why this start could not put a waiting copy in place, while that copy still waits. */
const problems = new Map<string, string>();

const failed = (reason: string): Ended => ({
  state: "failed",
  failedAt: new Date().toISOString(),
  reason,
});

const reasonOf = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The backup could not be copied.";

function notPrepared(result: Exclude<ScientLibraryRestorePrepared, { outcome: "ready" }>): string {
  switch (result.outcome) {
    case "not-a-backup":
      return "This folder is not a finished Scient Library backup.";
    case "unsupported":
      return "This backup was made by a later version of Scient. Update Scient, then restore it.";
    case "unsafe-paths":
      return `This backup lists a file Scient will not write on this computer (${result.file}). Nothing was restored.`;
    case "damaged":
      return `The backup is damaged: ${result.file} is missing, changed or does not belong. Nothing was restored.`;
    case "busy":
      return "Another restore is being prepared.";
    case "unfinished":
      return "An earlier restore is part way through. Quit Scient and open it again to finish it, then restore.";
    case "stopped":
      return "The restore was stopped.";
  }
}

/** Reads only: the copy this server is making, the one that waits, or how the last one ended. */
export async function libraryRestoreStatus(
  libraryRoot: string,
): Promise<ScientSourcesRestoreStatus> {
  const running = preparing.get(libraryRoot);
  if (running) return running;
  const waiting = await readScientLibraryRestorePending(libraryRoot).catch(() => null);
  if (waiting) {
    const problem = problems.get(libraryRoot);
    // A request made since that failed left this copy waiting; both are said.
    const last = ended.get(libraryRoot);
    return {
      state: "ready",
      ...(waiting.restoreId ? { restoreId: waiting.restoreId } : {}),
      backupCreatedAt: waiting.backupCreatedAt,
      sources: waiting.counts.sources,
      pdfs: waiting.counts.pdfs,
      ...(waiting.putBack === undefined ? {} : { putBack: true }),
      ...(waiting.begun ? { begun: true } : {}),
      ...(problem === undefined ? {} : { problem }),
      ...(last?.state === "failed"
        ? { refused: { failedAt: last.failedAt, reason: last.reason } }
        : {}),
    };
  }
  return ended.get(libraryRoot) ?? { state: "none" };
}

/** Starts checking and copying a backup beside the Library, unless a copy is being made. */
export function startLibraryRestore(libraryRoot: string, fromFolder: string): void {
  if (preparing.has(libraryRoot)) return;
  preparing.set(libraryRoot, { state: "preparing", done: 0, total: 0 });
  ended.delete(libraryRoot);
  problems.delete(libraryRoot);
  void prepareScientLibraryRestore({
    libraryRoot,
    backup: fromFolder,
    onProgress: ({ done, total }) =>
      preparing.set(libraryRoot, { state: "preparing", done, total }),
  })
    .then(
      (result) => {
        if (result.outcome !== "ready") ended.set(libraryRoot, failed(notPrepared(result)));
      },
      (cause: unknown) => {
        ended.set(libraryRoot, failed(reasonOf(cause)));
      },
    )
    .finally(() => preparing.delete(libraryRoot));
}

/**
 * Arranges for a Library a restore kept to take the Library's place at the next start. It
 * copies nothing, so it is answered at once; a refusal is remembered like a failed restore.
 */
export async function putBackLibrary(libraryRoot: string, folder: string): Promise<void> {
  if (preparing.has(libraryRoot)) return;
  ended.delete(libraryRoot);
  problems.delete(libraryRoot);
  const result = await prepareScientLibraryPutBack({ libraryRoot, folder }).catch(
    (cause: unknown) => reasonOf(cause),
  );
  if (typeof result === "string") {
    ended.set(libraryRoot, failed(result));
    return;
  }
  switch (result.outcome) {
    case "ready":
      return;
    case "not-kept":
      ended.set(
        libraryRoot,
        failed("That folder is not a Library a restore kept, or it is no longer there."),
      );
      return;
    case "busy":
      ended.set(libraryRoot, failed("Another restore is being prepared."));
      return;
    case "unfinished":
      ended.set(
        libraryRoot,
        failed(
          "An earlier restore is part way through. Quit Scient and open it again to finish it, then try again.",
        ),
      );
  }
}

/**
 * Drops the copy that waits; a copy still being made is left to finish first, and a restore
 * that already moved a folder is left for the next start.
 */
export async function cancelLibraryRestore(
  libraryRoot: string,
  /** The waiting restore the person saw: another window may have replaced it since. */
  restoreId?: string,
): Promise<void> {
  if (preparing.has(libraryRoot)) return;
  const { outcome } = await cancelScientLibraryRestore(libraryRoot, restoreId);
  if (outcome === "begun" || outcome === "another") return;
  problems.delete(libraryRoot);
  ended.delete(libraryRoot);
}

function remember(libraryRoot: string, finished: ScientLibraryRestoreFinished): void {
  switch (finished.outcome) {
    case "none":
      return;
    case "restored":
      ended.set(libraryRoot, {
        state: "restored",
        restoreId: finished.restoreId,
        backupCreatedAt: finished.backupCreatedAt,
        ...(finished.putBack ? { putBack: true } : {}),
        sources: finished.counts.sources,
        pdfs: finished.counts.pdfs,
        ...(finished.keptReplaced ? { kept: finished.keptReplaced } : {}),
      });
      return;
    case "failed":
      if (finished.waiting) problems.set(libraryRoot, finished.reason);
      else ended.set(libraryRoot, failed(finished.reason));
  }
}

/**
 * Puts a waiting copy of a backup in the Library's place. Runs once at the server's start,
 * after it owns its data folder and before anything reads or writes the Library. A failure is
 * logged and remembered for the panel; it never stops the server from starting.
 */
export const finishLibraryRestoreAtStart = Effect.fn("ScientLibraryRestore.finishAtStart")(
  function* (stateDir: string) {
    if ((yield* ScientSourcesBackend) !== "library") return;
    const libraryRoot = scientLibraryRootFor(stateDir);
    yield* Effect.promise(() => finishScientLibraryRestore(libraryRoot)).pipe(
      Effect.tap((finished) =>
        finished.outcome === "none"
          ? Effect.void
          : Effect.logInfo("The Library's waiting restore was handled at start.", {
              outcome: finished.outcome,
            }),
      ),
      Effect.map((finished) => remember(libraryRoot, finished)),
      Effect.catchCause((cause) =>
        Effect.logWarning("The Library's waiting restore could not be finished.", { cause }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              problems.set(libraryRoot, "Scient could not finish it at its last start.");
            }),
          ),
        ),
      ),
    );
  },
);
