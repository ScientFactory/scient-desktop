import {
  windowsRuntimeFilesystemRetryDelay,
  type RuntimeFilesystemOperation,
} from "@scientfactory/provider-runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";

/** Filesystem operations scoped to installer-owned paths, never a global FS patch. */
export function makeInstallerFilesystem(fs: FileSystem.FileSystem, platform: string) {
  const retry = Effect.fn("InstallerFilesystem.retry")(function* (
    operation: RuntimeFilesystemOperation,
    action: Effect.Effect<void, PlatformError.PlatformError>,
    destination?: string,
  ) {
    const started = yield* Clock.currentTimeMillis;
    let attempt = 0;
    for (;;) {
      const result = yield* Effect.result(action);
      if (result._tag === "Success") return;
      const cause = result.failure.reason.cause;
      const delay =
        platform === "win32"
          ? windowsRuntimeFilesystemRetryDelay(
              Predicate.hasProperty(cause, "code") ? cause.code : undefined,
              operation,
              (yield* Clock.currentTimeMillis) - started,
              attempt++,
            )
          : undefined;
      if (delay === undefined) return yield* result.failure;
      yield* Effect.sleep(delay);
      if (destination !== undefined) {
        // stat follows links; readLink also catches a newly-created dangling link.
        const link = yield* Effect.result(fs.readLink(destination));
        if (link._tag === "Success") return yield* result.failure;
        const target = yield* Effect.result(fs.stat(destination));
        if (target._tag === "Success" || target.failure.reason._tag !== "NotFound") {
          return yield* result.failure;
        }
      }
    }
  });
  const remove = (path: string) =>
    retry("remove", fs.remove(path, { recursive: true, force: true }));
  return {
    rename: (from: string, to: string) => retry("rename", fs.rename(from, to), to),
    remove,
    makeTempDirectoryScoped: (
      options?: Parameters<FileSystem.FileSystem["makeTempDirectory"]>[0],
    ) =>
      platform !== "win32"
        ? fs.makeTempDirectoryScoped(options)
        : Effect.acquireRelease(fs.makeTempDirectory(options), (path) =>
            remove(path).pipe(Effect.orDie),
          ),
  };
}
