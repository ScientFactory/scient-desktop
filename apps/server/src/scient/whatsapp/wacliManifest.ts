/**
 * The pinned `wacli` release: exact URL, byte size and SHA-256 per platform; never resolve
 * "latest" at runtime. Repin every target together on upgrades and check that `wacli version`
 * still prints the pinned version. Windows Arm64 has no published build and stays unsupported
 * rather than receiving another architecture's binary.
 */
import * as Context from "effect/Context";

import type { PandocArchiveKind } from "../pandoc/pandocManifest.ts";

export interface WacliAsset {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  /** Exact byte count of the pinned archive; a download that disagrees is rejected. */
  readonly sizeBytes: number;
  /** Both kinds expand with the system `tar` (see `PandocArchiveUnpacker`). */
  readonly archive: PandocArchiveKind;
  /** Path of the `wacli` executable inside the unpacked tree. */
  readonly executableRelativePath: string;
}

export type WacliPlatformArch =
  | "win32-x64"
  | "win32-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64";

export const WACLI_PLATFORM_ARCHES: ReadonlyArray<WacliPlatformArch> = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

function isWacliPlatformArch(value: string): value is WacliPlatformArch {
  return (WACLI_PLATFORM_ARCHES as ReadonlyArray<string>).includes(value);
}

export interface WacliManifest {
  /** What `wacli version` prints for the pinned release. */
  readonly version: string;
  readonly license: string;
  /** Where the exact source of this release is published. */
  readonly sourceUrl: string;
  readonly assets: Readonly<Record<WacliPlatformArch, WacliAsset | null>>;
}

const VERSION = "0.26.1";
const RELEASE_BASE = `https://github.com/openclaw/wacli/releases/download/v${VERSION}`;

/**
 * Release downloads redirect once into GitHub's asset CDN. Every hop is checked against this
 * list; the digest check is what decides whether the bytes are the reviewed ones.
 */
export const WACLI_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

export const WACLI_SOURCE_URL = `https://github.com/openclaw/wacli/archive/refs/tags/v${VERSION}.tar.gz`;

// Every archive holds LICENSE, README.md and the executable at its top level.
export const WACLI_MANIFEST: WacliManifest = {
  version: VERSION,
  license: "MIT",
  sourceUrl: WACLI_SOURCE_URL,
  assets: {
    "darwin-arm64": {
      fileName: `wacli_${VERSION}_darwin_arm64.tar.gz`,
      url: `${RELEASE_BASE}/wacli_${VERSION}_darwin_arm64.tar.gz`,
      sha256: "20898523a70fb3ad992f8a20d786f70484bb53221df017cdafdcb7f7fc882d8f",
      sizeBytes: 8_323_211,
      archive: "tar-gz",
      executableRelativePath: "wacli",
    },
    "darwin-x64": {
      fileName: `wacli_${VERSION}_darwin_amd64.tar.gz`,
      url: `${RELEASE_BASE}/wacli_${VERSION}_darwin_amd64.tar.gz`,
      sha256: "d5561a41534ec83be8bca611d1fcef12bbfb9967a3661dcc7d0328b929224a7d",
      sizeBytes: 9_300_621,
      archive: "tar-gz",
      executableRelativePath: "wacli",
    },
    "linux-x64": {
      fileName: `wacli_${VERSION}_linux_amd64.tar.gz`,
      url: `${RELEASE_BASE}/wacli_${VERSION}_linux_amd64.tar.gz`,
      sha256: "515405c5a33c7f651a368484740db662736f50c275be5a0504fb0a84dce47013",
      sizeBytes: 9_348_860,
      archive: "tar-gz",
      executableRelativePath: "wacli",
    },
    "linux-arm64": {
      fileName: `wacli_${VERSION}_linux_arm64.tar.gz`,
      url: `${RELEASE_BASE}/wacli_${VERSION}_linux_arm64.tar.gz`,
      sha256: "9efe789b01e12462140089749d8b5ce0ad292521893f4166e13eca81f0acac4c",
      sizeBytes: 8_541_128,
      archive: "tar-gz",
      executableRelativePath: "wacli",
    },
    "win32-x64": {
      fileName: `wacli_${VERSION}_windows_amd64.zip`,
      url: `${RELEASE_BASE}/wacli_${VERSION}_windows_amd64.zip`,
      sha256: "7b7f760db4ab6f25233e24316348fa6ddaeea9122e6fdf4335ba779f710a981e",
      sizeBytes: 9_504_879,
      archive: "zip",
      executableRelativePath: "wacli.exe",
    },
    // Upstream publishes no Windows Arm64 build of this release.
    "win32-arm64": null,
  },
};

/**
 * The manifest in force. A reference rather than a constant read so a test can pin a small
 * local artifact and exercise the real install path.
 */
export const WacliManifestRef = Context.Reference<WacliManifest>(
  "t3/scient/whatsapp/WacliManifest",
  { defaultValue: () => WACLI_MANIFEST },
);

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};
const ARCH_NAMES: Partial<Record<NodeJS.Architecture, string>> = { arm64: "Arm64", x64: "x64" };

export type WacliAssetLookup =
  | { readonly supported: true; readonly asset: WacliAsset }
  | { readonly supported: false; readonly message: string };

/**
 * The pinned asset for this platform and architecture, or a refusal a person can read.
 * Platform and architecture are looked up together so an Arm64 machine is never handed an x64
 * binary.
 */
export function resolveWacliAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  manifest: WacliManifest = WACLI_MANIFEST,
): WacliAssetLookup {
  const platformArch = `${platform}-${arch}`;
  const asset = isWacliPlatformArch(platformArch) ? manifest.assets[platformArch] : null;
  if (asset != null) return { supported: true, asset };
  return {
    supported: false,
    message: `WhatsApp linking is not available on ${PLATFORM_NAMES[platform] ?? platform} ${
      ARCH_NAMES[arch] ?? arch
    } yet.`,
  };
}
