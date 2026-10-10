// @effect-diagnostics nodeBuiltinImport:off -- this Node adapter owns actual watch registration; FileSystem.watch exposes no acquisition signal; native callbacks are only best-effort hints.
/** Scoped settings watch hints plus one-path metadata reads; no native OS-ready guarantee. */
import * as NodeFS from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// SCIENT-FORK:START — settings-only native hints and precise metadata fallback boundary.
const watchError = (directory: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "watch",
    pathOrDescriptor: directory,
    cause,
  });

const acquireNative = Effect.fnUntraced(function* (directory: string) {
  const events = yield* Queue.make<string, PlatformError.PlatformError | Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.shutdown(events));
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const watcher = NodeFS.watch(directory, (_event, filename) => {
          if (filename !== null) Queue.offerUnsafe(events, filename);
        });
        watcher.on("error", (cause) =>
          Queue.failCauseUnsafe(events, Cause.fail(watchError(directory, cause))),
        );
        watcher.on("close", () => Queue.endUnsafe(events));
        return watcher;
      },
      catch: (cause) => watchError(directory, cause),
    }),
    (watcher) => Effect.sync(() => watcher.close()),
  );
  return Stream.fromQueue(events);
});

/** A replaceable acquisition boundary lets tests hold registration without sleeps or fake readiness. */
export const SettingsDirectoryWatch = Context.Reference<{
  readonly acquire: (
    directory: string,
  ) => Effect.Effect<
    Stream.Stream<string, PlatformError.PlatformError>,
    PlatformError.PlatformError,
    Scope.Scope
  >;
}>("scient/serverSettings/SettingsDirectoryWatch", {
  defaultValue: () => ({ acquire: acquireNative }),
});

const isMissing = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const statFingerprint = (stat: NodeFS.BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

const readFingerprint = (filePath: string) =>
  Effect.tryPromise({
    try: async () => {
      const link = await NodeFS.promises
        .lstat(filePath, { bigint: true })
        .catch((cause: unknown) => {
          if (isMissing(cause)) return null;
          throw cause;
        });
      if (link === null) return "missing";
      const target = link.isSymbolicLink()
        ? await NodeFS.promises.stat(filePath, { bigint: true }).catch((cause: unknown) => {
            if (isMissing(cause)) return null;
            throw cause;
          })
        : link;
      return `${statFingerprint(link)}|${target === null ? "missing" : statFingerprint(target)}`;
    },
    catch: (cause) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor: filePath,
        cause,
      }),
  });

/** Only the authoritative settings path is sampled; unchanged metadata never reads file contents. */
export const SettingsFileMetadata = Context.Reference<{
  readonly readFingerprint: (
    filePath: string,
  ) => Effect.Effect<string, PlatformError.PlatformError>;
}>("scient/serverSettings/SettingsFileMetadata", {
  defaultValue: () => ({ readFingerprint }),
});
/** Capture the baseline before startup reads; one scoped stream owns the four-per-second cadence. */
export const acquireSettingsMetadataChanges = Effect.fnUntraced(function* (
  filePath: string,
  read: (filePath: string) => Effect.Effect<string, PlatformError.PlatformError>,
) {
  let readFailed = false;
  const readSafely = read(filePath).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        readFailed = false;
      }),
    ),
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (!readFailed) yield* Effect.logError(error);
        readFailed = true;
        return Option.none<string>();
      }),
    ),
  );
  let previousFingerprint = Option.getOrUndefined(yield* readSafely);
  return Stream.fromEffectRepeat(
    Effect.sleep(Duration.millis(250)).pipe(
      Effect.andThen(readSafely),
      Effect.map((fingerprint) => {
        if (Option.isNone(fingerprint)) return Option.none<string>();
        const changed = fingerprint.value !== previousFingerprint;
        previousFingerprint = fingerprint.value;
        return changed ? Option.some(filePath) : Option.none<string>();
      }),
    ),
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map((event) => event.value),
  );
});
// SCIENT-FORK:END
