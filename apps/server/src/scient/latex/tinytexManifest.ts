/**
 * Pin every TinyTeX release digest; runtime latest pointers or retags cannot select new bytes. Key
 * assets by platform and architecture, with explicit unsupported slots, so Arm64 cannot silently
 * receive x64 binaries. The base distribution supports later managed package expansion.
 */

import * as Context from "effect/Context";

/**
 * Try system tar for Windows seven-zip-sfx, then only its verified self-extractor if needed.
 * macOS/Linux use tar-xz; keep this format aligned with LatexArchiveUnpacker.
 */
export type TinyTexArchiveKind = "seven-zip-sfx" | "tar-xz";

export interface TinyTexAsset {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  /** Exact byte count of the pinned asset; a download that disagrees is rejected. */
  readonly sizeBytes: number;
  readonly archive: TinyTexArchiveKind;
  /** Path of `latexmk` inside the unpacked tree, relative to the install root. */
  readonly executableRelativePath: string;
}

/**
 * Every platform/architecture pair Scient recognizes. Not every pair has a
 * pinned asset yet — see {@link TINYTEX_MANIFEST} — but every pair this app
 * might run on has a slot here, pinned or not.
 */
export type TinyTexPlatformArch =
  | "win32-x64"
  | "win32-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64";

const TINYTEX_PLATFORM_ARCHES: ReadonlyArray<TinyTexPlatformArch> = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

function isTinyTexPlatformArch(value: string): value is TinyTexPlatformArch {
  return (TINYTEX_PLATFORM_ARCHES as ReadonlyArray<string>).includes(value);
}

/** `"win32-x64"`-style key for whatever platform/architecture pair is asked about. */
function tinyTexPlatformArchKey(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  return `${platform}-${arch}`;
}

export interface TinyTexManifest {
  readonly version: string;
  readonly assets: Readonly<Record<TinyTexPlatformArch, TinyTexAsset | null>>;
}

const VERSION = "2026.08";
const RELEASE_BASE = `https://github.com/rstudio/tinytex-releases/releases/download/v${VERSION}`;

/**
 * Release downloads redirect once, into GitHub's asset CDN. Every hop is
 * checked against this list, and the digest check behind it is what actually
 * decides whether the bytes are the reviewed ones.
 */
export const TINYTEX_ALLOWED_HOSTS: ReadonlyArray<string> = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

export const TINYTEX_MANIFEST: TinyTexManifest = {
  version: VERSION,
  assets: {
    "win32-x64": {
      fileName: `TinyTeX-1-windows-v${VERSION}.exe`,
      url: `${RELEASE_BASE}/TinyTeX-1-windows-v${VERSION}.exe`,
      sha256: "d0abe3db92f7003a716bf9db0fbc103689bc91a42b0729664a0675be16e4f636",
      sizeBytes: 73_670_669,
      archive: "seven-zip-sfx",
      executableRelativePath: "TinyTeX/bin/windows/latexmk.exe",
    },
    "darwin-x64": {
      fileName: `TinyTeX-1-darwin-v${VERSION}.tar.xz`,
      url: `${RELEASE_BASE}/TinyTeX-1-darwin-v${VERSION}.tar.xz`,
      sha256: "dd22ffdf1063eff79cadcff45de1f24e8546edf508ab402dc9f87ec2f3367344",
      sizeBytes: 67_051_368,
      archive: "tar-xz",
      executableRelativePath: "TinyTeX/bin/universal-darwin/latexmk",
    },
    // Upstream's Darwin bundle is universal and contains one universal-darwin
    // engine tree, so both Apple architectures intentionally share this pin.
    "darwin-arm64": {
      fileName: `TinyTeX-1-darwin-v${VERSION}.tar.xz`,
      url: `${RELEASE_BASE}/TinyTeX-1-darwin-v${VERSION}.tar.xz`,
      sha256: "dd22ffdf1063eff79cadcff45de1f24e8546edf508ab402dc9f87ec2f3367344",
      sizeBytes: 67_051_368,
      archive: "tar-xz",
      executableRelativePath: "TinyTeX/bin/universal-darwin/latexmk",
    },
    "linux-x64": {
      fileName: `TinyTeX-1-linux-x86_64-v${VERSION}.tar.xz`,
      url: `${RELEASE_BASE}/TinyTeX-1-linux-x86_64-v${VERSION}.tar.xz`,
      sha256: "6bcde65cbbc147d6e492fa105a7210a06792d609358ef74a14a95228e3e36656",
      sizeBytes: 53_980_584,
      archive: "tar-xz",
      executableRelativePath: ".TinyTeX/bin/x86_64-linux/latexmk",
    },
    // Pin only archives actually downloaded and hashed from
    // https://github.com/rstudio/tinytex-releases. Never use placeholder digests or guess
    // architecture-specific executable paths; unpinned pairs must refuse upfront as unsupported.
    "win32-arm64": null,
    "linux-arm64": null,
  },
};

/**
 * The manifest in force. It is a reference rather than a constant read so a
 * test can pin a small local artifact and exercise the real install path.
 */
export const TinyTexManifestRef = Context.Reference<TinyTexManifest>(
  "t3/scient/latex/TinyTexManifest",
  { defaultValue: () => TINYTEX_MANIFEST },
);

export interface TinyTexAssetPinned {
  readonly supported: true;
  readonly asset: TinyTexAsset;
}

export interface TinyTexAssetUnsupported {
  readonly supported: false;
  /** `"<platform>-<arch>"`, e.g. `"win32-arm64"`, whether or not Scient tracks the pair at all. */
  readonly platformArch: string;
  /** Names the pair, so a caller need not build its own message to be honest with the user. */
  readonly message: string;
}

/**
 * Return a typed refusal naming platform/architecture, not null, so setup can explain exactly which
 * pair lacks a pinned install.
 */
export type TinyTexAssetLookup = TinyTexAssetPinned | TinyTexAssetUnsupported;

/**
 * The pinned asset for this platform/architecture pair, or a typed refusal
 * naming it. `arch` matters as much as `platform`: an Arm64 machine asking
 * under its own architecture must never be handed an x64 binary, so the two
 * are looked up together rather than one gating the other.
 */
export function resolveTinyTexAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  manifest: TinyTexManifest = TINYTEX_MANIFEST,
): TinyTexAssetLookup {
  const platformArch = tinyTexPlatformArchKey(platform, arch);
  const asset = isTinyTexPlatformArch(platformArch) ? manifest.assets[platformArch] : null;
  if (asset != null) return { supported: true, asset };
  return {
    supported: false,
    platformArch,
    message: `Scient has not pinned a LaTeX distribution for ${platformArch} yet.`,
  };
}
