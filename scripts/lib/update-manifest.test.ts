// @effect-diagnostics nodeBuiltinImport:off - Manifest parser tests read committed format fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./update-manifest.ts";

const fixtureRoot = NodePath.resolve(import.meta.dirname, "../fixtures/release-manifests");

describe("update manifest parser", () => {
  it("parses manifests captured from Electron Builder 26.15.6", () => {
    const metadata = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixtureRoot, "metadata.json"), "utf8"),
    ) as { readonly electronBuilderVersion?: unknown };
    const desktopPackage = JSON.parse(
      NodeFS.readFileSync(
        NodePath.resolve(import.meta.dirname, "../../apps/desktop/package.json"),
        "utf8",
      ),
    ) as { readonly devDependencies?: Record<string, string> };

    assert.equal(metadata.electronBuilderVersion, "26.15.6");
    assert.equal(
      desktopPackage.devDependencies?.["electron-builder"],
      metadata.electronBuilderVersion,
    );

    const manifests = new Map(
      ["latest-mac.yml", "latest.yml", "latest-linux.yml"].map((name) => [
        name,
        parseUpdateManifest(
          NodeFS.readFileSync(NodePath.join(fixtureRoot, name), "utf8"),
          name,
          "fixture",
        ),
      ]),
    );
    for (const manifest of manifests.values()) {
      assert.equal(manifest.version, "0.6.0");
      assert(manifest.files.length > 0);
    }

    const linux = manifests.get("latest-linux.yml");
    assert(linux);
    assert.equal(linux.files[0]?.url, "Scient-0.6.0-x86_64.AppImage");
    assert.equal(linux.files[0]?.extras.blockMapSize, 189364);
  });

  it("preserves file-entry fields through merge and serialization", () => {
    const primary = parseUpdateManifest(
      `version: '0.6.0'
files:
  - url: Scient-0.6.0-x86_64.AppImage
    sha512: appimage
    size: 10
    blockMapSize: 4
releaseDate: '2026-08-10T00:00:00.000Z'
`,
      "primary",
      "Linux",
    );
    const secondary = parseUpdateManifest(
      `version: '0.6.0'
files:
  - url: Scient-0.6.0-arm64.AppImage
    sha512: arm64
    size: 11
    blockMapSize: 5
releaseDate: '2026-08-10T00:00:00.000Z'
`,
      "secondary",
      "Linux",
    );

    const merged = mergeUpdateManifests(primary, secondary, "Linux");
    const serialized = serializeUpdateManifest(merged, { platformLabel: "Linux" });
    const reparsed = parseUpdateManifest(serialized, "merged", "Linux");

    assert.equal(reparsed.files[0]?.extras.blockMapSize, 4);
    assert.equal(reparsed.files[1]?.extras.blockMapSize, 5);
  });
});
