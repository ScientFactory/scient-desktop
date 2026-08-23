import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "1.1.17";
const RELEASE_BASE =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.17-5084709148033024";
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
      "eda17e9f3649df12bcd614e226983922cd5e4c22a9153e9f9a5ecc5557addcda0f03147db8a2c6c19daeb8e1dc8062a9a1bcf86284315c2b1aae73f2d8236b1e",
    size: 49_401_949,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "darwin-x64": {
    releaseDirectory: "darwin-x64",
    artifactName: "cli_mac_x64.tar.gz",
    sha512:
      "38c23febf677c93ba62cccc979ceee0348e733e2d1d827c9d0751422e5d4462b5df1030ff97f07d78a30194cc1386a6b428ba3f85141a65f572e804a9978bda5",
    size: 54_128_714,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-arm64": {
    releaseDirectory: "linux-arm",
    artifactName: "cli_linux_arm64.tar.gz",
    sha512:
      "ad871538fc8bbd0cf96e11b85e388dadde5cd02164c2921cf7cd30646e343c90a63ef5224f6420612ad6f91fe06f260e332e307968082f3a1f54e53933be847f",
    size: 52_175_139,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "linux-x64": {
    releaseDirectory: "linux-x64",
    artifactName: "cli_linux_x64.tar.gz",
    sha512:
      "5c6047a19e80025ea7cecc8152fb263a7f14e80591ee75bdf1ca10191cc0cd1639b5b5ebdce4d1c9d43b14bd2446f038a457821694579f4392b6ca9736512936",
    size: 55_607_296,
    archiveFormat: "tar.gz",
    executablePath: "antigravity",
  },
  "win32-arm64": {
    releaseDirectory: "windows-arm",
    artifactName: "cli_windows_arm64.exe",
    sha512:
      "476cb921d8dffec9bafd6404e586aaf297b805ac70f9373373d943a7836d24c8ec5778e24f243368d1e96135629b4a8014ef40e9de1ea349eecb7da0006f12a4",
    size: 174_058_648,
    archiveFormat: "raw",
    executablePath: "agy.exe",
  },
  "win32-x64": {
    releaseDirectory: "windows-x64",
    artifactName: "cli_windows_x64.exe",
    sha512:
      "354def717fe717f31d03ec5a359041b368a98d856cd544bed1bb8bfde071c8012a7592e7d8840fcb182e083f9ab587dc1c6585f4c830c26131a22ef7b998799b",
    size: 184_027_288,
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
    catalogRevision: `google-antigravity-cli:${VERSION}:${key}:${artifact.sha512}`,
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install this reviewed official Google Antigravity CLI runtime privately.",
  };
}
