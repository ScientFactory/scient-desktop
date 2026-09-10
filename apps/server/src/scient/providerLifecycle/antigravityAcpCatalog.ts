import { ANTIGRAVITY_ACP_REGISTRY_VERSION } from "@scientfactory/provider-runtime";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "../../provider/antigravityRelease.ts";

export {
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  resolveAntigravityAcpCatalogAsset,
} from "@scientfactory/provider-runtime";

/** Retain T3's bundled verified release as the offline floor for Scient's catalog. */
export function bundledAntigravityAcpAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  const asset = resolveAntigravityReleaseAsset(platform, arch);
  return asset ? { ...asset, registryVersion: ANTIGRAVITY_ACP_REGISTRY_VERSION } : null;
}
