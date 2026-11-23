import { ServerConfig } from "../../config.ts";
import {
  AntigravityInstallation,
  makeAntigravityInstallation,
} from "../../provider/AntigravityInstallation.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ManagedRuntimeCatalog, type ManagedRuntimeCatalogData } from "./ManagedRuntimeCatalog.ts";
import {
  bundledAntigravityAcpAsset,
  resolveAntigravityAcpCatalogAsset,
  resolveAntigravityCliCatalogAsset,
} from "./antigravityAcpCatalog.ts";

/**
 * The managed default is the catalog's agy CLI, which loads full Antigravity plugins; the
 * paired release stays the floor where no qualified CLI is listed for this computer.
 */
export function selectAntigravityManagedRelease(
  catalog: ManagedRuntimeCatalogData,
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
) {
  return (
    resolveAntigravityCliCatalogAsset(catalog, platform, arch, musl) ??
    resolveAntigravityAcpCatalogAsset(catalog, platform, arch) ??
    bundledAntigravityAcpAsset(platform, arch)
  );
}

/** Compose Scient's qualified release source with T3's native installer. */
export const scientAntigravityInstallationLayer = Layer.effect(
  AntigravityInstallation,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const catalog = yield* ManagedRuntimeCatalog;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    // As T3's CLI channel does: Google publishes separate musl builds.
    const musl =
      platform === "linux" &&
      (yield* fs
        .exists(arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1")
        .pipe(Effect.orElseSucceed(() => false)));
    const resolve = (current: ManagedRuntimeCatalogData) =>
      selectAntigravityManagedRelease(current, platform, arch, musl);
    return yield* makeAntigravityInstallation({
      baseDir: config.baseDir,
      refreshLatestRelease: catalog.refresh.pipe(Effect.map(resolve)),
      latestRelease: catalog.current.pipe(Effect.map(resolve)),
    });
  }),
);
