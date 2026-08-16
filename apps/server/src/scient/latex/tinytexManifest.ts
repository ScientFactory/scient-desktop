/**
 * The one TinyTeX build Scient is willing to install, pinned by digest.
 *
 * TinyTeX is the LaTeX distribution this feature installs because it is small,
 * relocatable, and needs no elevation: the whole tree lives under a directory
 * Scient owns and can be deleted by deleting that directory. The `TinyTeX-1`
 * bundle is the one the project itself installs by default — TeX Live's
 * infrastructure plus roughly a hundred common packages — and it is a base to
 * build on rather than a complete distribution: the install fetches the
 * recommended LaTeX and font collections on top of it, and a build that still
 * meets a package neither of those carries installs it before compiling
 * again. What the bundle guarantees is the infrastructure that makes both of
 * those possible without elevation.
 *
 * Every asset here was downloaded once and hashed by hand; nothing resolves a
 * "latest" pointer at runtime, so an upstream re-tag cannot change what this
 * app installs. Bumping the release means re-pinning every digest below.
 *
 * The table is keyed by platform *and* architecture, not platform alone:
 * TinyTeX ships a distinct archive per architecture (an Apple Silicon Mac does
 * not run an Intel `tar.xz`, and an Arm64 Windows box does not run the x64
 * installer), so a table that only knew `win32`/`darwin`/`linux` could either
 * hand an Arm64 machine an x64 binary it cannot run, or claim support it does
 * not have. Every pair Scient might see is listed explicitly, even the ones
 * pinned to `null`, so a lookup for an unlisted pair is a bug in this file
 * rather than a silent `undefined`.
 */

import * as Context from "effect/Context";

/**
 * How the pinned asset is packed. `seven-zip-sfx` is upstream's Windows
 * format: a 7-Zip archive behind an executable stub. Scient reads the payload
 * out of it and never runs the stub. `tar-xz` is the macOS/Linux format.
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

export const TINYTEX_PLATFORM_ARCHES: ReadonlyArray<TinyTexPlatformArch> = [
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
export function tinyTexPlatformArchKey(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
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
    // TODO(scient-latex): CI must pin each remaining digest, from the
    // official release at https://github.com/rstudio/tinytex-releases,
    // before its platform offers a managed install. Do not pin a hash here
    // that has not been downloaded and hashed by hand — a placeholder digest
    // is worse than no install, because it would fail the checksum check
    // against real bytes instead of refusing up front. The unpacker already
    // has a `tar-xz` path for the non-Windows assets, and the executable
    // sits at `TinyTeX/bin/<arch>-<os>/latexmk`, which is architecture-
    // specific and has to be pinned per asset rather than guessed. Until a
    // pair is pinned, `resolveTinyTexAsset` reports it as unsupported by
    // name and `install` refuses accordingly.
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
 * What a lookup answers: the pinned asset, or a typed refusal that names the
 * exact pair it refused. Nothing here collapses to `null` — the old shape
 * this replaces — because `null` cannot say *which* platform and
 * architecture had nothing pinned, and a setup card that only knows "no
 * install available" cannot tell a user anything more honest than that.
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
