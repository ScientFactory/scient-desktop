import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";

/**
 * Pi session files admit only one native writer, including during startup.
 * The process scope releases its leases after native teardown completes.
 */
export const makePiSessionFileLeases = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) => {
  const { fileSystem, path } = input;
  const piFileLeases = new Map<string, Scope.Closeable>();
  const closedLeaseScopes = new WeakSet<Scope.Closeable>();
  const failedLeaseScopes = new WeakSet<Scope.Closeable>();
  const closeOwnedScope = (scope: Scope.Closeable) =>
    Effect.suspend(() => {
      closedLeaseScopes.add(scope);
      if (failedLeaseScopes.has(scope))
        return Effect.die(
          "The native process scope previously failed to close; its Pi file leases remain held.",
        );
      return Scope.close(scope, Exit.void).pipe(
        Effect.onError(() => Effect.sync(() => failedLeaseScopes.add(scope))),
        Effect.andThen(
          Effect.sync(() => {
            for (const [file, owner] of piFileLeases)
              if (owner === scope) piFileLeases.delete(file);
          }),
        ),
      );
    });
  const claimPiFile = (
    scope: Scope.Closeable,
    driver: ProviderAdapterV2SessionRuntime["driver"],
    nativeId?: string | null,
  ) =>
    driver !== "pi" || nativeId == null
      ? Effect.void
      : fileSystem.realPath(nativeId).pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(path.resolve(nativeId))
              : Effect.fail(
                  new ProviderAdapterProtocolError({
                    driver,
                    detail: "Cannot resolve the native Pi session file.",
                    payload: cause,
                  }),
                ),
          ),
          Effect.flatMap((file) =>
            Effect.suspend(() => {
              if (
                closedLeaseScopes.has(scope) ||
                (piFileLeases.has(file) && piFileLeases.get(file) !== scope)
              )
                return new ProviderAdapterProtocolError({
                  driver,
                  detail:
                    "The native Pi session file already has a live writer, or this writer has closed.",
                });
              piFileLeases.set(file, scope);
              return Effect.void;
            }),
          ),
        );
  return { closeOwnedScope, claimPiFile };
};
