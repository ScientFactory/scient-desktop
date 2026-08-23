import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

/**
 * Matches the native Claude Code executable bundled with
 * @anthropic-ai/claude-agent-sdk 0.3.170. Keeping these versions paired avoids
 * silently changing T3's already-proven Claude SDK/runtime protocol.
 */
const VERSION = "2.1.170";
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
    sha256: "e903646d8b7a31882a80ecd27569a27d8ac57b3708745f349709632c84117fdf",
    size: 222_102_816,
    executablePath: "claude",
  },
  "darwin-x64": {
    platform: "darwin-x64",
    sha256: "914f23a70bbed5d9ae567e3e04b86206ed9971b371bc9baca3f79c8885bfddb4",
    size: 224_616_976,
    executablePath: "claude",
  },
  "linux-arm64-glibc": {
    platform: "linux-arm64",
    sha256: "1bb9d032440a75532f7dd4cafbc687f220aaf16c63eba17e192dfbec2f04bd25",
    size: 247_379_592,
    executablePath: "claude",
  },
  "linux-x64-glibc": {
    platform: "linux-x64",
    sha256: "849e007277a0442ab27570d3e3d6d43787507946590e8dd1947e5a39b7081f9e",
    size: 247_469_776,
    executablePath: "claude",
  },
  "linux-arm64-musl": {
    platform: "linux-arm64-musl",
    sha256: "73154fd674aaf233254edea8fbfb6a53d82d5297ae7546b998e36983def4dddc",
    size: 240_234_328,
    executablePath: "claude",
  },
  "linux-x64-musl": {
    platform: "linux-x64-musl",
    sha256: "5d19b7c91a03182ccb69da249f721684aebecfa4c52fe46b9205a81d8fc64a47",
    size: 241_863_728,
    executablePath: "claude",
  },
  "win32-arm64": {
    platform: "win32-arm64",
    sha256: "9abd330bcc191aecc877a8ee9da2b448852cfe3bda15e5e4608385ea1d9d1709",
    size: 238_894_240,
    executablePath: "claude.exe",
  },
  "win32-x64": {
    platform: "win32-x64",
    sha256: "193061508fe619abf534b2c9d48151f26971d1d5b8460ad75c0af4be3d3525fb",
    size: 242_929_824,
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
