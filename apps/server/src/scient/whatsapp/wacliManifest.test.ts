// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Reads the repository's licence notice configuration.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import { artifactUrlRejection } from "../latex/LatexManagedToolchain.ts";
import {
  WACLI_ALLOWED_HOSTS,
  WACLI_MANIFEST,
  WACLI_PLATFORM_ARCHES,
  WACLI_SOURCE_URL,
  resolveWacliAsset,
} from "./wacliManifest.ts";

describe("WACLI_MANIFEST", () => {
  it("pins wacli 0.26.1 from the official release over HTTPS, by size and digest", () => {
    for (const platformArch of WACLI_PLATFORM_ARCHES) {
      const asset = WACLI_MANIFEST.assets[platformArch];
      if (asset === null) continue;
      expect(asset.url).toBe(
        `https://github.com/openclaw/wacli/releases/download/v0.26.1/${asset.fileName}`,
      );
      expect(artifactUrlRejection(asset.url, WACLI_ALLOWED_HOSTS)).toBeNull();
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.sizeBytes).toBeGreaterThan(5_000_000);
      expect(asset.executableRelativePath).toBe(
        platformArch.startsWith("win32") ? "wacli.exe" : "wacli",
      );
      expect(asset.archive).toBe(platformArch.startsWith("win32") ? "zip" : "tar-gz");
    }
    expect(WACLI_MANIFEST.assets["win32-arm64"]).toBeNull();
  });

  it("lists wacli in the licence notices with the pinned release's exact source", () => {
    const repositoryRoot = new URL("../../../../../", import.meta.url);
    const config = JSON.parse(
      NodeFS.readFileSync(new URL("third-party-licenses.config.json", repositoryRoot), "utf8"),
    ) as {
      customNotices: ReadonlyArray<{
        name: string;
        license: string;
        version?: string;
        sourceUrl?: string;
      }>;
    };
    expect(config.customNotices.find((entry) => entry.name === "wacli")).toMatchObject({
      license: WACLI_MANIFEST.license,
      version: WACLI_MANIFEST.version,
      sourceUrl: WACLI_SOURCE_URL,
    });
    expect(WACLI_SOURCE_URL).toBe(
      "https://github.com/openclaw/wacli/archive/refs/tags/v0.26.1.tar.gz",
    );
  });
});

describe("resolveWacliAsset", () => {
  it("never hands one architecture another's binary", () => {
    const lookup = resolveWacliAsset("darwin", "x64");
    expect(lookup.supported && lookup.asset.fileName).toBe("wacli_0.26.1_darwin_amd64.tar.gz");
    expect(resolveWacliAsset("win32", "arm64")).toEqual({
      supported: false,
      message: "WhatsApp linking is not available on Windows Arm64 yet.",
    });
    expect(resolveWacliAsset("freebsd", "x64")).toEqual({
      supported: false,
      message: "WhatsApp linking is not available on freebsd x64 yet.",
    });
  });
});
