import {
  compareProviderDriverKinds,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSchema),
);

const CLAUDE_AGENT_DRIVER = "claudeAgent";

/**
 * Runtime operations and initial probe placeholders are owned by the current
 * server process. Persisting them can resurrect work that no longer exists
 * after a restart, leaving clients permanently stuck in a transient state.
 */
const withoutTransientProviderState = (provider: ServerProvider): ServerProvider => {
  const {
    probePending: _probePending,
    updateState: _updateState,
    ...providerWithoutTransientState
  } = provider;
  const connection = providerWithoutTransientState.connection;
  if (!connection) return providerWithoutTransientState;

  return {
    ...providerWithoutTransientState,
    connection: {
      ...connection,
      operation: null,
      ...(connection.runtime
        ? {
            runtime: {
              ...connection.runtime,
              operation: null,
            },
          }
        : {}),
    },
  };
};

const mergeProviderModels = (
  provider: ServerProvider,
  fallbackModels: ReadonlyArray<ServerProvider["models"][number]>,
  cachedModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  // Claude's fallback is built from T3's curated catalog plus the current
  // settings-defined custom models. Cached additions are not authoritative and
  // may contain moving SDK aliases such as `default`, `sonnet`, or `haiku`.
  if (provider.driver === CLAUDE_AGENT_DRIVER) {
    return fallbackModels;
  }

  const fallbackSlugs = new Set(fallbackModels.map((model) => model.slug));
  // The fallback snapshot is built from current settings and already carries
  // every custom model, so cached custom rows that are not in it were removed
  // while the cache was stale and must not come back.
  return [
    ...fallbackModels,
    ...cachedModels.filter((model) => !model.isCustom && !fallbackSlugs.has(model.slug)),
  ];
};

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted((left, right) => {
    const driverOrder = compareProviderDriverKinds(left.driver, right.driver);
    if (driverOrder !== 0) return driverOrder;

    const leftIsDefault = left.instanceId === defaultInstanceIdForDriver(left.driver);
    const rightIsDefault = right.instanceId === defaultInstanceIdForDriver(right.driver);
    if (leftIsDefault !== rightIsDefault) return leftIsDefault ? -1 : 1;

    // Stable sorting preserves user-authored order among custom instances.
    return 0;
  });

export const isCachedProviderCorrelated = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): boolean =>
  input.cachedProvider.instanceId === input.fallbackProvider.instanceId &&
  input.cachedProvider.driver === input.fallbackProvider.driver;

export const hydrateCachedProvider = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): ServerProvider => {
  if (!isCachedProviderCorrelated(input)) {
    return input.fallbackProvider;
  }

  if (
    !input.fallbackProvider.enabled ||
    input.cachedProvider.enabled !== input.fallbackProvider.enabled
  ) {
    return input.fallbackProvider;
  }

  const {
    message: _fallbackMessage,
    probePending: _fallbackProbePending,
    ...fallbackWithoutTransientState
  } = input.fallbackProvider;
  const hydratedProvider: ServerProvider = {
    ...fallbackWithoutTransientState,
    models: mergeProviderModels(
      input.fallbackProvider,
      input.fallbackProvider.models,
      input.cachedProvider.models,
    ),
    installed: input.cachedProvider.installed,
    version: input.cachedProvider.version,
    status: input.cachedProvider.status,
    auth: input.cachedProvider.auth,
    checkedAt: input.cachedProvider.checkedAt,
    slashCommands: input.cachedProvider.slashCommands,
    skills: input.cachedProvider.skills,
  };

  return input.cachedProvider.message
    ? { ...hydratedProvider, message: input.cachedProvider.message }
    : hydratedProvider;
};

/**
 * Resolve the on-disk cache path for a provider instance snapshot.
 *
 * File naming: `<cacheDir>/<instanceId>.json`. For the default instance of
 * a built-in kind this equals the legacy `<kind>.json` path (because
 * `defaultInstanceIdForDriver(kind).toString() === kind`), so existing
 * cached snapshots remain readable without any rename step.
 *
 * Non-default instances (e.g. `codex_personal`) land in their own files and
 * never collide with other instances.
 *
 * Cache contents must still carry matching `instanceId` + `driver` identity
 * before hydration. The filename alone is not trusted as a routing key.
 */
export const resolveProviderStatusCachePath = Effect.fn("resolveProviderStatusCachePath")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, `${input.instanceId}.json`);
  },
);

export const readProviderStatusCache = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    return yield* decodeProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider status cache, ignoring", {
            path: filePath,
            errorTag: causeErrorTag(cause),
          }).pipe(Effect.as(undefined)),
        // Older builds could persist in-flight lifecycle operations. Never
        // hydrate those process-local states into a new server process.
        onSuccess: (provider) => Effect.succeed(withoutTransientProviderState(provider)),
      }),
    );
  });

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
}) => {
  const durableProvider = withoutTransientProviderState(input.provider);
  return writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(durableProvider, null, 2)}\n`,
  });
};
