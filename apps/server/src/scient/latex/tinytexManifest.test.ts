import { describe, expect, it } from "@effect/vitest";

import { TINYTEX_ALLOWED_HOSTS, TINYTEX_MANIFEST, resolveTinyTexAsset } from "./tinytexManifest.ts";

describe("tinytexManifest", () => {
  it("pins a Windows artifact by digest on an allowed HTTPS host", () => {
    const asset = TINYTEX_MANIFEST.assets.win32;
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
    expect(TINYTEX_MANIFEST.assets.win32?.executableRelativePath).toBe(
      "TinyTeX/bin/windows/latexmk.exe",
    );
    expect(TINYTEX_MANIFEST.assets.win32?.executableRelativePath.startsWith("/")).toBe(false);
    expect(TINYTEX_MANIFEST.assets.win32?.executableRelativePath).not.toContain("..");
  });

  it("offers no install where no digest has been pinned yet", () => {
    // macOS and Linux stay unavailable until CI pins their digests, which is
    // what makes `install` refuse rather than fetch something unreviewed.
    expect(resolveTinyTexAsset("darwin")).toBeNull();
    expect(resolveTinyTexAsset("linux")).toBeNull();
    expect(resolveTinyTexAsset("freebsd")).toBeNull();
    expect(resolveTinyTexAsset("win32")).toBe(TINYTEX_MANIFEST.assets.win32);
  });
});
