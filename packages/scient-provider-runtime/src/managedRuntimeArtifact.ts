import { compareSemverVersions } from "@t3tools/shared/semver";

import type { ManagedRuntimeTarget } from "./target.ts";
import { managedRuntimeTargetKey } from "./target.ts";

export type ManagedRuntimeArchiveFormat = "raw" | "tar.gz" | "zip";
/** Distinct release families can belong to the same user-facing provider. */
export const MANAGED_RUNTIME_CATALOG_PROVIDERS = [
  "codex",
  "claudeAgent",
  "antigravity",
  "antigravityAcp",
  "cursor",
  "droid",
  "grok",
  "pi",
  "omp",
  "scient",
] as const;
export type ManagedRuntimeCatalogProvider = (typeof MANAGED_RUNTIME_CATALOG_PROVIDERS)[number];
export type ManagedRuntimeProvider = Exclude<ManagedRuntimeCatalogProvider, "antigravityAcp">;
export type ManagedRuntimeSupportTier =
  | "fully_assisted"
  | "external_runtime_supported"
  | "manual_or_advanced_only"
  | "unsupported";

export interface ManagedRuntimeChecksum {
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
}

export interface ManagedRuntimeExtractionLimits {
  readonly maxEntries: number;
  readonly maxExpandedBytes: number;
}

/**
 * App-owned packaging and execution policy, independent of release availability.
 * A family can have policy before it has a published artifact; release facts
 * are supplied only by a qualified catalog entry or an active-install receipt.
 */
export interface ManagedRuntimeArtifactPolicy {
  readonly provider: ManagedRuntimeProvider;
  readonly target: ManagedRuntimeTarget;
  readonly artifactName: string;
  readonly allowedHosts: ReadonlyArray<string>;
  /** App-owned path families accepted from release catalogs on approved hosts. */
  readonly allowedUrlPathPrefixes: ReadonlyArray<string>;
  readonly checksum: Pick<ManagedRuntimeChecksum, "algorithm">;
  /** When present, only stable semver releases at or above this floor are supported. */
  readonly minimumVersion?: string;
  /** First incompatible product version; major expansion requires app qualification. */
  readonly maximumVersionExclusive?: string;
  /** Exact release URL prefix immediately before the version; fixes asset and tag identity. */
  readonly releaseUrlPrefix?: string;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  /** Reviewed archive-specific limits; omitted for small single-binary releases. */
  readonly extractionLimits?: ManagedRuntimeExtractionLimits | undefined;
  readonly executablePath: string;
  /** Additional reviewed payload files that must exist and be executable. */
  readonly auxiliaryExecutablePaths?: ReadonlyArray<string> | undefined;
  /** Optional alternate smoke-test entry point inside the extracted payload. */
  readonly smokeExecutablePath?: string | undefined;
  /** Optional payload-relative working directory for the smoke test. */
  readonly smokeWorkingDirectory?: string | undefined;
  readonly smokeArgs: ReadonlyArray<string>;
  readonly smokeEnvironment?: Readonly<Record<string, string>>;
  readonly supportTier: ManagedRuntimeSupportTier;
  readonly supportMessage: string;
}

/** Packaging policy plus immutable facts from a real, qualified release. */
export interface ManagedRuntimeArtifact extends ManagedRuntimeArtifactPolicy {
  readonly version: string;
  readonly url: string;
  readonly checksum: ManagedRuntimeChecksum;
  readonly size: number;
  readonly catalogRevision: string;
}

/** A source-owned minimum version also limits the family to stable semver releases. */
export function isSupportedManagedRuntimeStableVersion(
  version: string,
  minimumVersion: string,
): boolean {
  return (
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) &&
    compareSemverVersions(version, minimumVersion) >= 0
  );
}

/**
 * Durable release identity for an artifact that Scient actually activated.
 *
 * Packaging and execution policy deliberately stay in the installed app. The
 * receipt records only the immutable release facts needed to repair the exact
 * active version after a remote catalog moves on.
 */
export interface ManagedRuntimeArtifactReceipt {
  readonly provider: ManagedRuntimeProvider;
  readonly version: string;
  readonly target: ManagedRuntimeTarget;
  readonly artifactName: string;
  readonly url: string;
  readonly checksum: ManagedRuntimeChecksum;
  readonly size: number;
  readonly catalogRevision: string;
}

export function managedRuntimeArtifactReceipt(
  artifact: ManagedRuntimeArtifact,
): ManagedRuntimeArtifactReceipt {
  return {
    provider: artifact.provider,
    version: artifact.version,
    target: artifact.target,
    artifactName: artifact.artifactName,
    url: artifact.url,
    checksum: artifact.checksum,
    size: artifact.size,
    catalogRevision: artifact.catalogRevision,
  };
}

/**
 * Applies immutable release facts to an app-owned packaging policy.
 *
 * Remote catalog data can select a release, but it cannot add targets, hosts,
 * checksum algorithms, extraction behavior, executable paths, smoke commands,
 * environment access, or support tiers that this Scient build did not ship.
 */
export function hydrateManagedRuntimeArtifact(
  policy: ManagedRuntimeArtifactPolicy,
  receipt: ManagedRuntimeArtifactReceipt,
): ManagedRuntimeArtifact | undefined {
  if (
    (policy.minimumVersion !== undefined &&
      !isSupportedManagedRuntimeStableVersion(receipt.version, policy.minimumVersion)) ||
    (policy.maximumVersionExclusive !== undefined &&
      compareSemverVersions(receipt.version, policy.maximumVersionExclusive) >= 0) ||
    (policy.releaseUrlPrefix !== undefined &&
      (receipt.artifactName !== policy.artifactName ||
        receipt.url !== `${policy.releaseUrlPrefix}${receipt.version}/${policy.artifactName}`)) ||
    receipt.provider !== policy.provider ||
    managedRuntimeTargetKey(receipt.target) !== managedRuntimeTargetKey(policy.target) ||
    receipt.checksum.algorithm !== policy.checksum.algorithm ||
    receipt.version.length === 0 ||
    receipt.version.length > 128 ||
    receipt.version === "." ||
    receipt.version === ".." ||
    /[\\/]/u.test(receipt.version) ||
    receipt.catalogRevision.length === 0 ||
    receipt.catalogRevision.length > 512 ||
    receipt.artifactName.length === 0 ||
    receipt.artifactName.length > 512 ||
    receipt.artifactName === "." ||
    receipt.artifactName === ".." ||
    /[\\/]/u.test(receipt.artifactName) ||
    receipt.url.length > 2_048 ||
    !URL.canParse(receipt.url)
  ) {
    return undefined;
  }
  const url = new URL(receipt.url);
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !policy.allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase()) ||
    !policy.allowedUrlPathPrefixes.some(
      (prefix) => prefix.startsWith("/") && prefix.endsWith("/") && url.pathname.startsWith(prefix),
    )
  ) {
    return undefined;
  }
  const expectedDigestLength = receipt.checksum.algorithm === "sha256" ? 64 : 128;
  if (
    receipt.size <= 0 ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.checksum.digest.length !== expectedDigestLength ||
    !/^[0-9a-f]+$/u.test(receipt.checksum.digest)
  ) {
    return undefined;
  }
  return {
    ...policy,
    version: receipt.version,
    artifactName: receipt.artifactName,
    url: receipt.url,
    checksum: receipt.checksum,
    size: receipt.size,
    catalogRevision: receipt.catalogRevision,
  };
}
