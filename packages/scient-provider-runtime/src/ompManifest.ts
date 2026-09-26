import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "18.2.8";
const RELEASE_BASE = `https://github.com/can1357/oh-my-pi/releases/download/v${VERSION}`;
const ALLOWED_HOSTS = ["github.com", "release-assets.githubusercontent.com"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/can1357/oh-my-pi/releases/download/"] as const;

const ARTIFACTS = {
  "darwin-arm64": {
    artifactName: "omp-darwin-arm64",
    sha256: "cf8d34a7fe6f60de1acbe74f29c82026e4c07888e9d89f7ebceeb922159e5787",
    size: 193_484_176,
  },
} as const;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

/** Only the macOS arm64 binary that passed Scient's checksum and smoke qualification. */
export function resolveReviewedOmpArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "omp",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.artifactName}`,
    allowedHosts: ALLOWED_HOSTS,
    allowedUrlPathPrefixes: ALLOWED_URL_PATH_PREFIXES,
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: "raw",
    executablePath: "omp",
    smokeArgs: ["--version"],
    catalogRevision: `omp:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install Oh My Pi privately. Model sign-in stays in Oh My Pi.",
  };
}
