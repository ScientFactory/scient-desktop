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

export interface TinyTexManifest {
  readonly version: string;
  readonly assets: {
    readonly win32: TinyTexAsset | null;
    readonly darwin: TinyTexAsset | null;
    readonly linux: TinyTexAsset | null;
  };
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
    win32: {
      fileName: `TinyTeX-1-windows-v${VERSION}.exe`,
      url: `${RELEASE_BASE}/TinyTeX-1-windows-v${VERSION}.exe`,
      sha256: "d0abe3db92f7003a716bf9db0fbc103689bc91a42b0729664a0675be16e4f636",
      sizeBytes: 73_670_669,
      archive: "seven-zip-sfx",
      executableRelativePath: "TinyTeX/bin/windows/latexmk.exe",
    },
    // TODO(scient-latex): CI must pin the macOS and Linux digests before those
    // platforms offer a managed install. The assets are
    // `TinyTeX-1-darwin-v<version>.tar.xz` and
    // `TinyTeX-1-linux-{x86_64,arm64}-v<version>.tar.xz`, the unpacker already
    // has a `tar-xz` path, and the executable sits at
    // `TinyTeX/bin/<arch>-<os>/latexmk`, which is arch-specific and has to be
    // pinned per asset rather than guessed. Until then `install` refuses with
    // `unsupported-platform` and the client keeps showing install instructions.
    darwin: null,
    linux: null,
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

/** The pinned asset for this computer, or `null` when Scient has none for it. */
export function resolveTinyTexAsset(
  platform: NodeJS.Platform,
  manifest: TinyTexManifest = TINYTEX_MANIFEST,
): TinyTexAsset | null {
  if (platform === "win32") return manifest.assets.win32;
  if (platform === "darwin") return manifest.assets.darwin;
  if (platform === "linux") return manifest.assets.linux;
  return null;
}
