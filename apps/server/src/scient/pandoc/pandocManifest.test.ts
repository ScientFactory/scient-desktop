import { describe, expect, it } from "@effect/vitest";

import { artifactUrlRejection } from "../latex/LatexManagedToolchain.ts";
import {
  PANDOC_ALLOWED_HOSTS,
  PANDOC_MANIFEST,
  PANDOC_PLATFORM_ARCHES,
  PANDOC_SOURCE_URL,
  resolvePandocAsset,
} from "./pandocManifest.ts";

describe("PANDOC_MANIFEST", () => {
  it("pins Pandoc 3.11 from the official release over HTTPS, by size and digest", () => {
    expect(PANDOC_MANIFEST.version).toBe("3.11");
    for (const platformArch of PANDOC_PLATFORM_ARCHES) {
      const asset = PANDOC_MANIFEST.assets[platformArch];
      if (asset === null) continue;
      expect(asset.url.startsWith("https://github.com/jgm/pandoc/releases/download/3.11/")).toBe(
        true,
      );
      expect(asset.url.endsWith(`/${asset.fileName}`)).toBe(true);
      expect(artifactUrlRejection(asset.url, PANDOC_ALLOWED_HOSTS)).toBeNull();
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.sizeBytes).toBeGreaterThan(20_000_000);
      expect(asset.executableRelativePath.startsWith("pandoc-3.11")).toBe(true);
    }
    expect(PANDOC_SOURCE_URL).toBe("https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz");
  });

  it("names the executable where each release packs it", () => {
    expect(PANDOC_MANIFEST.assets["darwin-arm64"]?.executableRelativePath).toBe(
      "pandoc-3.11-arm64/bin/pandoc",
    );
    expect(PANDOC_MANIFEST.assets["darwin-x64"]?.executableRelativePath).toBe(
      "pandoc-3.11-x86_64/bin/pandoc",
    );
    expect(PANDOC_MANIFEST.assets["win32-x64"]?.executableRelativePath).toBe(
      "pandoc-3.11/pandoc.exe",
    );
    expect(PANDOC_MANIFEST.assets["linux-arm64"]?.archive).toBe("tar-gz");
  });
});

describe("resolvePandocAsset", () => {
  it("never hands one architecture another's binary", () => {
    const arm = resolvePandocAsset("darwin", "arm64");
    const intel = resolvePandocAsset("darwin", "x64");
    expect(arm.supported && intel.supported && arm.asset.sha256 !== intel.asset.sha256).toBe(true);
  });

  it("reports Windows on Arm and unknown platforms as unavailable, by name", () => {
    const windowsArm = resolvePandocAsset("win32", "arm64");
    expect(windowsArm).toEqual({
      supported: false,
      platformArch: "win32-arm64",
      message:
        "Pandoc 3.11 is not available for win32-arm64, so Word export cannot run on this computer.",
    });
    expect(resolvePandocAsset("freebsd", "x64").supported).toBe(false);
  });
});
