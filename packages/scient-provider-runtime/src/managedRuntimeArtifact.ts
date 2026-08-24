import type { ManagedRuntimeTarget } from "./target.ts";

export type ManagedRuntimeArchiveFormat = "raw" | "tar.gz" | "zip";
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
 * One reviewed, immutable provider-runtime artifact.
 *
 * The catalog that creates this value is provider-specific. Download,
 * verification, staging, smoke testing, and atomic activation are shared.
 */
export interface ManagedRuntimeArtifact {
  readonly provider: "codex" | "claudeAgent" | "antigravity" | "cursor" | "droid" | "grok";
  readonly version: string;
  readonly target: ManagedRuntimeTarget;
  readonly artifactName: string;
  readonly url: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly checksum: ManagedRuntimeChecksum;
  readonly size: number;
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
  readonly catalogRevision: string;
  readonly supportTier: ManagedRuntimeSupportTier;
  readonly supportMessage: string;
}
