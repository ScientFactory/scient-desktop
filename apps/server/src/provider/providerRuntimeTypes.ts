import type { ProviderKind, ServerProviderInstallationState } from "@synara/contracts";

export type ProviderRuntimeArchiveFormat = "raw" | "tar.gz" | "zip";
export type ProviderRuntimePlatform = "darwin" | "linux" | "win32";
export type ProviderRuntimeArch = "arm64" | "x64";
export type ProviderRuntimeLibc = "glibc" | "musl";
export type ProviderRuntimeCpu = "standard" | "baseline";

export interface ProviderRuntimeTarget {
  readonly platform: ProviderRuntimePlatform;
  readonly arch: ProviderRuntimeArch;
  readonly libc?: ProviderRuntimeLibc;
  readonly cpu: ProviderRuntimeCpu;
}

export interface ProviderRuntimeArtifact {
  readonly provider: ProviderKind;
  readonly version: string;
  readonly target: ProviderRuntimeTarget;
  readonly url: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly digestAlgorithm: "sha256" | "sha512";
  readonly digest: string;
  readonly size?: number;
  readonly archiveFormat: ProviderRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly smokeArgs: ReadonlyArray<string>;
  readonly catalogRevision: string;
}

export interface ProviderRuntimeRecipe {
  readonly provider: ProviderKind;
  readonly bundled?: boolean;
  readonly executableName: string;
  readonly resolve: (
    target: ProviderRuntimeTarget,
    signal: AbortSignal,
  ) => Promise<ProviderRuntimeArtifact>;
}

export interface ProviderRuntimeCurrentRecord {
  readonly version: 1;
  readonly provider: ProviderKind;
  readonly releaseId: string;
  readonly previousReleaseId: string | null;
  readonly runtimeVersion: string;
  readonly executableRelativePath: string;
  readonly executablePath: string;
  readonly smokeArgs: ReadonlyArray<string>;
  readonly digestAlgorithm: ProviderRuntimeArtifact["digestAlgorithm"];
  readonly digest: string;
  readonly sourceUrl: string;
  readonly catalogRevision: string;
  readonly installedAt: string;
}

export interface ProviderRuntimeSnapshot {
  readonly provider: ProviderKind;
  readonly managedExecutablePath: string | null;
  readonly managedVersion: string | null;
  readonly previousReleaseAvailable: boolean;
  readonly bundled: boolean;
  readonly canInstall: boolean;
  readonly installationState: ServerProviderInstallationState | null;
}

export interface ProviderRuntimeInstallProgress {
  readonly status: ServerProviderInstallationState["status"];
  readonly message: string;
  readonly version?: string | null;
  readonly bytesDownloaded?: number;
  readonly totalBytes?: number | null;
}

export function providerRuntimeTargetId(target: ProviderRuntimeTarget): string {
  return [target.platform, target.arch, target.libc, target.cpu === "baseline" ? "baseline" : null]
    .filter((part): part is string => Boolean(part))
    .join("-");
}

export function providerRuntimeReleaseId(artifact: ProviderRuntimeArtifact): string {
  return `${artifact.version}-${providerRuntimeTargetId(artifact.target)}`;
}
