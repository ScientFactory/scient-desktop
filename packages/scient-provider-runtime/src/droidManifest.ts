import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

export const DROID_LATEST_VERSION_URL = "https://downloads.factory.ai/factory-cli/LATEST";

/** Factory's installer channel is a single stable version, not its changelog RSS. */
export function parseDroidReleaseVersion(source: string): string | null {
  const version = source.trim();
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version) ? version : null;
}

const VERSION = "1.2.0";
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
    sha256: "1d3b31500d6c2a0b7142fa0c87677273b3c2cedc8db46060916708264b169260",
    size: 308_243_888,
    executablePath: "droid",
  },
  "darwin-x64": {
    releaseDirectory: "darwin/x64-baseline",
    artifactName: "droid",
    sha256: "b4a934a4f01b0e5f167cd7762e0b20f4fb2d428ccfc3b47fe93198fd155c1061",
    size: 324_201_008,
    executablePath: "droid",
  },
  "linux-arm64": {
    releaseDirectory: "linux/arm64",
    artifactName: "droid",
    sha256: "73703310aa56e170bc35f0837ac5c22c111479f6559ec234c08e68ffa5ce056a",
    size: 330_025_976,
    executablePath: "droid",
  },
  "linux-x64": {
    releaseDirectory: "linux/x64-baseline",
    artifactName: "droid",
    sha256: "bbf1b279c499815159454f019f6b95cc1a3daba916bab7ff8846dde6917a52b4",
    size: 338_155_696,
    executablePath: "droid",
  },
  "win32-arm64": {
    releaseDirectory: "windows/arm64",
    artifactName: "droid.exe",
    sha256: "f723f038a4246864581409dd8eb584caf1b14e48bc522fd97ee48b56f4959a0f",
    size: 248_795_360,
    executablePath: "droid.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows/x64-baseline",
    artifactName: "droid.exe",
    sha256: "c0162de14326c9fcd0bd2d2ffdffd841db294638a2a7797f8d9ff48bde214663",
    size: 339_883_744,
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
