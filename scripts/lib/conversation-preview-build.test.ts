// @effect-diagnostics nodeBuiltinImport:off -- temporary fixtures exercise the native source digest.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";

import {
  clsidBinaryBytes,
  MAC_PREVIEW_DEPENDENCIES,
  macPreviewArchitectures,
  macPreviewBundleIdentifier,
  macPreviewVariant,
  parsePreviewQualification,
  peMachine,
  previewBuildCommand,
  previewSourceSha256,
  requirePreviewQualification,
  stageWindowsPreviewNotices,
  WINDOWS_PREVIEW_CLSIDS,
  WINDOWS_PREVIEW_DEPENDENCIES,
  WINDOWS_VCPKG_REVISION,
  windowsPreviewInstalledRoot,
} from "./conversation-preview-build.ts";

it("stages isolated port notices and the pinned archive source license", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-notices-"));
  const share = NodePath.join(root, "share");
  const copying = NodePath.join(root, "_deps", "scic_libarchive-src", "COPYING");
  const output = NodePath.join(root, "notices");
  try {
    for (const name of ["json-c", "zlib"]) {
      await NodeFSP.mkdir(NodePath.join(share, name), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(share, name, "copyright"), `${name} license`);
    }
    await NodeFSP.mkdir(NodePath.dirname(copying), { recursive: true });
    await NodeFSP.writeFile(copying, "pinned archive license");
    await stageWindowsPreviewNotices(share, copying, output);
    assert.deepStrictEqual((await NodeFSP.readdir(output)).sort(), [
      "json-c.txt",
      "libarchive.txt",
      "zlib.txt",
    ]);
    assert.equal(
      await NodeFSP.readFile(NodePath.join(output, "libarchive.txt"), "utf8"),
      "pinned archive license",
    );
    await NodeFSP.unlink(NodePath.join(share, "json-c", "copyright"));
    await expect(stageWindowsPreviewNotices(share, copying, output)).rejects.toThrow(
      /Missing json-c or zlib/,
    );
    await NodeFSP.writeFile(NodePath.join(share, "json-c", "copyright"), "json-c license");
    await NodeFSP.unlink(copying);
    await expect(stageWindowsPreviewNotices(share, copying, output)).rejects.toThrow(
      /Missing libarchive COPYING/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("takes Windows notices from the build's isolated install, not the shared toolchain", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-install-"));
  try {
    const build = NodePath.join(root, "build");
    const isolatedShare = NodePath.join(
      windowsPreviewInstalledRoot(build),
      "x64-windows-static",
      "share",
    );
    const sharedShare = NodePath.join(root, "vcpkg", "installed", "x64-windows-static", "share");
    const copying = NodePath.join(build, "_deps", "scic_libarchive-src", "COPYING");
    const notices = NodePath.join(root, "notices");
    for (const share of [isolatedShare, sharedShare]) {
      for (const name of ["json-c", "zlib"]) {
        await NodeFSP.mkdir(NodePath.join(share, name), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(share, name, "copyright"), share);
      }
    }
    await NodeFSP.mkdir(NodePath.dirname(copying), { recursive: true });
    await NodeFSP.writeFile(copying, "fetched source");
    await stageWindowsPreviewNotices(isolatedShare, copying, notices);
    assert.equal(await NodeFSP.readFile(NodePath.join(notices, "zlib.txt"), "utf8"), isolatedShare);
    await NodeFSP.rm(NodePath.join(isolatedShare, "json-c"), { recursive: true });
    await expect(stageWindowsPreviewNotices(isolatedShare, copying, notices)).rejects.toThrow(
      /Missing json-c or zlib/,
    );
    await NodeFSP.mkdir(NodePath.join(isolatedShare, "libarchive"));
    await expect(stageWindowsPreviewNotices(isolatedShare, copying, notices)).rejects.toThrow(
      /libarchive must come from the pinned CMake source/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps the Windows installer and packager on the same fresh install root", async () => {
  const script = await NodeFSP.readFile(
    NodePath.join(import.meta.dirname, "../build-conversation-preview.ps1"),
    "utf8",
  );
  assert.match(script, /\$installed = Join-Path \$build "vcpkg-installed"/u);
  assert.match(script, /"--x-install-root=\$installed"/u);
  assert.match(script, /"-DVCPKG_INSTALLED_DIR=\$installed"/u);
  assert.match(script, /--binarysource=clear/u);
  assert.match(script, /"zlib:\$Triplet" "json-c:\$Triplet"/u);
  assert.match(script, /-DCMAKE_DISABLE_FIND_PACKAGE_LibArchive=TRUE/u);
  assert.match(script, /"json-c_DIR", "ZLIB_INCLUDE_DIR"/u);
  assert.match(script, /"ZLIB_LIBRARY_RELEASE", "ZLIB_LIBRARY_DEBUG", "ZLIB_LIBRARY"/u);
  assert.match(script, /CMake did not fetch the pinned libarchive source COPYING/u);
  assert.match(script, /CMake resolved libarchive outside the pinned source build/u);
  assert.match(script, /BuildDirectory must be a fresh empty directory/u);
  assert.match(script, /VCPKG_\|X_VCPKG_\|CMAKE_\|PKG_CONFIG_/u);
  const builder = await NodeFSP.readFile(
    NodePath.join(import.meta.dirname, "conversation-preview-build.ts"),
    "utf8",
  );
  assert.match(builder, /NodePath\.join\(windowsPreviewInstalledRoot\(buildDir\),/u);
  assert.match(builder, /NodePath\.join\(buildDir, "_deps", "scic_libarchive-src", "COPYING"\)/u);
});

it("builds Linux against zlib while CMake fetches the patched archive", async () => {
  const workflow = await NodeFSP.readFile(
    NodePath.join(import.meta.dirname, "../../.github/workflows/conversation-preview.yml"),
    "utf8",
  );
  assert.match(workflow, /zlib1g-dev/u);
  assert.notMatch(workflow, /libarchive-dev/u);
});

it("includes the archive policy and pinned vcpkg revision in Windows qualification", () => {
  assert.equal(
    WINDOWS_PREVIEW_DEPENDENCIES,
    `libarchive@3.8.7/policy1/vcpkg@${WINDOWS_VCPKG_REVISION}`,
  );
  const expected = {
    platform: "win",
    arch: "x64",
    channel: "latest",
    sourceSha256: "a".repeat(64),
    dependencyRevision: WINDOWS_PREVIEW_DEPENDENCIES,
  } as const;
  const manifest = { schemaVersion: 2, status: "qualified", ...expected, evidence: "windows-qa" };
  assert.equal(parsePreviewQualification(JSON.stringify(manifest), expected), "qualified");
  assert.throws(() =>
    parsePreviewQualification(
      JSON.stringify({ ...manifest, dependencyRevision: WINDOWS_VCPKG_REVISION }),
      expected,
    ),
  );
});

async function writePreviewDigestFixture(root: string): Promise<void> {
  const files = [
    "native/conversation-preview/CMakeLists.txt",
    "native/conversation-preview/cmake/ScicArchive.cmake",
    "scripts/build-conversation-preview.sh",
    "scripts/build-conversation-preview.ps1",
    "scripts/build-desktop-artifact.ts",
    "scripts/scient/conversationAssociation.ts",
    "scripts/scient/wslNodePty.ts",
    "scripts/sign-macos.ts",
    "scripts/lib/conversation-preview-build.ts",
    "apps/desktop/scripts/conversation-file-type.mjs",
    ".github/workflows/conversation-preview.yml",
  ];
  for (const file of files) {
    const path = NodePath.join(root, file);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, "original");
  }
}

it("invalidates qualification when a native source or pinned build input changes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-digest-"));
  try {
    await writePreviewDigestFixture(root);
    const before = await previewSourceSha256(root);
    await NodeFSP.writeFile(
      NodePath.join(root, "scripts/build-conversation-preview.sh"),
      "new pinned dependency",
    );
    assert.notEqual(await previewSourceSha256(root), before);
    await NodeFSP.writeFile(
      NodePath.join(root, "scripts/build-conversation-preview.sh"),
      "original",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "native/conversation-preview/cmake/ScicArchive.cmake"),
      "new patched archive source",
    );
    assert.notEqual(await previewSourceSha256(root), before);
    await NodeFSP.writeFile(
      NodePath.join(root, "native/conversation-preview/cmake/ScicArchive.cmake"),
      "original",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "scripts/lib/conversation-preview-build.ts"),
      "new archive policy revision",
    );
    assert.notEqual(await previewSourceSha256(root), before);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each(["scripts/scient/conversationAssociation.ts", "scripts/scient/wslNodePty.ts"])(
  "rejects prior qualification when only %s changes",
  async (source) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scic-preview-extracted-"));
    try {
      await writePreviewDigestFixture(root);
      const before = await previewSourceSha256(root);
      const manifestPath = NodePath.join(root, "qualification.json");
      const manifest = {
        schemaVersion: 2,
        status: "qualified",
        platform: "mac",
        arch: "arm64",
        channel: "latest",
        sourceSha256: before,
        dependencyRevision: MAC_PREVIEW_DEPENDENCIES,
        evidence: "synthetic installed-preview qualification",
      };
      const input = {
        platform: "mac",
        arch: "arm64",
        channel: "latest",
        manifestPath,
        repoRoot: root,
      } as const;
      await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
      assert.equal(await requirePreviewQualification(input), "qualified");

      await NodeFSP.writeFile(NodePath.join(root, source), "changed extracted packaging input");
      const after = await previewSourceSha256(root);
      assert.notEqual(after, before);
      await expect(requirePreviewQualification(input)).rejects.toThrow(
        /Native preview qualification does not cover mac\/arm64\/latest/u,
      );

      await NodeFSP.writeFile(manifestPath, JSON.stringify({ ...manifest, sourceSha256: after }));
      assert.equal(await requirePreviewQualification(input), "qualified");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it("requires an exact platform, architecture, and channel qualification", () => {
  assert.equal(MAC_PREVIEW_DEPENDENCIES, "json-c@0.19/libarchive@3.8.7/policy1");
  const expected = {
    platform: "mac",
    arch: "arm64",
    channel: "latest",
    sourceSha256: "a".repeat(64),
    dependencyRevision: MAC_PREVIEW_DEPENDENCIES,
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
    { dependencyRevision: "json-c@0.19/libarchive@3.8.7" },
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
    dependencyRevision: MAC_PREVIEW_DEPENDENCIES,
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
