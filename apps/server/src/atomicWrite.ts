import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

const WINDOWS_RENAME_RETRY_BUDGET_MS = 5_000;

function platformErrorCode(error: PlatformError.PlatformError): unknown {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

function windowsRenameRetryDelay(
  error: PlatformError.PlatformError,
  elapsedMs: number,
  attempt: number,
): number | undefined {
  if (
    elapsedMs >= WINDOWS_RENAME_RETRY_BUDGET_MS ||
    !["EPERM", "EACCES", "EBUSY"].includes(String(platformErrorCode(error)))
  )
    return undefined;
  return Math.min(25 * 2 ** Math.min(attempt, 5), 500, WINDOWS_RENAME_RETRY_BUDGET_MS - elapsedMs);
}

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number | undefined;
  /** Authored files need durability; regenerable caches should not flush every update. */
  readonly durable?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (input.durable)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(tempPath, { flag: "r+" });
            if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
            yield* file.sync;
          }),
        );
      else if (input.mode !== undefined) yield* fs.chmod(tempPath, input.mode);
      // Windows can temporarily deny replacement while another process has the
      // destination open. Keep the staged file private and retry only that
      // narrow class of errors; all other failures preserve fail-fast behavior.
      const started = yield* Clock.currentTimeMillis;
      let attempt = 0;
      for (;;) {
        const renamed = yield* Effect.result(fs.rename(tempPath, input.filePath));
        if (renamed._tag === "Success") break;
        const delay =
          platform === "win32"
            ? windowsRenameRetryDelay(
                renamed.failure,
                (yield* Clock.currentTimeMillis) - started,
                attempt++,
              )
            : undefined;
        if (delay === undefined) return yield* renamed.failure;
        yield* Effect.sleep(delay);
      }
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
    }),
  );
