import { compareManagedRuntimeVersions } from "./managedRuntimeVersion.ts";

interface AntigravityAcpCatalogData {
  readonly providers: Readonly<
    Record<
      string,
      | {
          readonly contractRevision: number;
          readonly channel: string;
          readonly version: string;
          readonly artifacts: Readonly<
            Record<
              string,
              {
                readonly artifactName: string;
                readonly url: string;
                readonly checksum: { readonly algorithm: string; readonly digest: string };
                readonly size: number;
                readonly antigravityAcp?: {
                  readonly version: string;
                  readonly executableBytes: number;
                  readonly harnessBytes: number;
                };
              }
            >
          >;
        }
      | undefined
    >
  >;
}

export interface AntigravityAcpCatalogAsset {
  readonly version: string;
  readonly registryVersion: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
}

export const ANTIGRAVITY_ACP_REGISTRY_VERSION = "1.0.0";
export const ANTIGRAVITY_ACP_CATALOG_KEY = "antigravityAcp";
export const ANTIGRAVITY_ACP_TARGETS = [
  {
    platform: "darwin",
    arch: "arm64",
    registryKey: "darwin-aarch64",
    directory: "macos",
    archiveSuffix: "darwin-arm64",
  },
  {
    platform: "linux",
    arch: "x64",
    registryKey: "linux-x86_64",
    directory: "linux",
    archiveSuffix: "linux-x86_64",
  },
  {
    platform: "linux",
    arch: "arm64",
    registryKey: "linux-aarch64",
    directory: "linux",
    archiveSuffix: "linux-arm64",
  },
  {
    platform: "win32",
    arch: "x64",
    registryKey: "windows-x86_64",
    directory: "windows",
    archiveSuffix: "windows-x86_64",
  },
  {
    platform: "win32",
    arch: "arm64",
    registryKey: "windows-aarch64",
    directory: "windows",
    archiveSuffix: "windows-arm64",
  },
] as const;

const isBoundedSize = (size: number) =>
  Number.isSafeInteger(size) && size > 0 && size <= 4 * 1024 ** 3;

export function antigravityAcpExecutableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

/** Hydrate data-only release facts; the feed cannot add hosts, targets, members or launch flags. */
export function resolveAntigravityAcpCatalogAsset(
  catalog: AntigravityAcpCatalogData,
  platform: NodeJS.Platform,
  arch: string,
): AntigravityAcpCatalogAsset | undefined {
  const names = antigravityAcpExecutableNames(platform);
  const target = ANTIGRAVITY_ACP_TARGETS.find(
    (value) => value.platform === platform && value.arch === arch,
  );
  const release = catalog.providers[ANTIGRAVITY_ACP_CATALOG_KEY];
  const artifact = release?.artifacts[`${platform}-${arch}`];
  const payload = artifact?.antigravityAcp;
  if (
    !target ||
    !release ||
    !artifact ||
    !payload ||
    release.contractRevision !== 1 ||
    release.channel !== "stable" ||
    !["equal", "newer"].includes(
      compareManagedRuntimeVersions({
        provider: ANTIGRAVITY_ACP_CATALOG_KEY,
        current: ANTIGRAVITY_ACP_REGISTRY_VERSION,
        candidate: release.version,
      }),
    ) ||
    !/^agy_acp_server_[A-Za-z0-9_.-]{1,96}$/u.test(payload.version) ||
    artifact.checksum.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/u.test(artifact.checksum.digest) ||
    !isBoundedSize(artifact.size) ||
    !isBoundedSize(payload.executableBytes) ||
    !isBoundedSize(payload.harnessBytes)
  )
    return undefined;
  const artifactName = `agy-acp-server-${payload.version}-${target.archiveSuffix}.zip`;
  const expectedUrl = `https://dl.google.com/agy-extensions/releases/${target.directory}/${artifactName}`;
  if (artifact.url !== expectedUrl || artifact.artifactName !== artifactName) return undefined;
  return {
    version: payload.version,
    registryVersion: release.version,
    url: artifact.url,
    sha256: artifact.checksum.digest,
    archiveBytes: artifact.size,
    executable: { name: names.executable, bytes: payload.executableBytes },
    harness: { name: names.harness, bytes: payload.harnessBytes },
  };
}
