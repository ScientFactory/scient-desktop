// @effect-diagnostics nodeBuiltinImport:off - Release artifact tests use isolated temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";

import { createFixtureBlockmap as blockmap } from "./lib/update-blockmap.ts";
import { verifyScientReleaseAssets } from "./verify-scient-release-assets.ts";

function sha512(value: string): string {
  return NodeCrypto.createHash("sha512").update(value).digest("base64");
}

// What the native Windows verifier reports for the fixture's installer.
const windowsInstallerSha256 = NodeCrypto.createHash("sha256").update("windows").digest("hex");

function verify(root: string, version = "0.6.0", ...extra: ReadonlyArray<string>) {
  return verifyScientReleaseAssets([
    "--assets-dir",
    root,
    "--version",
    version,
    "--windows-installer-sha256",
    windowsInstallerSha256,
    ...extra,
  ]);
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

function createValidFixture(version = "0.6.0", channel = "latest"): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-release-assets-"));
  writeManifest(root, `${channel}-mac.yml`, version, [
    { name: `Scient-${version}-arm64.dmg`, value: "arm-dmg" },
    { name: `Scient-${version}-arm64.zip`, value: "arm-zip" },
    { name: `Scient-${version}-x64.dmg`, value: "x64-dmg" },
    { name: `Scient-${version}-x64.zip`, value: "x64-zip" },
  ]);
  writeManifest(root, `${channel}.yml`, version, [
    { name: `Scient-${version}-x64.exe`, value: "windows" },
  ]);
  NodeFS.writeFileSync(
    NodePath.join(root, `Scient-${version}-x64.exe.blockmap`),
    blockmap("windows"),
  );
  writeManifest(root, `${channel}-linux.yml`, version, [
    {
      name: `Scient-${version}-x86_64.AppImage`,
      value: "linux",
      extras: { blockMapSize: 8 },
    },
  ]);
  for (const [name, value] of [
    [`Scient-${version}-arm64.dmg`, "arm-dmg"],
    [`Scient-${version}-arm64.zip`, "arm-zip"],
    [`Scient-${version}-x64.dmg`, "x64-dmg"],
    [`Scient-${version}-x64.zip`, "x64-zip"],
  ] as const) {
    NodeFS.writeFileSync(NodePath.join(root, `${name}.blockmap`), blockmap(value));
  }
  NodeFS.writeFileSync(NodePath.join(root, `scient-server-${version}.tgz`), "server");
  return root;
}

describe("Scient release asset verification", () => {
  it("accepts one complete, manifest-attested cross-platform release set", () => {
    const root = createValidFixture();
    try {
      const result = verify(root);
      assert.equal(result.version, "0.6.0");
      assert(result.assets.includes("Scient-0.6.0-arm64.dmg"));
      assert(result.assets.includes("Scient-0.6.0-x64.exe"));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts Beta manifests only in the Beta lane and rejects stable-feed contamination", () => {
    const version = "0.6.23-beta.20261010.1";
    const root = createValidFixture(version, "beta");
    try {
      assert.throws(() => verify(root, version), "Stable releases require");
      assert.equal(verify(root, version, "--channel", "beta").version, version);
      NodeFS.copyFileSync(NodePath.join(root, "beta.yml"), NodePath.join(root, "latest.yml"));
      assert.throws(
        () => verify(root, version, "--channel", "beta"),
        "unexpected or unattested files",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a payload changed after its update manifest was written", () => {
    const root = createValidFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(root, "Scient-0.6.0-x64.exe"), "changed");
      assert.throws(() => verify(root), "failed size or SHA-512 verification");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a Windows installer other than the one the native verifier checked", () => {
    const root = createValidFixture();
    try {
      const checked = NodeCrypto.createHash("sha256").update("an earlier build").digest("hex");
      assert.throws(
        () =>
          verifyScientReleaseAssets([
            "--assets-dir",
            root,
            "--version",
            "0.6.0",
            "--windows-installer-sha256",
            checked,
          ]),
        "not the installer the native Windows verifier checked",
      );
      assert.throws(
        () => verifyScientReleaseAssets(["--assets-dir", root, "--version", "0.6.0"]),
        "--windows-installer-sha256 is required",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete and non-canonical release inputs", () => {
    const root = createValidFixture();
    try {
      NodeFS.rmSync(NodePath.join(root, "Scient-0.6.0-arm64.zip"));
      assert.throws(() => verify(root), "Missing macOS update payload");
      assert.throws(() => verify(root, "00.6.0"), "canonical x.y.z");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unattested blockmap and unexpected ordinary files", () => {
    const root = createValidFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(root, "stray.blockmap"), "stray");
      assert.throws(() => verify(root), "unattested blockmap");
      NodeFS.rmSync(NodePath.join(root, "stray.blockmap"));
      NodeFS.writeFileSync(
        NodePath.join(root, "scient-server-0.6.0.tgz.blockmap"),
        blockmap("server"),
      );
      assert.throws(() => verify(root), "unattested blockmap");
      NodeFS.rmSync(NodePath.join(root, "scient-server-0.6.0.tgz.blockmap"));
      NodeFS.writeFileSync(NodePath.join(root, "builder-debug.yml"), "internal");
      assert.throws(() => verify(root), "unexpected or unattested files");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a blockmap for a file a manifest lists but the updater never maps", () => {
    const root = createValidFixture();
    try {
      writeManifest(root, "latest.yml", "0.6.0", [
        { name: "Scient-0.6.0-x64.exe", value: "windows" },
        { name: "scient-server-0.6.0.tgz", value: "server" },
      ]);
      NodeFS.writeFileSync(
        NodePath.join(root, "scient-server-0.6.0.tgz.blockmap"),
        blockmap("server"),
      );
      assert.throws(() => verify(root), "unattested blockmap");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the blockmaps of the Windows installer and macOS updater ZIPs", () => {
    for (const [payload, label] of [
      ["Scient-0.6.0-x64.exe", "Windows"],
      ["Scient-0.6.0-arm64.zip", "macOS"],
      ["Scient-0.6.0-x64.zip", "macOS"],
    ] as const) {
      const root = createValidFixture();
      try {
        NodeFS.rmSync(NodePath.join(root, `${payload}.blockmap`));
        assert.throws(() => verify(root), `Missing ${label} update blockmap: ${payload}.blockmap`);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a corrupt or malformed blockmap", () => {
    const root = createValidFixture();
    const path = NodePath.join(root, "Scient-0.6.0-x64.exe.blockmap");
    try {
      NodeFS.writeFileSync(path, "windows-blockmap");
      assert.throws(() => verify(root), "not gzip-compressed JSON");
      NodeFS.writeFileSync(path, blockmap("windows").subarray(0, 20));
      assert.throws(() => verify(root), "not gzip-compressed JSON");
      const map = JSON.parse(NodeZlib.gunzipSync(blockmap("windows")).toString("utf8"));
      NodeFS.writeFileSync(path, NodeZlib.gzipSync(JSON.stringify({ ...map, version: "1" })));
      assert.throws(() => verify(root), "not a version 2 single-file blockmap");
      map.files[0].sizes[0] = 0;
      NodeFS.writeFileSync(path, NodeZlib.gzipSync(JSON.stringify(map)));
      assert.throws(() => verify(root), "not a version 2 single-file blockmap");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a blockmap made for different bytes than its payload", () => {
    const root = createValidFixture();
    const write = (name: string, value: string) =>
      NodeFS.writeFileSync(NodePath.join(root, `${name}.blockmap`), blockmap(value));
    try {
      write("Scient-0.6.0-x64.exe", "an earlier installer");
      assert.throws(() => verify(root), "does not cover its payload's 7 bytes");
      write("Scient-0.6.0-x64.exe", "windoes");
      assert.throws(() => verify(root), "chunk 1 does not match");
      write("Scient-0.6.0-x64.exe", "windows");
      write("Scient-0.6.0-x64.zip", "arm-zip");
      assert.throws(() => verify(root), "chunk 0 does not match");
      write("Scient-0.6.0-x64.zip", "x64-zip");
      // A DMG blockmap is optional, but one that ships must still describe its DMG.
      write("Scient-0.6.0-x64.dmg", "arm-dmg");
      assert.throws(() => verify(root), "Scient-0.6.0-x64.dmg.blockmap");
      NodeFS.rmSync(NodePath.join(root, "Scient-0.6.0-x64.dmg.blockmap"));
      assert.equal(verify(root).version, "0.6.0");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
