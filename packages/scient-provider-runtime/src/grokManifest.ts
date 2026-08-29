import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const VERSION = "1.0.5";
const RELEASE_BASE = "https://x.ai/cli";
const ALLOWED_HOSTS = ["x.ai"] as const;
const ALLOWED_URL_PATH_PREFIXES = ["/cli/"] as const;

interface ArtifactRecord {
  readonly artifactName: string;
  readonly sha512: string;
  readonly size: number;
  readonly executablePath: string;
}

const ARTIFACTS = {
  "darwin-arm64": {
    artifactName: `grok-${VERSION}-macos-aarch64`,
    sha512:
      "553d984996535f3086f063ce35c02232126ef031bac59c545fe2a180026af8429fccd218999c134a3738400383c0fbbade4ea853103c0c41903309cf815d6e12",
    size: 134_349_648,
    executablePath: "grok",
  },
  "darwin-x64": {
    artifactName: `grok-${VERSION}-macos-x86_64`,
    sha512:
      "12d85cb440d49a2fd3b072cd3053a0e8e841cb31f0839f041ba925b4a9e0223e1f122e6c56695468ddbbb81f60cb163b1f7db6538bd54c93c475c0c189e2ab15",
    size: 150_381_856,
    executablePath: "grok",
  },
  "linux-arm64": {
    artifactName: `grok-${VERSION}-linux-aarch64`,
    sha512:
      "df19133ff2f4166c67abf6f62cc62a92df7d756b0019432c112cf83d9ce71e45972730799393ac3d1f51949a6eb3987167da82c52d8bd09f8299168ef60e5392",
    size: 136_259_976,
    executablePath: "grok",
  },
  "linux-x64": {
    artifactName: `grok-${VERSION}-linux-x86_64`,
    sha512:
      "4857b5b3f95d1b6ae463e54907057584afc34c1203ea565d4816487183045d4c6b2ddcca236aa1086fd79c82a3b54ece67f1a04377fb677c61af309928a8f224",
    size: 166_854_368,
    executablePath: "grok",
  },
  "win32-arm64": {
    artifactName: `grok-${VERSION}-windows-aarch64.exe`,
    sha512:
      "5c7bd27a90a614cef6f62b4bbad18e893acbf77aa25cc0ec5ab259a51d9713c9cebba6a7fa53fac3f45c0b93d7f49063fa80d9ebfecb5efbb1a8286a7c3e3935",
    size: 123_656_008,
    executablePath: "grok.exe",
  },
  "win32-x64": {
    artifactName: `grok-${VERSION}-windows-x86_64.exe`,
    sha512:
      "b421b9fe7697ffda67d7c9e8b6c6fabaf0fa194f9f3234c7198397105d0dcff89587b1e7d3a234d016b7801b05f4e0c7785983a75fe2ecf6a470f7bdd7072730",
    size: 142_651_720,
    executablePath: "grok.exe",
  },
} as const satisfies Readonly<Record<string, ArtifactRecord>>;

function artifactKey(target: ManagedRuntimeTarget): keyof typeof ARTIFACTS | undefined {
  if (target.platform === "linux" && target.libc === "musl") return undefined;
  const key = `${target.platform}-${target.arch}`;
  return key in ARTIFACTS ? (key as keyof typeof ARTIFACTS) : undefined;
}

export function resolveReviewedGrokArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  const key = artifactKey(target);
  if (!key) return undefined;
  const artifact = ARTIFACTS[key];
  return {
    provider: "grok",
    version: VERSION,
    target,
    artifactName: artifact.artifactName,
    url: `${RELEASE_BASE}/${artifact.artifactName}`,
    allowedHosts: ALLOWED_HOSTS,
    allowedUrlPathPrefixes: ALLOWED_URL_PATH_PREFIXES,
    checksum: { algorithm: "sha512", digest: artifact.sha512 },
    size: artifact.size,
    archiveFormat: "raw",
    executablePath: artifact.executablePath,
    smokeArgs: ["--version"],
    catalogRevision: `xai-grok-build:${VERSION}:${key}:${artifact.sha512}`,
    supportTier: "fully_assisted",
    supportMessage: "Scient can install this qualified official Grok Build runtime privately.",
  };
}
