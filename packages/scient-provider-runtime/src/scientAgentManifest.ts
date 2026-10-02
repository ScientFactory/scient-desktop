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

/** Packaging policy only: an installable artifact requires a qualified published release. */
export function resolveScientAgentArtifactPolicy(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifactPolicy | undefined {
  if (target.platform !== "darwin" || target.arch !== "arm64") return undefined;
  return {
    provider: "scient",
    target,
    artifactName: "scient-agent-darwin-arm64",
    allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
    allowedUrlPathPrefixes: ["/ScientFactory/scient-agent/releases/download/"],
    releaseUrlPrefix: "https://github.com/ScientFactory/scient-agent/releases/download/v",
    checksum: { algorithm: "sha256" },
    minimumVersion: SCIENT_AGENT_MINIMUM_VERSION,
    maximumVersionExclusive: SCIENT_AGENT_MAXIMUM_VERSION_EXCLUSIVE,
    archiveFormat: "raw",
    executablePath: "scient-agent",
    smokeArgs: ["--runtime-info"],
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install Scient Agent privately when a qualified release is available.",
  };
}
