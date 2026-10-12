import { ServerConfig } from "../../config.ts";
import {
  AntigravityInstallation,
  makeAntigravityInstallation,
} from "../../provider/AntigravityInstallation.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ManagedRuntimeCatalog } from "./ManagedRuntimeCatalog.ts";
import {
  bundledAntigravityAcpAsset,
  resolveAntigravityAcpCatalogAsset,
} from "./antigravityAcpCatalog.ts";

/** Compose Scient's qualified release source with T3's paired native installer. */
export const scientAntigravityInstallationLayer = Layer.effect(
  AntigravityInstallation,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const catalog = yield* ManagedRuntimeCatalog;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const resolve = (current: Parameters<typeof resolveAntigravityAcpCatalogAsset>[0]) =>
      resolveAntigravityAcpCatalogAsset(current, platform, arch) ??
      bundledAntigravityAcpAsset(platform, arch);
    return yield* makeAntigravityInstallation({
      baseDir: config.baseDir,
      refreshLatestRelease: catalog.refresh.pipe(Effect.map(resolve)),
      latestRelease: catalog.current.pipe(Effect.map(resolve)),
    });
  }),
);
