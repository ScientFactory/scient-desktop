/**
 * "Edit from here" on a task folder: a file rewind refuses a shared folder before rebuilding any
 * checkout. A conversation-only rewind needs only the provider's folder; a sibling checkout that
 * cannot be put back blocks it only while that folder is still missing.
 */
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
  /** Whether no other thread works in the task folder. */
  readonly isolated: Effect.Effect<boolean, IE, IR>;
  readonly shared: () => SE;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const { workingDirectory, fileSystem } = input;
  if (input.restoreFiles) {
    if (!(yield* input.isolated)) return yield* Effect.fail(input.shared());
    return yield* input.restore;
  }
  if (workingDirectory === null) return yield* input.restore;
  if (yield* fileSystem.exists(workingDirectory)) return;
  yield* input.restore.pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(workingDirectory))) return yield* Effect.fail(cause);
        yield* Effect.logWarning(
          "A conversation-only rewind left part of its task folder unrestored",
          { workingDirectory, cause },
        );
      }),
    ),
  );
});
