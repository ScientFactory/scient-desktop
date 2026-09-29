/**
 * The one Pandoc release Scient is willing to install, pinned by digest.
 *
 * Word export runs the official Pandoc binary as a separate program. Scient
 * downloads it on first use into app-owned state, exactly as it installs
 * TinyTeX for LaTeX: nothing resolves a "latest" pointer at runtime, so an
 * upstream re-tag cannot change what this app runs. Bumping the release means
 * re-pinning every digest below and re-running the Pandoc qualification.
 *
 * Pandoc publishes no checksum file; the sizes and SHA-256 digests here are
 * the release's GitHub upload digests, re-checked by hashing the downloaded
 * archives during qualification (macOS arm64 downloaded and run; the other
 * archives' layouts come from the release build scripts of the same tag and
 * are proven on each platform by the `--version` check after unpacking).
 *
 * Every platform/architecture pair Scient might run on has a slot, pinned or
 * not: upstream ships no Windows Arm64 build, so that pair is `null` and is
 * reported as unavailable rather than handed the x64 binary.
 */
import * as Context from "effect/Context";

/** `zip` for macOS and Windows, `tar-gz` for Linux; both expand with the system `tar`. */
export type PandocArchiveKind = "zip" | "tar-gz";

export interface PandocAsset {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  /** Exact byte count of the pinned archive; a download that disagrees is rejected. */
  readonly sizeBytes: number;
  readonly archive: PandocArchiveKind;
  /** Path of the `pandoc` executable inside the unpacked tree. */
  readonly executableRelativePath: string;
}

export type PandocPlatformArch =
  | "win32-x64"
  | "win32-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64";

export const PANDOC_PLATFORM_ARCHES: ReadonlyArray<PandocPlatformArch> = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

function isPandocPlatformArch(value: string): value is PandocPlatformArch {
  return (PANDOC_PLATFORM_ARCHES as ReadonlyArray<string>).includes(value);
}

export interface PandocManifest {
  readonly version: string;
  /** The release's licence, shown with the install; the notice itself is in the licence list. */
  readonly license: string;
  /** Where the exact source of this release is published. */
  readonly sourceUrl: string;
  readonly assets: Readonly<Record<PandocPlatformArch, PandocAsset | null>>;
}

const VERSION = "3.11";
const RELEASE_BASE = `https://github.com/jgm/pandoc/releases/download/${VERSION}`;

/**
 * Release downloads redirect once into GitHub's asset CDN. Every hop is
 * checked against this list; the digest check is what decides whether the
 * bytes are the reviewed ones.
 */
export const PANDOC_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

/** Where the matching source of the pinned release is published. */
export const PANDOC_SOURCE_URL = `https://github.com/jgm/pandoc/archive/refs/tags/${VERSION}.tar.gz`;

export const PANDOC_MANIFEST: PandocManifest = {
  version: VERSION,
  license: "GPL-2.0-or-later",
  sourceUrl: PANDOC_SOURCE_URL,
  assets: {
    "darwin-arm64": {
      fileName: `pandoc-${VERSION}-arm64-macOS.zip`,
      url: `${RELEASE_BASE}/pandoc-${VERSION}-arm64-macOS.zip`,
      sha256: "15806bedf9517bfead72e88fe6a6696635c3691efbb6e152173440e9c5bb50b4",
      sizeBytes: 41_832_712,
      archive: "zip",
      executableRelativePath: `pandoc-${VERSION}-arm64/bin/pandoc`,
    },
    "darwin-x64": {
      fileName: `pandoc-${VERSION}-x86_64-macOS.zip`,
      url: `${RELEASE_BASE}/pandoc-${VERSION}-x86_64-macOS.zip`,
      sha256: "3b1c1b57f160112c821d02f23d946ede8b7f57a6ccf4632a25a512d334a9291f",
      sizeBytes: 26_145_603,
      archive: "zip",
      executableRelativePath: `pandoc-${VERSION}-x86_64/bin/pandoc`,
    },
    "win32-x64": {
      fileName: `pandoc-${VERSION}-windows-x86_64.zip`,
      url: `${RELEASE_BASE}/pandoc-${VERSION}-windows-x86_64.zip`,
      sha256: "2ab72baf2399450e148ddf7a2a8689806c42e1bba71862b57e220fd9b8456d3d",
      sizeBytes: 41_761_100,
      archive: "zip",
      executableRelativePath: `pandoc-${VERSION}/pandoc.exe`,
    },
    "linux-x64": {
      fileName: `pandoc-${VERSION}-linux-amd64.tar.gz`,
      url: `${RELEASE_BASE}/pandoc-${VERSION}-linux-amd64.tar.gz`,
      sha256: "37edb3bbcf722f921a009941bf5874e2e0c09263226c9b4a2d980788cb062ab6",
      sizeBytes: 34_940_580,
      archive: "tar-gz",
      executableRelativePath: `pandoc-${VERSION}/bin/pandoc`,
    },
    "linux-arm64": {
      fileName: `pandoc-${VERSION}-linux-arm64.tar.gz`,
      url: `${RELEASE_BASE}/pandoc-${VERSION}-linux-arm64.tar.gz`,
      sha256: "56ed5566ec41d22ec9ee0704e6ac0b98ba102e92384efd5306173a22d314c79a",
      sizeBytes: 37_408_185,
      archive: "tar-gz",
      executableRelativePath: `pandoc-${VERSION}/bin/pandoc`,
    },
    // Upstream publishes no Windows Arm64 build of this release.
    "win32-arm64": null,
  },
};

/**
 * The manifest in force. A reference rather than a constant read so a test can
 * pin a small local artifact and exercise the real install path.
 */
export const PandocManifestRef = Context.Reference<PandocManifest>(
  "t3/scient/pandoc/PandocManifest",
  { defaultValue: () => PANDOC_MANIFEST },
);

export type PandocAssetLookup =
  | { readonly supported: true; readonly asset: PandocAsset }
  | {
      readonly supported: false;
      /** `"<platform>-<arch>"`, whether or not Scient tracks the pair at all. */
      readonly platformArch: string;
      readonly message: string;
    };

/**
 * The pinned asset for this platform and architecture, or a refusal naming the
 * pair. Platform and architecture are looked up together so an Arm64 machine
 * is never handed an x64 binary.
 */
export function resolvePandocAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  manifest: PandocManifest = PANDOC_MANIFEST,
): PandocAssetLookup {
  const platformArch = `${platform}-${arch}`;
  const asset = isPandocPlatformArch(platformArch) ? manifest.assets[platformArch] : null;
  if (asset != null) return { supported: true, asset };
  return {
    supported: false,
    platformArch,
    message: `Pandoc ${manifest.version} is not available for ${platformArch}, so Word export cannot run on this computer.`,
  };
}
