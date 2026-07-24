// FILE: antigravityReleaseChannel.ts
// Purpose: Defines Antigravity's trusted stable manifest and artifact boundaries.
// Layer: Provider runtime infrastructure

import type { ProviderRuntimeTarget } from "./providerRuntimeTypes";

export const MINIMUM_ANTIGRAVITY_CLI_VERSION = "1.1.4";
export const ANTIGRAVITY_MANIFEST_HOST =
  "antigravity-cli-auto-updater-974169037036.us-central1.run.app";
export const ANTIGRAVITY_ARTIFACT_HOSTS = ["storage.googleapis.com"] as const;
const ANTIGRAVITY_ARTIFACT_PATH_PREFIX = "/antigravity-public/antigravity-cli/";

export function antigravityManifestPlatform(target: ProviderRuntimeTarget): string {
  const arch = target.arch === "arm64" ? "arm64" : "amd64";
  if (target.platform === "linux" && target.libc === "musl") return `linux_${arch}_musl`;
  const os = target.platform === "win32" ? "windows" : target.platform;
  return `${os}_${arch}`;
}

export function antigravityManifestUrl(target: ProviderRuntimeTarget): string {
  return `https://${ANTIGRAVITY_MANIFEST_HOST}/manifests/${antigravityManifestPlatform(target)}.json`;
}

export function validateAntigravityArtifactUrl(input: {
  readonly url: string;
  readonly version: string;
}): string {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error("Antigravity release manifest contains an invalid artifact URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !ANTIGRAVITY_ARTIFACT_HOSTS.includes(
      parsed.hostname as (typeof ANTIGRAVITY_ARTIFACT_HOSTS)[number],
    )
  ) {
    throw new Error("Antigravity release manifest uses an untrusted artifact host.");
  }
  const expectedVersionPrefix = `${ANTIGRAVITY_ARTIFACT_PATH_PREFIX}${input.version}-`;
  if (!parsed.pathname.startsWith(expectedVersionPrefix)) {
    throw new Error("Antigravity release manifest artifact URL does not match its version.");
  }
  return parsed.toString();
}
