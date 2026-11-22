import { isManagedRuntimeUpdate } from "@scientfactory/provider-runtime";

import type { AntigravityCliReleaseAsset } from "../../provider/antigravityCliRelease.ts";
import type { AntigravityReleaseAsset } from "../../provider/antigravityRelease.ts";

/** A managed Antigravity release: the paired ACP server, or the agy CLI that serves ACP itself. */
export type AntigravityManagedRelease = AntigravityReleaseAsset | AntigravityCliReleaseAsset;

export interface AntigravityReleaseIdentity {
  readonly cli: boolean;
  readonly version: string | null;
  readonly registryVersion?: string | undefined;
}

function isAntigravityCliRelease(
  release: AntigravityManagedRelease,
): release is AntigravityCliReleaseAsset {
  return "sha512" in release;
}

export function antigravityReleaseIdentity(
  release: AntigravityManagedRelease,
): AntigravityReleaseIdentity {
  return isAntigravityCliRelease(release)
    ? { cli: true, version: release.version }
    : { cli: false, version: release.version, registryVersion: release.registryVersion };
}

/** The installer's release directory name: CLI releases use a SHA-512 prefix. */
export function antigravityReleaseId(release: AntigravityManagedRelease): string {
  return isAntigravityCliRelease(release) ? release.sha512.slice(0, 64) : release.sha256;
}

/** Plan identity: a different archive under the same version label is a different plan. */
export function antigravityReleaseRevision(release: AntigravityManagedRelease): string {
  return isAntigravityCliRelease(release)
    ? `antigravity-cli:${release.version}:${release.sha512}`
    : `antigravity-acp:${release.version}:${release.sha256}`;
}

export function antigravityReleaseDownloadBytes(release: AntigravityManagedRelease): number | null {
  const bytes = "archiveBytes" in release ? release.archiveBytes : undefined;
  return typeof bytes === "number" ? bytes : null;
}

/**
 * Whether `candidate` replaces `current` as the managed default. The agy CLI loads full
 * Antigravity plugins, so it supersedes every paired release; within one family the newer
 * release does. Unknown versions never count as newer.
 */
export function supersedesAntigravityRelease(
  current: AntigravityReleaseIdentity,
  candidate: AntigravityReleaseIdentity,
): boolean {
  if (current.cli !== candidate.cli) return candidate.cli;
  if (candidate.cli) {
    return (
      candidate.version !== null &&
      isManagedRuntimeUpdate({
        provider: "antigravity",
        current: current.version,
        candidate: candidate.version,
      })
    );
  }
  return (
    candidate.registryVersion !== undefined &&
    isManagedRuntimeUpdate({
      provider: "antigravityAcp",
      current: current.registryVersion ?? null,
      candidate: candidate.registryVersion,
    })
  );
}
