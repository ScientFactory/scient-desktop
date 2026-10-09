/**
 * Synthetic `ProviderHost` for app-owned driver tests.
 *
 * Its paths, settings, and background-work decisions come from the same test
 * services the server layer under test uses. Credentials are kept in memory.
 */
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";

export const layerConfigConsistentTestProviderHost = Layer.effect(
  ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const credentials = new Map<string, Uint8Array>();
    const owner = "t3";

    return ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: settings.getSettings,
        withSnapshot: settings.withSettingsSnapshot,
        changes: settings.streamChanges,
        subscribe: settings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      credentials: (namespace, bindingId) =>
        Effect.sync(() => {
          const key = `${namespace}:${bindingId}`;
          return {
            binding: { owner, key },
            get: Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
            set: (value: Uint8Array) => Effect.sync(() => void credentials.set(key, value)),
            remove: Effect.sync(() => void credentials.delete(key)),
          };
        }),
    });
  }),
);
