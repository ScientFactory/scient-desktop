import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "1.1.20";
const RELEASE_BASE =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.20-5830032204103680";
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
      "a6396168e9fc7e6e30bbbfeccabe2b48b3008a9dc16d645645e354b73948c8a2f3d4f2b8ee4a00741e4b7960aeeb766229c05a34f805cec987cc17ccfdf4f2d5",
    size: 49_981_316,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "darwin-x64": {
    releaseDirectory: "darwin-x64",
    artifactName: "cli_mac_x64.tar.gz",
    sha512:
      "4d2247438b3e2f2c4bd06e88f39e4b6a57e17ed17ce863dc238a291be66dcd1527c0c90291ca247bdb924a15a93bd446c7bf29a0b2081b89c1c35d9b053248f1",
    size: 54_798_910,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-arm64": {
    releaseDirectory: "linux-arm",
    artifactName: "cli_linux_arm64.tar.gz",
    sha512:
      "710336d95653b08aac4e1d403401c4bdd96b8ebc9d7b414753d9d83ca1036624fef9a4941eda710afc5bc416d1ff7054d937ac14c965f5ad28d28e05e4621093",
    size: 52_794_046,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-x64": {
    releaseDirectory: "linux-x64",
    artifactName: "cli_linux_x64.tar.gz",
    sha512:
      "6cdc7fc90562ba40c8bf0658f30ede016e6acd03083779be8d54d4bf63dd99800393e33c00addf943f6c2b79b4dacefc6fb4a963b2b02f6ce63635ef54a42868",
    size: 56_295_623,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "win32-arm64": {
    releaseDirectory: "windows-arm",
    artifactName: "cli_windows_arm64.exe",
    sha512:
      "72c9f56e86f226c82368983348589d22aedc48bea39c26190c6f259b8fde735e367f24baa89769ebd61e86916c2f66c38de250f1365ccc0ecb3a79436e00c62a",
    size: 176_160_920,
    archiveFormat: "raw",
    executablePath: "agy.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows-x64",
    artifactName: "cli_windows_x64.exe",
    sha512:
      "14f800b37c6d96944ab1c844de8d8b9a09de85b05fdb88b6f1181095e80e62fd720f94b7ab3bee506a96a37b7366d28ddd9664361a7edf28b478986783fe31b3",
    size: 186_433_176,
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
