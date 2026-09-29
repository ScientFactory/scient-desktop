// @effect-diagnostics nodeBuiltinImport:off -- temporary fixtures exercise the native source digest.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";

import {
  clsidBinaryBytes,
  macPreviewArchitectures,
  macPreviewBundleIdentifier,
  macPreviewVariant,
  parsePreviewQualification,
  peMachine,
  previewBuildCommand,
  previewSourceSha256,
  stageWindowsPreviewNotices,
  WINDOWS_PREVIEW_CLSIDS,
} from "./conversation-preview-build.ts";

it("stages direct and transitive static dependency notices and fails on missing direct notices", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-notices-"));
  const share = NodePath.join(root, "share");
  const output = NodePath.join(root, "notices");
  try {
    for (const name of ["libarchive", "json-c", "zlib"]) {
      await NodeFSP.mkdir(NodePath.join(share, name), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(share, name, "copyright"), `${name} license`);
    }
    await stageWindowsPreviewNotices(share, output);
    assert.deepStrictEqual((await NodeFSP.readdir(output)).sort(), [
      "json-c.txt",
      "libarchive.txt",
      "zlib.txt",
    ]);
    await NodeFSP.unlink(NodePath.join(share, "json-c", "copyright"));
    await expect(stageWindowsPreviewNotices(share, output)).rejects.toThrow(
      /Missing libarchive or json-c/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("invalidates qualification when a native source or pinned build input changes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-digest-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "native/conversation-preview"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "scripts"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "scripts/lib"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "apps/desktop/scripts"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, ".github/workflows"), { recursive: true });
    const files = [
      "native/conversation-preview/CMakeLists.txt",
      "scripts/build-conversation-preview.sh",
      "scripts/build-conversation-preview.ps1",
      "scripts/build-desktop-artifact.ts",
      "scripts/sign-macos.ts",
      "scripts/lib/conversation-preview-build.ts",
      "apps/desktop/scripts/conversation-file-type.mjs",
      ".github/workflows/conversation-preview.yml",
    ];
    for (const file of files) await NodeFSP.writeFile(NodePath.join(root, file), "original");
    const before = await previewSourceSha256(root);
    await NodeFSP.writeFile(
      NodePath.join(root, "scripts/build-conversation-preview.sh"),
      "new pinned dependency",
    );
    assert.notEqual(await previewSourceSha256(root), before);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("requires an exact platform, architecture, and channel qualification", () => {
  const expected = {
    platform: "mac",
    arch: "arm64",
    channel: "latest",
    sourceSha256: "a".repeat(64),
    dependencyRevision: "json-c@0.19/libarchive@3.8.7",
  } as const;
  const manifest = { schemaVersion: 2, status: "qualified", ...expected, evidence: "ci-run-123" };
  assert.doesNotThrow(() => parsePreviewQualification(JSON.stringify(manifest), expected));
  for (const mutation of [
    { arch: "x64" },
    { channel: "nightly" },
    { platform: "win" },
    { evidence: "" },
    { status: "pending" },
    { sourceSha256: "b".repeat(64) },
    { dependencyRevision: "other-dependencies" },
  ]) {
    assert.throws(() =>
      parsePreviewQualification(JSON.stringify({ ...manifest, ...mutation }), expected),
    );
  }
});

it("allows an exact-source candidate only for preview artifacts", () => {
  const expected = {
    platform: "mac",
    arch: "universal",
    channel: "preview",
    sourceSha256: "a".repeat(64),
    dependencyRevision: "json-c@0.19/libarchive@3.8.7",
  } as const;
  const candidate = {
    schemaVersion: 2,
    status: "candidate",
    ...expected,
    evidence: "installed-candidate-qa",
  };
  assert.equal(parsePreviewQualification(JSON.stringify(candidate), expected), "candidate");
  assert.throws(() =>
    parsePreviewQualification(JSON.stringify({ ...candidate, channel: "latest" }), {
      ...expected,
      channel: "latest",
    }),
  );
  assert.throws(() =>
    parsePreviewQualification(JSON.stringify({ ...candidate, channel: "nightly" }), {
      ...expected,
      channel: "nightly",
    }),
  );
  assert.throws(() =>
    parsePreviewQualification(
      JSON.stringify({ ...candidate, sourceSha256: "b".repeat(64) }),
      expected,
    ),
  );
  assert.throws(() =>
    parsePreviewQualification(
      JSON.stringify({ ...candidate, dependencyRevision: "other" }),
      expected,
    ),
  );
});

it("assigns each macOS channel a child bundle ID under the unchanged parent", () => {
  assert.equal(
    macPreviewBundleIdentifier("com.scientfactory.scient", "latest"),
    "com.scientfactory.scient.conversation-preview",
  );
  assert.equal(
    macPreviewBundleIdentifier("com.scientfactory.scient", "nightly"),
    "com.scientfactory.scient.nightly.conversation-preview",
  );
  assert.equal(
    macPreviewBundleIdentifier("com.scientfactory.scient", "preview"),
    "com.scientfactory.scient.preview.conversation-preview",
  );
});

it("passes the requested macOS architecture, including universal, to the native builder", () => {
  for (const [arch, variant, architectures] of [
    ["arm64", "arm64", ["arm64"]],
    ["x64", "x86_64", ["x86_64"]],
    ["universal", "universal", ["arm64", "x86_64"]],
  ] as const) {
    assert.equal(macPreviewVariant(arch), variant);
    assert.deepStrictEqual(macPreviewArchitectures(arch), architectures);
    const command = previewBuildCommand({
      repoRoot: "/repo",
      buildDir: "/tmp/build",
      platform: "mac",
      arch,
      channel: "latest",
      hostPlatform: "darwin",
    });
    assert.equal(command.env.SCIC_PREVIEW_MAC_ARCH, variant);
    assert.equal(command.env.SCIC_PREVIEW_BUILD_DIR, "/tmp/build");
    assert.equal(command.env.SCIC_PREVIEW_MACOS_MIN, "12.0");
  }
});

it("rejects unsupported universal Windows preview staging", () => {
  assert.throws(() =>
    previewBuildCommand({
      repoRoot: "/repo",
      buildDir: "C:/build",
      platform: "win",
      arch: "universal",
      channel: "latest",
      hostPlatform: "win32",
    }),
  );
});

it("encodes Windows CLSIDs in COM binary order and distinguishes channels", () => {
  assert.deepStrictEqual(
    [...clsidBinaryBytes(WINDOWS_PREVIEW_CLSIDS.latest)].slice(0, 8),
    [0xa3, 0x25, 0xc9, 0xe0, 0x1d, 0xe4, 0x69, 0x49],
  );
  assert.notDeepEqual(
    clsidBinaryBytes(WINDOWS_PREVIEW_CLSIDS.latest),
    clsidBinaryBytes(WINDOWS_PREVIEW_CLSIDS.nightly),
  );
});

it("reads PE machine architecture before accepting a DLL", () => {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x84, 0x8664, true);
  assert.equal(peMachine(bytes), 0x8664);
  view.setUint16(0x84, 0xaa64, true);
  assert.equal(peMachine(bytes), 0xaa64);
});
