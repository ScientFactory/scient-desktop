import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "1.1.19";
const RELEASE_BASE =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.19-4894004681244672";
const ALLOWED_HOSTS = ["storage.googleapis.com"] as const;

interface ArtifactRecord {
  readonly releaseDirectory: string;
  readonly artifactName: string;
  readonly sha512: string;
  readonly size: number;
  readonly archiveFormat: "raw" | "tar.gz";
  readonly executablePath: string;
}

const ARTIFACTS = {
  "darwin-arm64": {
    releaseDirectory: "darwin-arm",
    artifactName: "cli_mac_arm64.tar.gz",
    sha512:
      "54b6b0e2e2fed5d5e270c6353f8097bd2a0e966f07946ded8065a6293b79ec7be5993f5d3de5c12d0683b33822a5cb887795094ffa2c6f77bb7183816c92ae96",
    size: 49_549_052,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "darwin-x64": {
    releaseDirectory: "darwin-x64",
    artifactName: "cli_mac_x64.tar.gz",
    sha512:
      "e6f9e0c3e0d32509937cb6aa5f6e00096aed2a78ab3e21ffdcf05ddbbf0e2b4772388196d9dbbc356400b16adc3ba6d2ecb8d8fdafa9489604ed3b3bbd775f95",
    size: 54_278_163,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-arm64": {
    releaseDirectory: "linux-arm",
    artifactName: "cli_linux_arm64.tar.gz",
    sha512:
      "488c3dac1c7ca866a9da990f9a88648bfb7176992a0a2d27605e3bc10143e5b17af552ed99f0bf4250e2d69fed6d0d5f50684c729bf03f269f2b52b44503558d",
    size: 52_317_463,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-x64": {
    releaseDirectory: "linux-x64",
    artifactName: "cli_linux_x64.tar.gz",
    sha512:
      "7c3b310c80685adcba714994207eb870fb4817403975da46555b7d9fade446487da3d8f897aa220dfbc30f602ab461a0147a6f7b3c8228fdebd35951e3f250fd",
    size: 55_763_391,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "win32-arm64": {
    releaseDirectory: "windows-arm",
    artifactName: "cli_windows_arm64.exe",
    sha512:
      "2ea35aa877892b1c40482ff748bac90958998bfe15e81f49ebb1f3880550ecbdf50786b057f6b95923236b48ab589a678cad5a9ecf150e4ff4cf6e9eac582edd",
    size: 174_601_880,
    archiveFormat: "raw",
    executablePath: "agy.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows-x64",
    artifactName: "cli_windows_x64.exe",
    sha512:
      "5b7c6c93d90244b8db44bd6e3d6cef2d7092947ca7870e77df8e626f6a58e2322f3623cc0d239e90cb698d1f072168a797362a51e25b22338aa6a3e2666df31e",
    size: 184_617_112,
    archiveFormat: "raw",
    executablePath: "agy.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedAntigravityArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "antigravity",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.releaseDirectory}/${artifact.artifactName}`,
    allowedHosts: ALLOWED_HOSTS,
    checksum: { algorithm: "sha512", digest: artifact.sha512 },
    size: artifact.size,
    archiveFormat: artifact.archiveFormat,
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    smokeEnvironment: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    catalogRevision: `google-antigravity-cli:${VERSION}:${key}:${artifact.sha512}`,
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install this reviewed official Google Antigravity CLI runtime privately.",
  };
}
