import { compareSemverVersions } from "@t3tools/shared/semver";

import {
  isSupportedManagedRuntimeStableVersion,
  type ManagedRuntimeArtifactPolicy,
} from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

export const SCIENT_AGENT_MINIMUM_VERSION = "0.1.0";
export const SCIENT_AGENT_MAXIMUM_VERSION_EXCLUSIVE = "1.0.0";

export function isSupportedScientAgentVersion(version: string): boolean {
  return (
    isSupportedManagedRuntimeStableVersion(version, SCIENT_AGENT_MINIMUM_VERSION) &&
    compareSemverVersions(version, SCIENT_AGENT_MAXIMUM_VERSION_EXCLUSIVE) < 0
  );
}

/**
 * The release binary for each platform, as ScientFactory/scient-agent's
 * release workflow names it. Linux builds link glibc; the desktop app, where
 * managed installation runs, needs glibc too, so musl has no entry.
 */
const ARTIFACTS = {
  "darwin-arm64": { artifactName: "scient-agent-darwin-arm64", executablePath: "scient-agent" },
  "darwin-x64": { artifactName: "scient-agent-darwin-x64", executablePath: "scient-agent" },
  "linux-arm64": { artifactName: "scient-agent-linux-arm64", executablePath: "scient-agent" },
  "linux-x64": { artifactName: "scient-agent-linux-x64", executablePath: "scient-agent" },
  "win32-arm64": {
    artifactName: "scient-agent-windows-arm64.exe",
    executablePath: "scient-agent.exe",
  },
  "win32-x64": { artifactName: "scient-agent-windows-x64.exe", executablePath: "scient-agent.exe" },
} as const satisfies Readonly<
  Record<string, { readonly artifactName: string; readonly executablePath: string }>
>;

/** Every target a Scient Agent release carries a binary for. A release covers all of them. */
export const SCIENT_AGENT_TARGETS: ReadonlyArray<ManagedRuntimeTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

/** Packaging policy only: an installable artifact requires a qualified published release. */
export function resolveScientAgentArtifactPolicy(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifactPolicy | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const { artifactName, executablePath } = ARTIFACTS[key];
  return {
    provider: "scient",
    target,
    artifactName,
    allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
    allowedUrlPathPrefixes: ["/ScientFactory/scient-agent/releases/download/"],
    releaseUrlPrefix: "https://github.com/ScientFactory/scient-agent/releases/download/v",
    checksum: { algorithm: "sha256" },
    minimumVersion: SCIENT_AGENT_MINIMUM_VERSION,
    maximumVersionExclusive: SCIENT_AGENT_MAXIMUM_VERSION_EXCLUSIVE,
    archiveFormat: "raw",
    executablePath,
    smokeArgs: ["--runtime-info"],
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install Scient Agent privately when a qualified release is available.",
  };
}
