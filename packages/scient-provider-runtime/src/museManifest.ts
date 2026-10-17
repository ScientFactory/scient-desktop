import type { ManagedRuntimeArtifactPolicy } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

export const MUSE_STABLE_CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
export const MUSE_DOWNLOAD_URL = "https://lookaside.facebook.com/lookaside/muse/download/";
export const MUSE_MINIMUM_VERSION = "1.4.6-R6000.1";
export const MUSE_TARGETS: ReadonlyArray<ManagedRuntimeTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

const ARTIFACT_NAMES = {
  "darwin-arm64": "muse-aarch64-macos",
  "darwin-x64": "muse-x86-macos",
  "linux-arm64": "muse-aarch64-linux",
  "linux-x64": "muse-x86-linux",
  "win32-arm64": "muse-aarch64-windows.exe",
  "win32-x64": "muse-x86-windows.exe",
} as const;

/** Policy does not make an unqualified release installable. The catalog supplies release facts. */
export function resolveMuseArtifactPolicy(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifactPolicy | undefined {
  if (target.platform === "linux" && target.libc !== "glibc") return undefined;
  const key = `${target.platform}-${target.arch}`;
  if (!(key in ARTIFACT_NAMES)) return undefined;
  return {
    provider: "muse",
    target,
    artifactName: ARTIFACT_NAMES[key as keyof typeof ARTIFACT_NAMES],
    allowedHosts: ["lookaside.facebook.com"],
    allowedUrlPathPrefixes: ["/lookaside/muse/download/"],
    releaseUrlTemplate: `${MUSE_DOWNLOAD_URL}?channel=muse&version={version}&file={artifact}`,
    checksum: { algorithm: "sha256" },
    minimumVersion: MUSE_MINIMUM_VERSION,
    archiveFormat: "raw",
    executablePath: target.platform === "win32" ? "muse.exe" : "muse",
    smokeArgs: ["--version"],
    smokeVersionFormat: "muse",
    smokeEnvironment: { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" },
    supportTier: "fully_assisted",
    supportMessage: "Scient can install a qualified Muse Code release privately.",
  };
}
