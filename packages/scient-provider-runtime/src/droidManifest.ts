import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "0.203.0";
const RELEASE_BASE = `https://downloads.factory.ai/factory-cli/releases/${VERSION}`;
const ALLOWED_HOSTS = ["downloads.factory.ai"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/factory-cli/releases/"] as const;

interface ArtifactRecord {
  readonly releaseDirectory: string;
  readonly artifactName: string;
  readonly sha256: string;
  readonly size: number;
  readonly executablePath: string;
}

/**
 * Factory publishes separate x64 and x64-baseline binaries. Scient uses the
 * reviewed baseline build so the managed runtime also works on older x64 CPUs.
 */
const ARTIFACTS = {
  "darwin-arm64": {
    releaseDirectory: "darwin/arm64",
    artifactName: "droid",
    sha256: "e0d1f1969ae2971c7986def14127742e368d0de8e3d808dbd4bb380642d29147",
    size: 259_363_760,
    executablePath: "droid",
  },
  "darwin-x64": {
    releaseDirectory: "darwin/x64-baseline",
    artifactName: "droid",
    sha256: "08f69000160884946e22f99e0d33962458de5d33f2724d8d142fdb256a383fc1",
    size: 273_492_768,
    executablePath: "droid",
  },
  "linux-arm64": {
    releaseDirectory: "linux/arm64",
    artifactName: "droid",
    sha256: "bd01fc8adaee56db3c5a0c8ae96c799889fe6611b0e62688b72c57435600e5a2",
    size: 295_282_832,
    executablePath: "droid",
  },
  "linux-x64": {
    releaseDirectory: "linux/x64-baseline",
    artifactName: "droid",
    sha256: "577bc12b328b65d521873bfa66c492f5e3ff80b3504c94eb9b23242b3e1ba1a7",
    size: 297_842_816,
    executablePath: "droid",
  },
  "win32-arm64": {
    releaseDirectory: "windows/arm64",
    artifactName: "droid.exe",
    sha256: "40b9e5d09dc42f3aacc5d4904e3613465fd212d57da2d54f164dca6026c375b3",
    size: 154_980_064,
    executablePath: "droid.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows/x64-baseline",
    artifactName: "droid.exe",
    sha256: "f0ea989c182081d8a18d8a4ffb55a82539ade52a56ee15fa1c7030b0e7fb1ed8",
    size: 295_423_712,
    executablePath: "droid.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  // Factory does not publish or qualify a distinct musl build.
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedDroidArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "droid",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.releaseDirectory}/${artifact.artifactName}`,
    allowedHosts: ALLOWED_HOSTS,
    allowedUrlPathPrefixes: ALLOWED_URL_PATH_PREFIXES,
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: "raw",
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    smokeEnvironment: { FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    catalogRevision: `factory-droid:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install this qualified official Factory Droid runtime privately.",
  };
}
