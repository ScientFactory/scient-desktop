import type {
  ManagedRuntimeArchiveFormat,
  ManagedRuntimeArtifact,
} from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "2026.08.11-e8db854";
const RELEASE_BASE = `https://downloads.cursor.com/lab/${VERSION}`;
const ALLOWED_HOSTS = ["downloads.cursor.com"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/lab/"] as const;
const ZIP_EXTRACTION_LIMITS = {
  maxEntries: 768,
  maxExpandedBytes: 384 * 1024 * 1024,
} as const;
const TAR_EXTRACTION_LIMITS = {
  // Cursor 2026.09.02's complete Unix bundles expand to 511-570 MiB
  // (at most 576 entries). Windows remains below the existing ZIP budget.
  maxEntries: 768,
  maxExpandedBytes: 768 * 1024 * 1024,
} as const;

interface ArtifactRecord {
  readonly releasePath: string;
  readonly artifactName: string;
  readonly sha256: string;
  readonly size: number;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly smokeExecutablePath?: string | undefined;
  readonly smokeWorkingDirectory?: string | undefined;
  readonly smokeArgs: ReadonlyArray<string>;
}

const ARTIFACTS = {
  "darwin-arm64": {
    releasePath: "darwin/arm64/agent-cli-package.tar.gz",
    artifactName: "cursor-agent-darwin-arm64.tar.gz",
    sha256: "46044d6d7bcbd7b49a0cf1cd01aa4ca79aaa2ea5f2c7a32965fc0ebe29841790",
    size: 74_746_275,
    archiveFormat: "tar.gz",
    executablePath: "dist-package/cursor-agent",
    smokeArgs: ["--disable-auto-update", "--version"],
  },
  "darwin-x64": {
    releasePath: "darwin/x64/agent-cli-package.tar.gz",
    artifactName: "cursor-agent-darwin-x64.tar.gz",
    sha256: "d5c1ce96dd36469e0231d818d4ccf390caac52d94e607c56ebeecc247cab2b1b",
    size: 77_650_670,
    archiveFormat: "tar.gz",
    executablePath: "dist-package/cursor-agent",
    smokeArgs: ["--disable-auto-update", "--version"],
  },
  "linux-arm64": {
    releasePath: "linux/arm64/agent-cli-package.tar.gz",
    artifactName: "cursor-agent-linux-arm64.tar.gz",
    sha256: "ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed",
    size: 83_117_637,
    archiveFormat: "tar.gz",
    executablePath: "dist-package/cursor-agent",
    smokeArgs: ["--disable-auto-update", "--version"],
  },
  "linux-x64": {
    releasePath: "linux/x64/agent-cli-package.tar.gz",
    artifactName: "cursor-agent-linux-x64.tar.gz",
    sha256: "bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a",
    size: 84_532_310,
    archiveFormat: "tar.gz",
    executablePath: "dist-package/cursor-agent",
    smokeArgs: ["--disable-auto-update", "--version"],
  },
  "win32-arm64": {
    releasePath: "windows/arm64/agent-cli-package.zip",
    artifactName: "cursor-agent-win32-arm64.zip",
    sha256: "67a0228a76fc631e132004007d384f95f32f2c77c7cf9cfaeadd53ae868efbe0",
    size: 71_739_644,
    archiveFormat: "zip",
    executablePath: "dist-package/cursor-agent.cmd",
    smokeExecutablePath: "dist-package/node.exe",
    smokeWorkingDirectory: "dist-package",
    smokeArgs: ["index.js", "--disable-auto-update", "--version"],
  },
  "win32-x64": {
    releasePath: "windows/x64/agent-cli-package.zip",
    artifactName: "cursor-agent-win32-x64.zip",
    sha256: "0458981ffe0fda840d19b97d7cbcb26832dafcf01a9c229f3fb0e0d233d66c4b",
    size: 73_841_982,
    archiveFormat: "zip",
    executablePath: "dist-package/cursor-agent.cmd",
    smokeExecutablePath: "dist-package/node.exe",
    smokeWorkingDirectory: "dist-package",
    smokeArgs: ["index.js", "--disable-auto-update", "--version"],
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedCursorArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact: ArtifactRecord = ARTIFACTS[key];
  return {
    provider: "cursor",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.releasePath}`,
    allowedHosts: ALLOWED_HOSTS,
    allowedUrlPathPrefixes: ALLOWED_URL_PATH_PREFIXES,
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: artifact.archiveFormat,
    extractionLimits:
      artifact.archiveFormat === "zip" ? ZIP_EXTRACTION_LIMITS : TAR_EXTRACTION_LIMITS,
    executablePath: artifact.executablePath,
    ...(artifact.smokeExecutablePath ? { smokeExecutablePath: artifact.smokeExecutablePath } : {}),
    ...(artifact.smokeWorkingDirectory
      ? { smokeWorkingDirectory: artifact.smokeWorkingDirectory }
      : {}),
    smokeArgs: artifact.smokeArgs,
    catalogRevision: `cursor-agent:${VERSION}:${key}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install this qualified official Cursor Agent runtime privately for this computer.",
  };
}
