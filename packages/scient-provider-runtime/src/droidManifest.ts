import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

export const DROID_LATEST_VERSION_URL = "https://downloads.factory.ai/factory-cli/LATEST";

/** Factory's installer channel is a single stable version, not its changelog RSS. */
export function parseDroidReleaseVersion(source: string): string | null {
  const version = source.trim();
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version) ? version : null;
}

const VERSION = "0.213.0";
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
    sha256: "c7e3282165c2acb8180471ecae2b24ba1fe2592a6d54b291450ef217f65c6e7c",
    size: 267_273_008,
    executablePath: "droid",
  },
  "darwin-x64": {
    releaseDirectory: "darwin/x64-baseline",
    artifactName: "droid",
    sha256: "fad8ca21bb2a36f70910569709bd7a62a1bc831f0965a335c6b03bf3688d7642",
    size: 281_864_352,
    executablePath: "droid",
  },
  "linux-arm64": {
    releaseDirectory: "linux/arm64",
    artifactName: "droid",
    sha256: "bf0a7988c4d4ae867cfc285897ca9e3e5805fa5a305c6fe447c37c404fc75d7c",
    size: 303_409_296,
    executablePath: "droid",
  },
  "linux-x64": {
    releaseDirectory: "linux/x64-baseline",
    artifactName: "droid",
    sha256: "6c76a51cb7166bc771f9c3f4470a604ab7ef65a5dac19c9305cd4b66ef8e0b99",
    size: 306_215_040,
    executablePath: "droid",
  },
  "win32-arm64": {
    releaseDirectory: "windows/arm64",
    artifactName: "droid.exe",
    sha256: "1166cbd14c67ccd3655c8f93a44dab00a50d25a188977994ea52e5416e33f48e",
    size: 158_798_560,
    executablePath: "droid.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows/x64-baseline",
    artifactName: "droid.exe",
    sha256: "53e18992dc1b034dcda1c3fa15bb4858cd86caaf4260f9525a84dc53a5b10700",
    size: 303_632_608,
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
