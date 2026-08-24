import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "0.149.1";
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
  readonly executablePath: string;
  readonly auxiliaryExecutablePaths: ReadonlyArray<string>;
  readonly fullyAssisted: boolean;
}

const ARTIFACTS = {
  "darwin-arm64": {
    name: "codex-package-aarch64-apple-darwin.tar.gz",
    sha256: "4cbb17468b5d86b4b182a28c016d62e9d273a241cec04885ccfae76e6983ae3f",
    size: 110_095_583,
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/zsh/bin/zsh",
    ],
    fullyAssisted: true,
  },
  "darwin-x64": {
    name: "codex-package-x86_64-apple-darwin.tar.gz",
    sha256: "4c50fb92bb238a4067009d4a99c13351325c8840da91edd0ce4e5b7a21d53bc3",
    size: 119_660_659,
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/zsh/bin/zsh",
    ],
    fullyAssisted: true,
  },
  "linux-arm64": {
    name: "codex-package-aarch64-unknown-linux-musl.tar.gz",
    sha256: "57095f9f4ced36d8e173f67e26c5c142d5b3e1e1984bbcae35684209ed236a9b",
    size: 113_760_656,
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/bwrap",
      "codex-resources/zsh/bin/zsh",
    ],
    fullyAssisted: true,
  },
  "linux-x64": {
    name: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "1e8531ae5f6dea3c6e11e53e74cc5ac81bf1ba597f9b296fb112d6ea30fdaf5d",
    size: 122_578_702,
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/bwrap",
      "codex-resources/zsh/bin/zsh",
    ],
    fullyAssisted: true,
  },
  "win32-arm64": {
    name: "codex-package-aarch64-pc-windows-msvc.tar.gz",
    sha256: "caba0a92e2bb74f7c5ce71cbcc1271aceba1c11e67997ee278162b0fa4ee74dc",
    size: 124_885_100,
    executablePath: "bin/codex.exe",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host.exe",
      "codex-path/rg.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ],
    fullyAssisted: true,
  },
  "win32-x64": {
    name: "codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "e302697785b0761833779fe2d7b65614d6d156e8e6b8b9fa9725b6503d552613",
    size: 134_545_938,
    executablePath: "bin/codex.exe",
    auxiliaryExecutablePaths: [
      "bin/codex-code-mode-host.exe",
      "codex-path/rg.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ],
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
    checksum: { algorithm: "sha256", digest: artifact.sha256 },
    size: artifact.size,
    archiveFormat: "tar.gz",
    executablePath: artifact.executablePath,
    auxiliaryExecutablePaths: artifact.auxiliaryExecutablePaths,
    smokeArgs: ["--version"],
    catalogRevision: `openai-codex:${RELEASE_TAG}:${artifact.sha256}`,
    supportTier: artifact.fullyAssisted ? "fully_assisted" : "external_runtime_supported",
    supportMessage: artifact.fullyAssisted
      ? "Scient can install this verified official Codex artifact privately for this computer."
      : "Scient recognizes this official target, but managed installation is not available here.",
  };
}
