/** Synthetic provider services using the application's fixture paths and attachment layout. */
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

export const layer = Layer.effect(
  ProviderHost,
  Effect.gen(function* () {
    const host = yield* ProviderHost;
    const config = yield* ServerConfig;
    return ProviderHost.of({
      ...host,
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    });
  }),
).pipe(Layer.provide(layerTestProviderHost()));
