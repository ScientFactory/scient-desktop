import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "0.202.0";
const RELEASE_BASE = `https://downloads.factory.ai/factory-cli/releases/${VERSION}`;
const ALLOWED_HOSTS = ["downloads.factory.ai"] as const;

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
    sha256: "f5cde1b1faefd3b95f7f0a5e3b71fd94aa27d57b0b96b3b751b23ea4805030c6",
    size: 259_182_128,
    executablePath: "droid",
  },
  "darwin-x64": {
    releaseDirectory: "darwin/x64-baseline",
    artifactName: "droid",
    sha256: "8854b9677db218fc0f7fe18d6741b97ea92264cfdc7c4760f51fa27605f5df8f",
    size: 273_311_136,
    executablePath: "droid",
  },
  "linux-arm64": {
    releaseDirectory: "linux/arm64",
    artifactName: "droid",
    sha256: "7629e0e254b4be6dbaff5426b8d7e8c10e8bbe802593c5bd17b0e1f26bac2a76",
    size: 295_086_224,
    executablePath: "droid",
  },
  "linux-x64": {
    releaseDirectory: "linux/x64-baseline",
    artifactName: "droid",
    sha256: "5846730ce218e42e9c3114c93a0ffb007345fc8fc760b7111912df1d2e3ead9c",
    size: 297_658_496,
    executablePath: "droid",
  },
  "win32-arm64": {
    releaseDirectory: "windows/arm64",
    artifactName: "droid.exe",
    sha256: "2ebf39e3fb39e6614d1a3f62060a7d767355d1318d8a06311401655ba02b8074",
    size: 154_938_080,
    executablePath: "droid.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows/x64-baseline",
    artifactName: "droid.exe",
    sha256: "032b615390a240c384dbed7a019628065cbf0056458e1f06869d8223ec1ff157",
    size: 295_243_488,
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
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: "raw",
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    smokeEnvironment: { FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    catalogRevision: `factory-droid:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install this reviewed official Factory Droid runtime privately.",
  };
}
