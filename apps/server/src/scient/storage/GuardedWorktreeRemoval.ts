import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  CheckoutLookupError,
  CheckoutRecoveryRequiredError,
  type CheckoutBarrierShape,
} from "../workspace/CheckoutBarrier.ts";

const isBarrierRefusal = Schema.is(
  Schema.Union([CheckoutRecoveryRequiredError, CheckoutLookupError]),
);
const isLookupError = Schema.is(CheckoutLookupError);

/**
 * Storage cleanup removes a worktree as a bulk change of its checkout, so an unfinished Overleaf
 * sync in it keeps it (overleaf-checkout-barrier). `removal` moves the checkout aside, inspects it
 * again and removes it, uninterrupted; a reason it returns keeps the checkout.
 */
export const removeGuardedWorktree = Effect.fn("StorageCleanup.removeGuardedWorktree")(function* <
  E,
  R,
>(
  barrier: CheckoutBarrierShape,
  worktreePath: string,
  removal: Effect.Effect<string | null, E, R>,
) {
  return yield* barrier
    .bulk(worktreePath, removal.pipe(Effect.uninterruptible), { missing: "skip" })
    .pipe(
      Effect.catchIf(isBarrierRefusal, (error) =>
        Effect.succeed(
          isLookupError(error)
            ? "its folder could not be examined"
            : error.reason === "unreadable-record"
              ? "an Overleaf link record can't be read; set it aside in Settings › Synced folders › Overleaf"
              : error.reason === "newer-unfinished-record"
                ? "a newer version of Scient left an Overleaf sync unfinished; finish it there"
                : error.reason === "unlinked-unfinished-sync"
                  ? "an unlinked Overleaf folder has an unfinished sync; link it again to finish it"
                  : "an unfinished Overleaf sync needs recovery first",
        ),
      ),
    );
});

/** A task folder's checkout and the repository its record says it is a worktree of. */
export interface RecordedCheckout {
  readonly worktreePath: string;
  readonly repositoryPath: string;
}

// The folder at a recorded path may since have become another repository's worktree, even on the
// same branch name. Only a linked worktree registered in the recorded repository may go.
const recordedRepositoryReason = Effect.fn("StorageCleanup.recordedRepositoryReason")(function* (
  execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  checkout: RecordedCheckout,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDirectories = Effect.fnUntraced(function* (cwd: string) {
    const result = yield* execute({
      operation: "StorageCleanup.recordedRepository",
      cwd,
      args: ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    });
    const [gitDir = "", commonDir = ""] = result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    return {
      gitDir: yield* fileSystem.realPath(gitDir),
      commonDir: yield* fileSystem.realPath(path.resolve(cwd, commonDir)),
    };
  });
  return yield* Effect.gen(function* () {
    const repository = yield* gitDirectories(checkout.repositoryPath);
    const worktree = yield* gitDirectories(checkout.worktreePath);
    return worktree.commonDir === repository.commonDir &&
      path.dirname(worktree.gitDir) === path.join(repository.commonDir, "worktrees")
      ? null
      : `it is not a Git worktree of ${checkout.repositoryPath}`;
  }).pipe(
    Effect.orElseSucceed(
      () => `it could not be confirmed as a Git worktree of ${checkout.repositoryPath}`,
    ),
  );
});

/**
 * Removes a task folder's checkout as `removeGuardedWorktree` does, through the repository its
 * record names, after confirming within the barrier that the folder is still a worktree of it.
 */
export const removeGuardedCheckout = <E, R>(
  barrier: CheckoutBarrierShape,
  execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  checkout: RecordedCheckout,
  removeIsolated: (repositoryPath: string) => Effect.Effect<string | null, E, R>,
) =>
  removeGuardedWorktree(
    barrier,
    checkout.worktreePath,
    recordedRepositoryReason(execute, checkout).pipe(
      Effect.filterOrElse(
        (reason): reason is string => reason !== null,
        () => removeIsolated(checkout.repositoryPath),
      ),
    ),
  );
