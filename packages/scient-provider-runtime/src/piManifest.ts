import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "0.85.1";
const RELEASE_BASE = `https://github.com/earendil-works/pi/releases/download/v${VERSION}`;
const ALLOWED_HOSTS = ["github.com", "release-assets.githubusercontent.com"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/earendil-works/pi/releases/download/"] as const;

interface ArtifactRecord {
  readonly artifactName: string;
  readonly sha256: string;
  readonly size: number;
  readonly archiveFormat: "tar.gz" | "zip";
  readonly executablePath: string;
}

/** Official Pi standalone releases use baseline builds for both x64 targets. */
const ARTIFACTS = {
  "darwin-arm64": {
    artifactName: "pi-darwin-arm64.tar.gz",
    sha256: "d5f70e3c0cf7398eac239fd0261ee074d98b7ba7f6b43fe3617f052ed5b79d06",
    size: 31_035_676,
    archiveFormat: "tar.gz",
    executablePath: "pi/pi",
  },
  "darwin-x64": {
    artifactName: "pi-darwin-x64.tar.gz",
    sha256: "adb918b845625f184d8bea408d55eacaf21aa87238793c0f5b4f3b9737bce62b",
    size: 33_544_584,
    archiveFormat: "tar.gz",
    executablePath: "pi/pi",
  },
  "linux-arm64": {
    artifactName: "pi-linux-arm64.tar.gz",
    sha256: "042d20ae885ee4f3b102815f3280b962c377b2e9fb44de4037908cc530eae4d4",
    size: 42_628_180,
    archiveFormat: "tar.gz",
    executablePath: "pi/pi",
  },
  "linux-x64": {
    artifactName: "pi-linux-x64.tar.gz",
    sha256: "494e498f47d74d21f40b3386f6a5e921a3d49531a169cab55bbdaca0ea1fe25a",
    size: 42_560_927,
    archiveFormat: "tar.gz",
    executablePath: "pi/pi",
  },
  "win32-arm64": {
    artifactName: "pi-windows-arm64.zip",
    sha256: "b25e96fe64c9f41f75a924c0d36f395abb98d6c6fec0b78aaa0b86926f938bb4",
    size: 43_556_369,
    archiveFormat: "zip",
    executablePath: "pi.exe",
  },
  "win32-x64": {
    artifactName: "pi-windows-x64.zip",
    sha256: "002fa95b90d521245b9985d8f168caebc237ad56e7e30b319807dee1b2e17e1c",
    size: 45_009_021,
    archiveFormat: "zip",
    executablePath: "pi.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  // Pi publishes standard Linux builds but no separately qualified musl artifacts.
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

/** Resolve only official Pi targets that passed Scient's native qualification matrix. */
export function resolveReviewedPiArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "pi",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.artifactName}`,
    allowedHosts: ALLOWED_HOSTS,
    allowedUrlPathPrefixes: ALLOWED_URL_PATH_PREFIXES,
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: artifact.archiveFormat,
    // Pi includes its binary, native helpers, themes, documentation, and examples.
    // Preserve bounded headroom without increasing any shared extraction limit.
    extractionLimits: { maxEntries: 512, maxExpandedBytes: 256 * 1024 * 1024 },
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    smokeEnvironment: { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
    catalogRevision: `pi:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install Pi privately. Connect models after installation.",
  };
}
