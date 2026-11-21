/**
 * A file rewind refuses a shared task folder before rebuilding any checkout. A conversation-only
 * rewind skips the restore while the provider's folder is the thread's own; otherwise a failed
 * rebuild is final, as a retry would find the provider's folder rebuilt and skip the rest.
 */
import type { TaskFolder } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/** A conversation-only rewind needed the task folder rebuilt, and the rebuild failed. */
export class TaskFolderRebuildError extends Schema.TaggedError<TaskFolderRebuildError>()(
  "TaskFolderRebuildError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The thread's task folder could not be rebuilt, so the conversation was not rewound.";
  }
}

const isTaskFolderRebuildError = Schema.is(TaskFolderRebuildError);

/** True when a failure, through its wrapping causes, is a failed rebuild: final for its request. */
export const isTaskFolderRebuildFailure = (failure: unknown): boolean => {
  let current = failure;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (isTaskFolderRebuildError(current)) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
};

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
  return yield* input.restore.pipe(
    Effect.mapError((cause) => new TaskFolderRebuildError({ cause })),
  );
});
