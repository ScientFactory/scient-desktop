import { describe, expect, it } from "@effect/vitest";

import {
  TINYTEX_ALLOWED_HOSTS,
  TINYTEX_MANIFEST,
  TINYTEX_PLATFORM_ARCHES,
  resolveTinyTexAsset,
} from "./tinytexManifest.ts";

describe("tinytexManifest", () => {
  it("pins every supported artifact by digest on an allowed HTTPS host", () => {
    for (const platformArch of ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"] as const) {
      const asset = TINYTEX_MANIFEST.assets[platformArch];
      expect(asset).not.toBeNull();
      // Nothing here may be resolved at runtime: an upstream re-tag must not be
      // able to change what this app installs.
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(asset?.sizeBytes).toBeGreaterThan(0);
      expect(Number.isSafeInteger(asset?.sizeBytes)).toBe(true);

      const url = new URL(asset?.url ?? "");
      expect(url.protocol).toBe("https:");
      expect(TINYTEX_ALLOWED_HOSTS).toContain(url.hostname);
      expect(url.pathname).toContain(TINYTEX_MANIFEST.version);
    }
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.archive).toBe("seven-zip-sfx");
    expect(TINYTEX_MANIFEST.assets["darwin-x64"]?.archive).toBe("tar-xz");
    expect(TINYTEX_MANIFEST.assets["darwin-arm64"]?.archive).toBe("tar-xz");
    expect(TINYTEX_MANIFEST.assets["linux-x64"]?.archive).toBe("tar-xz");
  });

  it("names the engine by a relative path inside the unpacked tree", () => {
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath).toBe(
      "TinyTeX/bin/windows/latexmk.exe",
    );
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath.startsWith("/")).toBe(
      false,
    );
    expect(TINYTEX_MANIFEST.assets["win32-x64"]?.executableRelativePath).not.toContain("..");
    expect(TINYTEX_MANIFEST.assets["darwin-x64"]?.executableRelativePath).toBe(
      "TinyTeX/bin/universal-darwin/latexmk",
    );
    expect(TINYTEX_MANIFEST.assets["linux-x64"]?.executableRelativePath).toBe(
      ".TinyTeX/bin/x86_64-linux/latexmk",
    );
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

  it("resolves every pinned platform pair", () => {
    for (const [platform, arch, platformArch] of [
      ["win32", "x64", "win32-x64"],
      ["darwin", "x64", "darwin-x64"],
      ["darwin", "arm64", "darwin-arm64"],
      ["linux", "x64", "linux-x64"],
    ] as const) {
      const lookup = resolveTinyTexAsset(platform, arch);
      expect(lookup.supported).toBe(true);
      expect(lookup.supported && lookup.asset).toBe(TINYTEX_MANIFEST.assets[platformArch]);
    }
  });

  it("names the exact pair when nothing is pinned for it yet", () => {
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
    expect(linux.supported).toBe(true);
    if (!win.supported || !linux.supported) throw new Error("expected pinned assets");
    expect(win.asset).not.toBe(linux.asset);
  });
});
