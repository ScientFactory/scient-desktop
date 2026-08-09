import type { ManagedRuntimeTarget } from "./target.ts";

export type ManagedRuntimeArchiveFormat = "raw" | "tar.gz";
export type ManagedRuntimeSupportTier =
  | "fully_assisted"
  | "external_runtime_supported"
  | "manual_or_advanced_only"
  | "unsupported";

export interface ManagedRuntimeArtifact {
  readonly provider: "codex";
  readonly version: string;
  readonly target: ManagedRuntimeTarget;
  readonly artifactName: string;
  readonly url: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly sha256: string;
  readonly size: number;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly smokeArgs: ReadonlyArray<string>;
  readonly catalogRevision: string;
  readonly supportTier: ManagedRuntimeSupportTier;
  readonly supportMessage: string;
}

const VERSION = "0.147.0";
const RELEASE_TAG = `rust-v${VERSION}`;
const RELEASE_BASE = `https://github.com/openai/codex/releases/download/${RELEASE_TAG}`;
const ALLOWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

interface ArtifactRecord {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly fullyAssisted: boolean;
}

const ARTIFACTS = {
  "darwin-arm64": {
    name: "codex-aarch64-apple-darwin.tar.gz",
    sha256: "75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358",
    size: 87_984_231,
    archiveFormat: "tar.gz",
    executablePath: "codex-aarch64-apple-darwin",
    fullyAssisted: true,
  },
  "darwin-x64": {
    name: "codex-x86_64-apple-darwin.tar.gz",
    sha256: "36e782f71d8164cc37c2b89c64948f2180e9a2f8456b27e660da75bc6b5574e2",
    size: 95_851_149,
    archiveFormat: "tar.gz",
    executablePath: "codex-x86_64-apple-darwin",
    fullyAssisted: true,
  },
  "linux-arm64": {
    name: "codex-aarch64-unknown-linux-musl.tar.gz",
    sha256: "eb677c80f666b1ab8b4b1d083b66e8d614b1281d960bb6f9fd8ca98f58b38b90",
    size: 91_607_658,
    archiveFormat: "tar.gz",
    executablePath: "codex-aarch64-unknown-linux-musl",
    fullyAssisted: true,
  },
  "linux-x64": {
    name: "codex-x86_64-unknown-linux-musl.tar.gz",
    sha256: "0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36",
    size: 98_970_270,
    archiveFormat: "tar.gz",
    executablePath: "codex-x86_64-unknown-linux-musl",
    fullyAssisted: true,
  },
  "win32-arm64": {
    name: "codex-aarch64-pc-windows-msvc.exe",
    sha256: "1f0e8c2dd3c6b471e985fac76908366c1cf31155094fde606fb2d3052cf00584",
    size: 250_102_064,
    archiveFormat: "raw",
    executablePath: "codex.exe",
    fullyAssisted: true,
  },
  "win32-x64": {
    name: "codex-x86_64-pc-windows-msvc.exe",
    sha256: "935a1911ed2556e4ffcec995f4886ac2ac425863ba26fed264df62e30272ad9d",
    size: 298_668_336,
    archiveFormat: "raw",
    executablePath: "codex.exe",
    fullyAssisted: true,
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedCodexArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "codex",
    version: VERSION,
    target,
    artifactName: artifact.name,
    url: `${RELEASE_BASE}/${artifact.name}`,
    allowedHosts: ALLOWED_HOSTS,
    sha256: artifact.sha256,
    size: artifact.size,
    archiveFormat: artifact.archiveFormat,
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    catalogRevision: `openai-codex:${RELEASE_TAG}:${artifact.sha256}`,
    supportTier: artifact.fullyAssisted ? "fully_assisted" : "external_runtime_supported",
    supportMessage: artifact.fullyAssisted
      ? "Scient can install this verified official Codex artifact privately for this computer."
      : "Scient recognizes this official target, but managed installation is not available here.",
  };
}
