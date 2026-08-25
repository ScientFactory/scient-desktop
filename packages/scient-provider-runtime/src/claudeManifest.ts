import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

/**
 * Reviewed Claude Code executable qualified against T3's inherited
 * @anthropic-ai/claude-agent-sdk 0.3.170 integration. The SDK launches this
 * explicit path rather than its bundled executable.
 */
const VERSION = "2.1.245";
const RELEASE_BASE = "https://downloads.claude.ai/claude-code-releases";
const ALLOWED_HOSTS = ["downloads.claude.ai"] as const;

interface ArtifactRecord {
  readonly platform: string;
  readonly sha256: string;
  readonly size: number;
  readonly executablePath: string;
}

const ARTIFACTS = {
  "darwin-arm64": {
    platform: "darwin-arm64",
    sha256: "9f7c2260251765a18d0b35198669dacc1912f6e8129a3b01f6b58d93365ff1f1",
    size: 376_109_392,
    executablePath: "claude",
  },
  "darwin-x64": {
    platform: "darwin-x64",
    sha256: "de044bb543e826352f31587a74356e1b2dae94dc1b9c960a362d9f07df96c2a7",
    size: 385_137_136,
    executablePath: "claude",
  },
  "linux-arm64-glibc": {
    platform: "linux-arm64",
    sha256: "d0da299303d710a7cc5cdece9629958f5128ce1a727e15463c651ed5cf385c7f",
    size: 389_077_224,
    executablePath: "claude",
  },
  "linux-x64-glibc": {
    platform: "linux-x64",
    sha256: "16ad2b94deaf7b29abed966d981c9991a47af0420f5be8ed4a3f83bea9f678bc",
    size: 391_948_592,
    executablePath: "claude",
  },
  "linux-arm64-musl": {
    platform: "linux-arm64-musl",
    sha256: "8707fbe629fdd9876d9c356baa833a697dac76cd9a7157088f667199b8492851",
    size: 382_222_104,
    executablePath: "claude",
  },
  "linux-x64-musl": {
    platform: "linux-x64-musl",
    sha256: "d25564bc5d84ec988a762cfe25fe51cb706b96eaec614f704ddbf653ab08ba00",
    size: 386_060_256,
    executablePath: "claude",
  },
  "win32-arm64": {
    platform: "win32-arm64",
    sha256: "9cff8169be24a8b3e59e89e58d9e3d37f3c17ca1b3a149e60666fe53c789d80a",
    size: 372_111_520,
    executablePath: "claude.exe",
  },
  "win32-x64": {
    platform: "win32-x64",
    sha256: "d1649bf5261792fee7e1a1b63fdd2197082adec36ce9701aa0c1723bdcd2348a",
    size: 384_213_664,
    executablePath: "claude.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  const key = `${target.platform}-${target.arch}${target.platform === "linux" ? `-${target.libc ?? "glibc"}` : ""}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedClaudeArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  const artifactName = `claude-${VERSION}-${artifact.platform}`;
  return {
    provider: "claudeAgent",
    version: VERSION,
    target,
    artifactName,
    url: `${RELEASE_BASE}/${VERSION}/${artifact.platform}/${artifact.executablePath}`,
    allowedHosts: ALLOWED_HOSTS,
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: "raw",
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    catalogRevision: `anthropic-claude-code:${VERSION}:${artifact.platform}:${artifact.sha256}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install this reviewed official Claude Code runtime privately.",
  };
}
