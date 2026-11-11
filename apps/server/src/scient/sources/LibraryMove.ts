import type { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  readScientLibraryMoveState,
  runScientLibraryMove,
  type ScientLibraryMoveOutcome,
} from "@scientfactory/scient-sources/library-move";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

/**
 * `git ls-files .scient/sources` through the server's git driver. Without the driver, or outside
 * a repository, nothing is tracked. Scient never commits; the status line asks the person to.
 */
const libraryMoveGitTracked = Effect.fn("ScientLibraryMove.gitTracked")(function* (root: string) {
  const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  if (Option.isNone(git)) return false;
  const result = yield* git.value
    .execute({
      operation: "ScientLibraryMove.gitTracked",
      cwd: root,
      args: ["ls-files", "-z", "--", ".scient/sources"],
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    })
    .pipe(Effect.orElseSucceed(() => null));
  return result !== null && result.exitCode === 0 && result.stdout.length > 0;
});

export type ScientLibraryMoveRunOutcome = ScientLibraryMoveOutcome | "failed";

/**
 * Moves the project into the library if it still has a v1 store, or finishes a move the journal
 * left. Only callers that hold write authority, or the server's own background pass, call this.
 * A project with nothing to move costs a journal read and a folder listing; git runs only for a
 * move that runs.
 */
export const moveProjectIntoLibrary = Effect.fn("ScientLibraryMove.run")(function* (input: {
  readonly root: string;
  readonly library: ScientLibraryLocation;
  readonly actor: ScientSourceActor;
}) {
  const state = yield* Effect.promise(() =>
    readScientLibraryMoveState({ library: input.library, projectRoot: input.root }).catch(
      () => null,
    ),
  );
  if (!state) return "failed" satisfies ScientLibraryMoveRunOutcome;
  if (state.journal?.state === "moved-back") return "moved-back";
  const unfinished = state.journal !== null && state.journal.state !== "done";
  if (!state.v1Present && !unfinished) return state.journal ? "moved" : "not-needed";
  const tracked = state.v1Present ? yield* libraryMoveGitTracked(input.root) : false;
  const result = yield* Effect.promise(() =>
    runScientLibraryMove({
      library: input.library,
      projectRoot: input.root,
      actor: input.actor,
      gitTracked: async () => tracked,
    }).then(
      (moved) => ({ moved }),
      (error: unknown) => ({ error }),
    ),
  );
  if ("error" in result) {
    yield* Effect.logWarning("Moving the project's Sources into the library failed.", {
      root: input.root,
      cause: result.error,
    });
    return "failed";
  }
  return result.moved.outcome;
});
