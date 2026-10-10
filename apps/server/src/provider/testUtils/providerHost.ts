/**
 * Synthetic `ProviderHost` for app-owned driver tests.
 *
 * Its paths, settings, and background-work decisions come from the same test
 * services the server layer under test uses. Credentials are kept in memory.
 */
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";

export const layerConfigConsistentTestProviderHost = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const host = yield* ProviderHost.ProviderHost.pipe(
      Effect.provide(TestProviderHost.layer({ cwd: config.cwd })),
    );

    return ProviderHost.ProviderHost.of({
      ...host,
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
    });
  }),
);
