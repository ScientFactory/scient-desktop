import type { ManagedRuntimeTarget } from "./target.ts";

export type ManagedRuntimeArchiveFormat = "raw" | "tar.gz";
export type ManagedRuntimeSupportTier =
  | "fully_assisted"
  | "external_runtime_supported"
  | "manual_or_advanced_only"
  | "unsupported";

export interface ManagedRuntimeChecksum {
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
}

/**
 * One reviewed, immutable provider-runtime artifact.
 *
 * The catalog that creates this value is provider-specific. Download,
 * verification, staging, smoke testing, and atomic activation are shared.
 */
export interface ManagedRuntimeArtifact {
  readonly provider: "codex" | "claudeAgent" | "antigravity";
  readonly version: string;
  readonly target: ManagedRuntimeTarget;
  readonly artifactName: string;
  readonly url: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly checksum: ManagedRuntimeChecksum;
  readonly size: number;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly smokeArgs: ReadonlyArray<string>;
  readonly smokeEnvironment?: Readonly<Record<string, string>>;
  readonly catalogRevision: string;
  readonly supportTier: ManagedRuntimeSupportTier;
  readonly supportMessage: string;
}
