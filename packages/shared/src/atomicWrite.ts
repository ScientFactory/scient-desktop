import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

// SCIENT-FORK:START durable directory synchronization ignores only unsupported sync errors.
function platformErrorCode(error: PlatformError.PlatformError): unknown {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

// SCIENT-FORK:END

/** Windows open-file locks block renames; the same codes can mean permanent denial, so bound retries. */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// Bound denial delays to about two seconds because settings saves hold their write lock.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

/** Resolves symlink targets before renaming so writes preserve the link. */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  // SCIENT-FORK:START authored-file permissions and durability.
  readonly mode?: number | undefined;
  /** Authored files need durability; regenerable caches should not flush every update. */
  readonly durable?: boolean;
  // SCIENT-FORK:END
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Cleanup failure must not fail a write that already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: `${path.basename(targetPath)}.`,
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      // SCIENT-FORK:START authored files flush contents and permissions before publication.
      if (input.durable)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(tempPath, { flag: "r+" });
            if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
            yield* file.sync;
          }),
        );
      else if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
      // SCIENT-FORK:END
      // SCIENT-FORK: await replacement before syncing its directory.
      yield* Effect.gen(function* () {
        if (platform !== "win32") return yield* fs.rename(tempPath, targetPath);

        // Stop retrying if another save changes the target; read-only targets also return permanent EPERM.
        const targetVersion = fs.stat(targetPath).pipe(
          Effect.map((info) => ({
            id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
            readOnly: (info.mode & 0o200) === 0,
          })),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed({ id: "missing", readOnly: false }),
          ),
          Effect.option,
        );
        const before = yield* targetVersion;
        const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(firstAttempt)) return;
        const lockError = firstAttempt.failure;
        if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
          return yield* lockError;
        }
        for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
          yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
          const current = yield* targetVersion;
          if (Option.isNone(current) || current.value.id !== before.value.id) break;
          const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
          if (Result.isSuccess(attempt)) return;
          if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
        }
        return yield* lockError;
      });
      // SCIENT-FORK:START persist the published name after replacement.
      // Windows does not support opening directory handles through this API.
      // On POSIX, persist the rename as well as the temporary file's contents.
      if (input.durable && platform !== "win32") {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.open(targetDirectory, { flag: "r" });
            yield* directory.sync;
          }),
        ).pipe(
          Effect.catch((error) => {
            const code = platformErrorCode(error);
            return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
              ? Effect.void
              : Effect.fail(error);
          }),
        );
      }
      // SCIENT-FORK:END
    }),
  );
