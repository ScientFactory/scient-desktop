/**
 * "Edit from here" on a task folder: a file rewind refuses a shared folder before rebuilding any
 * checkout. A conversation-only rewind leaves the task folder alone while the provider's folder is
 * there; when that folder is gone, the full restore rebuilds it and any failure blocks the rewind,
 * since the restore is what checks that the rebuilt folder is the thread's own checkout.
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
  if (workingDirectory !== null && (yield* fileSystem.exists(workingDirectory))) return;
  return yield* input.restore;
});
