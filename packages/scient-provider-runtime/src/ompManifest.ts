import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

/**
 * The Oh My Pi major version Scient is qualified against. Process startup, the
 * managed-runtime catalog, the update advisory, and the model-manifest policy
 * all derive their limits from this one value. Qualifying a new major means
 * raising it together with a newer, narrower manifest policy.
 */
export const OMP_SUPPORTED_MAJOR = 18;
/** The oldest Oh My Pi release whose RPC v2 surface Scient is qualified against. */
export const OMP_MINIMUM_VERSION = "18.2.8";

/** True when a semver version, prerelease or not, is inside the supported major. */
export function isSupportedOmpMajor(version: string): boolean {
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/u.exec(version.trim());
  return match !== null && Number(match[1]) === OMP_SUPPORTED_MAJOR;
}

const VERSION = "18.2.8";
const RELEASE_BASE = `https://github.com/can1357/oh-my-pi/releases/download/v${VERSION}`;
const ALLOWED_HOSTS = ["github.com", "release-assets.githubusercontent.com"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/can1357/oh-my-pi/releases/download/"] as const;

interface ArtifactRecord {
  readonly artifactName: string;
  readonly sha256: string;
  readonly size: number;
  readonly executablePath: string;
}

/**
 * Oh My Pi's standalone release binaries. Its musl builds are left out, as for
 * Pi: the desktop app, where managed installation runs, needs glibc.
 */
const ARTIFACTS = {
  "darwin-arm64": {
    artifactName: "omp-darwin-arm64",
    sha256: "cf8d34a7fe6f60de1acbe74f29c82026e4c07888e9d89f7ebceeb922159e5787",
    size: 193_484_176,
    executablePath: "omp",
  },
  "darwin-x64": {
    artifactName: "omp-darwin-x64",
    sha256: "b385c2bbacddc09b266ec19ba95ebb2882301293d49390d7fd32cc3a12a1da41",
    size: 201_908_656,
    executablePath: "omp",
  },
  "linux-arm64": {
    artifactName: "omp-linux-arm64",
    sha256: "a9aa63e43c95ccaa0683e9fed03463c401829e220ad2bbc414b341d2d49e5806",
    size: 214_616_360,
    executablePath: "omp",
  },
  "linux-x64": {
    artifactName: "omp-linux-x64",
    sha256: "b0c01da7339d87fd5d26d7faa7b61c131a50648399962783899fd93a6d8b1d65",
    size: 259_003_872,
    executablePath: "omp",
  },
  "win32-arm64": {
    artifactName: "omp-windows-arm64.exe",
    sha256: "ae4045cb1db051fa7331a37185f65370746a0d866ed1a87916da811a9192815f",
    size: 207_932_928,
    executablePath: "omp.exe",
  },
  "win32-x64": {
    artifactName: "omp-windows-x64.exe",
    sha256: "b95431cb63b073c36c3664f6d9e2611de8d28d6e6e21ede657c8f83f0e7034b3",
    size: 218_729_472,
    executablePath: "omp.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

/** The reviewed binary for this target, checksum-pinned and qualified before publication. */
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
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    catalogRevision: `omp:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install Oh My Pi privately. Model sign-in stays in Oh My Pi.",
  };
}
