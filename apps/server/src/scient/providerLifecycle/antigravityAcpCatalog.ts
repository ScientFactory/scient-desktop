import {
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  ANTIGRAVITY_ACP_TARGETS,
  compareManagedRuntimeVersions,
  MANAGED_RUNTIME_POLICY,
  resolveReviewedAntigravityArtifact,
} from "@scientfactory/provider-runtime";
import {
  parseAntigravityCliRelease,
  type AntigravityCliReleaseAsset,
} from "../../provider/antigravityCliRelease.ts";
import { type AntigravityReleaseAsset } from "../../provider/antigravityRelease.ts";
import {
  resolveManagedRuntimeCatalogArtifact,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";

export {
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  resolveAntigravityAcpCatalogAsset,
} from "@scientfactory/provider-runtime";

// T3 dropped its pinned ACP release when it moved to the native CLI; Scient keeps it as
// the offline floor of its qualified catalog. Hashes and sizes match the official ACP registry
// release. Like 1.4.2 through 1.4.4, it writes a run-workflow skill into the workspace unless the
// tool is disabled (antigravitySessionMeta).
export const ANTIGRAVITY_RELEASE_VERSION = "1.4.5";

const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
      sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
      archiveBytes: 97_923_855,
      executable: { name: "agy_acp_server.par", bytes: 178_915_920 },
      harness: { name: "localharness_external", bytes: 122_957_936 },
    },
  ],
  [
    "darwin-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
      sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
      archiveBytes: 103_577_295,
      executable: { name: "agy_acp_server.par", bytes: 183_127_600 },
      harness: { name: "localharness_external", bytes: 127_612_208 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
      sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
      archiveBytes: 321_783_181,
      executable: { name: "agy_acp_server.par", bytes: 826_226_766 },
      harness: { name: "localharness_external", bytes: 133_926_136 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
      sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
      archiveBytes: 307_829_008,
      executable: { name: "agy_acp_server.par", bytes: 831_194_025 },
      harness: { name: "localharness_external", bytes: 127_512_832 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
      sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
      archiveBytes: 100_423_655,
      executable: { name: "agy_acp_server.exe", bytes: 55_839_864 },
      harness: { name: "localharness_external.exe", bytes: 147_843_736 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
      sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
      archiveBytes: 102_703_121,
      executable: { name: "agy_acp_server.exe", bytes: 62_293_488 },
      harness: { name: "localharness_external.exe", bytes: 139_322_008 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}

/** Retain T3's bundled verified release as the offline floor for Scient's catalog. */
export function bundledAntigravityAcpAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  if (
    !ANTIGRAVITY_ACP_TARGETS.some((target) => target.platform === platform && target.arch === arch)
  )
    return null;
  const asset = resolveAntigravityReleaseAsset(platform, arch);
  return asset ? { ...asset, registryVersion: ANTIGRAVITY_ACP_REGISTRY_VERSION } : null;
}

// The first agy CLI qualified with Scient's ACP launch (profile flags, sign-in, plugins).
// Earlier catalog CLIs, including the bundled 1.1.x floor, cannot serve ACP.
const ANTIGRAVITY_CLI_ACP_MINIMUM_VERSION = "1.5.12";

export interface AntigravityCliCatalogAsset extends AntigravityCliReleaseAsset {
  readonly archiveBytes: number;
}

/** The catalog's agy CLI for an ACP target, when it is new enough to serve ACP. */
export function resolveAntigravityCliCatalogAsset(
  catalog: ManagedRuntimeCatalogData,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliCatalogAsset | undefined {
  const acpTarget = ANTIGRAVITY_ACP_TARGETS.find(
    (target) => target.platform === platform && target.arch === arch,
  );
  if (!acpTarget) return undefined;
  const policy = resolveReviewedAntigravityArtifact({
    platform: acpTarget.platform,
    arch: acpTarget.arch,
    ...(acpTarget.platform === "linux" ? { libc: musl ? "musl" : "glibc" } : {}),
  });
  const artifact = policy
    ? resolveManagedRuntimeCatalogArtifact({
        catalog,
        policy,
        contractRevision: MANAGED_RUNTIME_POLICY.antigravity.revision,
      })
    : undefined;
  if (
    !artifact ||
    artifact.checksum.algorithm !== "sha512" ||
    !["equal", "newer"].includes(
      compareManagedRuntimeVersions({
        provider: "antigravity",
        current: ANTIGRAVITY_CLI_ACP_MINIMUM_VERSION,
        candidate: artifact.version,
      }),
    )
  )
    return undefined;
  const release = parseAntigravityCliRelease(
    { version: artifact.version, url: artifact.url, sha512: artifact.checksum.digest },
    platform,
    arch,
    musl,
  );
  return release ? { ...release, archiveBytes: artifact.size } : undefined;
}
