import { describe, expect, it } from "@effect/vitest";

import {
  TINYTEX_ALLOWED_HOSTS,
  TINYTEX_MANIFEST,
  TINYTEX_PLATFORM_ARCHES,
  resolveTinyTexAsset,
} from "./tinytexManifest.ts";

describe("tinytexManifest", () => {
  it("pins a Windows x64 artifact by digest on an allowed HTTPS host", () => {
    const asset = TINYTEX_MANIFEST.assets["win32-x64"];
    expect(asset).not.toBeNull();
    // Nothing here may be resolved at runtime: an upstream re-tag must not be
    // able to change what this app installs.
    expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(asset?.sizeBytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(asset?.sizeBytes)).toBe(true);
    expect(asset?.archive).toBe("seven-zip-sfx");

    const url = new URL(asset?.url ?? "");
    expect(url.protocol).toBe("https:");
    expect(TINYTEX_ALLOWED_HOSTS).toContain(url.hostname);
    expect(url.pathname).toContain(TINYTEX_MANIFEST.version);
  });

  it("names the engine by a relative path inside the unpacked tree", () => {
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath).toBe(
      "TinyTeX/bin/windows/latexmk.exe",
    );
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath.startsWith("/")).toBe(
      false,
    );
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath).not.toContain("..");
  });

  it("lists every platform/architecture pair explicitly, pinned or not", () => {
    // Every pair Scient might run on is a named slot in the manifest — never a
    // gap that would silently read as `undefined` rather than "not pinned".
    for (const platformArch of TINYTEX_PLATFORM_ARCHES) {
      expect(Object.hasOwn(TINYTEX_MANIFEST.assets, platformArch)).toBe(true);
    }
    expect(TINYTEX_PLATFORM_ARCHES).toEqual([
      "win32-x64",
      "win32-arm64",
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
    ]);
  });

  it("resolves the pinned pair", () => {
    const lookup = resolveTinyTexAsset("win32", "x64");
    expect(lookup.supported).toBe(true);
    expect(lookup.supported && lookup.asset).toBe(TINYTEX_MANIFEST.assets["win32-x64"]);
  });

  it("names the exact pair when nothing is pinned for it yet", () => {
    // macOS and Linux stay unavailable until CI pins their digests, which is
    // what makes `install` refuse rather than fetch something unreviewed —
    // and the refusal names the pair rather than saying only "unsupported".
    const darwinArm = resolveTinyTexAsset("darwin", "arm64");
    expect(darwinArm).toEqual({
      supported: false,
      platformArch: "darwin-arm64",
      message: "Scient has not pinned a LaTeX distribution for darwin-arm64 yet.",
    });

    const darwinX64 = resolveTinyTexAsset("darwin", "x64");
    expect(darwinX64.supported).toBe(false);
    expect(!darwinX64.supported && darwinX64.platformArch).toBe("darwin-x64");

    const linuxX64 = resolveTinyTexAsset("linux", "x64");
    expect(linuxX64.supported).toBe(false);
    expect(!linuxX64.supported && linuxX64.platformArch).toBe("linux-x64");

    const linuxArm = resolveTinyTexAsset("linux", "arm64");
    expect(linuxArm.supported).toBe(false);
    expect(!linuxArm.supported && linuxArm.platformArch).toBe("linux-arm64");

    const winArm = resolveTinyTexAsset("win32", "arm64");
    expect(winArm.supported).toBe(false);
    expect(!winArm.supported && winArm.platformArch).toBe("win32-arm64");
  });

  it("names an unrecognized pair the same honest way, rather than crashing", () => {
    const lookup = resolveTinyTexAsset("freebsd", "x64");
    expect(lookup).toEqual({
      supported: false,
      platformArch: "freebsd-x64",
      message: "Scient has not pinned a LaTeX distribution for freebsd-x64 yet.",
    });
  });

  it("keys the same architecture differently under different platforms", () => {
    // An x64 lookup on win32 must never answer with a pin made for x64 under
    // a different platform, or vice versa.
    const win = resolveTinyTexAsset("win32", "x64");
    const linux = resolveTinyTexAsset("linux", "x64");
    expect(win.supported).toBe(true);
    expect(linux.supported).toBe(false);
  });
});
