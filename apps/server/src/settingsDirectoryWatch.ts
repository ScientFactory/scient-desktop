// @effect-diagnostics nodeBuiltinImport:off -- this Node adapter owns actual watch registration; FileSystem.watch exposes no acquisition-ready signal.
/** Scoped Node settings watches return only after native registration, before consuming events. */
import { watch } from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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
        const watcher = watch(directory, (_event, filename) => {
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
