// @effect-diagnostics nodeBuiltinImport:off - Release artifact tests use isolated temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { verifyScientReleaseAssets } from "./verify-scient-release-assets.ts";

function sha512(value: string): string {
  return NodeCrypto.createHash("sha512").update(value).digest("base64");
}

function writeManifest(
  root: string,
  name: string,
  version: string,
  entries: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly extras?: Readonly<Record<string, string | number | boolean>>;
  }>,
): void {
  const lines = [`version: '${version}'`, "files:"];
  for (const entry of entries) {
    NodeFS.writeFileSync(NodePath.join(root, entry.name), entry.value);
    lines.push(`  - url: ${entry.name}`);
    lines.push(`    sha512: ${sha512(entry.value)}`);
    lines.push(`    size: ${Buffer.byteLength(entry.value)}`);
    for (const [key, value] of Object.entries(entry.extras ?? {})) {
      lines.push(`    ${key}: ${value}`);
    }
  }
  lines.push(`path: ${entries[0]?.name ?? "missing"}`);
  lines.push(`sha512: ${entries[0] ? sha512(entries[0].value) : "missing"}`);
  lines.push("releaseDate: '2026-08-10T00:00:00.000Z'", "");
  NodeFS.writeFileSync(NodePath.join(root, name), lines.join("\n"));
}

function createValidFixture(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-release-assets-"));
  const version = "0.6.0";
  writeManifest(root, "latest-mac.yml", version, [
    { name: `Scient-${version}-arm64.dmg`, value: "arm-dmg" },
    { name: `Scient-${version}-arm64.zip`, value: "arm-zip" },
    { name: `Scient-${version}-x64.dmg`, value: "x64-dmg" },
    { name: `Scient-${version}-x64.zip`, value: "x64-zip" },
  ]);
  writeManifest(root, "latest.yml", version, [
    { name: `Scient-${version}-x64.exe`, value: "windows" },
  ]);
  NodeFS.writeFileSync(
    NodePath.join(root, `Scient-${version}-x64.exe.blockmap`),
    "windows-blockmap",
  );
  writeManifest(root, "latest-linux.yml", version, [
    {
      name: `Scient-${version}-x86_64.AppImage`,
      value: "linux",
      extras: { blockMapSize: 8 },
    },
  ]);
  for (const name of [
    `Scient-${version}-arm64.dmg.blockmap`,
    `Scient-${version}-arm64.zip.blockmap`,
    `Scient-${version}-x64.dmg.blockmap`,
    `Scient-${version}-x64.zip.blockmap`,
  ]) {
    NodeFS.writeFileSync(NodePath.join(root, name), "blockmap");
  }
  NodeFS.writeFileSync(NodePath.join(root, `scient-server-${version}.tgz`), "server");
  return root;
}

describe("Scient release asset verification", () => {
  it("accepts one complete, manifest-attested cross-platform release set", () => {
    const root = createValidFixture();
    try {
      const result = verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]);
      assert.equal(result.version, "0.6.0");
      assert(result.assets.includes("Scient-0.6.0-arm64.dmg"));
      assert(result.assets.includes("Scient-0.6.0-x64.exe"));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a payload changed after its update manifest was written", () => {
    const root = createValidFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(root, "Scient-0.6.0-x64.exe"), "changed");
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]),
        "failed size or SHA-512 verification",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete and non-canonical release inputs", () => {
    const root = createValidFixture();
    try {
      NodeFS.rmSync(NodePath.join(root, "Scient-0.6.0-arm64.zip"));
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]),
        "Missing macOS update payload",
      );
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "00.6.0"]),
        "canonical x.y.z",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unattested blockmap and unexpected ordinary files", () => {
    const root = createValidFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(root, "stray.blockmap"), "stray");
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]),
        "unattested blockmap",
      );
      NodeFS.rmSync(NodePath.join(root, "stray.blockmap"));
      NodeFS.writeFileSync(NodePath.join(root, "builder-debug.yml"), "internal");
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]),
        "unexpected or unattested files",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
