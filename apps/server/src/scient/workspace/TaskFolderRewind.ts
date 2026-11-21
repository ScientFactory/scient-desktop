/**
 * A file rewind refuses a shared task folder before rebuilding any checkout. A conversation-only
 * rewind skips the restore only while the provider's folder is there and, in a Git project, is
 * still the thread's worktree (a failed rebuild can leave another checkout there for a retry to
 * find); otherwise the full restore runs, and any failure blocks the rewind.
 */
import type { TaskFolder } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const prepareTaskFolderForRewind = Effect.fn("TaskFolderRewind.prepare")(function* <
  E,
  R,
  IE,
  IR,
  SE,
>(input: {
  /** Puts back every missing checkout of the task folder. */
  readonly restore: Effect.Effect<void, E, R>;
  readonly restoreFiles: boolean;
  /** The folder the provider works in. */
  readonly workingDirectory: string | null;
  readonly taskFolder: Pick<TaskFolder, "projectIsWorktree" | "projectPath" | "projectRoot">;
  /** Whether a folder is a worktree of the repository, registered at that path. */
  readonly isLinkedCheckout: (checkout: {
    readonly worktreePath: string;
    readonly repositoryPath: string;
  }) => Effect.Effect<boolean>;
  /** Whether no other thread works in the task folder. */
  readonly isolated: Effect.Effect<boolean, IE, IR>;
  readonly shared: () => SE;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const { workingDirectory, taskFolder, fileSystem } = input;
  if (input.restoreFiles) {
    if (!(yield* input.isolated)) return yield* Effect.fail(input.shared());
    return yield* input.restore;
  }
  if (
    workingDirectory !== null &&
    (yield* fileSystem.exists(workingDirectory)) &&
    // A plain project folder holds no checkout of its own; restore only checks that it exists.
    (!taskFolder.projectIsWorktree ||
      (yield* input.isLinkedCheckout({
        worktreePath: taskFolder.projectPath,
        repositoryPath: taskFolder.projectRoot,
      })))
  )
    return;
  return yield* input.restore;
});
