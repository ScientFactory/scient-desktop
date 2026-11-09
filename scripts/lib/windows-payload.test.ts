import { assert, it } from "@effect/vitest";
import failedReleaseFiles from "../fixtures/windows-payload-0622.json" with { type: "json" };
import {
  analyzeWindowsPayloadInventory,
  unexpectedWindowsNativeFiles,
  WINDOWS_VOICE_FILES,
  windowsCursorFiles,
  windowsTranscribeFiles,
} from "./windows-payload.ts";

const componentFiles = [
  ...WINDOWS_VOICE_FILES.map((file) => `resources/whisper-runtime/${file}`),
  ...windowsCursorFiles("x64").map((file) => `resources/node_modules/@cursor/${file}`),
];

it("reproduces the real 109-file release failure and admits the corrected inventory under the original core budget", () => {
  assert.lengthOf(failedReleaseFiles, 109);
  const failed = analyzeWindowsPayloadInventory({ files: failedReleaseFiles, arch: "x64" });
  // That release shipped the upstream whisper.cpp archive, whose parakeet.dll
  // and SDL2.dll the runtime built from source neither has nor needs.
  const upstreamOnlyVoiceFiles = ["parakeet.dll", "SDL2.dll"].map(
    (file) => `resources/whisper-runtime/${file}`,
  );
  assert.includeMembers(failed.unexpectedFiles, upstreamOnlyVoiceFiles);
  assert.lengthOf(failed.unexpectedFiles, 4 + upstreamOnlyVoiceFiles.length);
  assert.lengthOf(failed.missingFiles, 0);
  const correctedFiles = failedReleaseFiles.filter(
    (file) => !failed.unexpectedFiles.includes(file),
  );
  const corrected = analyzeWindowsPayloadInventory({ files: correctedFiles, arch: "x64" });
  assert.deepStrictEqual(corrected.counts, {
    voice: 15,
    cursor: 22,
    preview: 0,
    transcribe: 0,
    core: 66,
  });
  assert.lengthOf(corrected.unexpectedFiles, 0);
  assert.equal(corrected.allowance, 37);
  assert.isAtMost(correctedFiles.length, 80 + corrected.allowance);
});

// regression: 175444cee1 fix(desktop): validate Windows payload components and native targets
it.each(componentFiles)("rejects a missing required component file: %s", (missing) => {
  const result = analyzeWindowsPayloadInventory({
    files: componentFiles.filter((file) => file !== missing),
    arch: "x64",
  });
  assert.deepStrictEqual(result.missingFiles, [missing]);
});

it.each([
  "resources/whisper-runtime/extra.dll",
  "resources/node_modules/@cursor/sdk-win32-x64/extra.txt",
  "resources/conversation-preview/extra.txt",
])("rejects unapproved component files even below the total cap: %s", (extra) => {
  const result = analyzeWindowsPayloadInventory({ files: [...componentFiles, extra], arch: "x64" });
  assert.deepStrictEqual(result.unexpectedFiles, [extra]);
});

it("admits T3's transcription engine as its own component", () => {
  const engine = windowsTranscribeFiles("x64").map(
    (file) =>
      `resources/server.asar.unpacked/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/${file}`,
  );
  const result = analyzeWindowsPayloadInventory({
    files: [...componentFiles, ...engine],
    arch: "x64",
  });
  assert.equal(result.counts.transcribe, 13);
  assert.equal(result.allowance, 37 + 13);
  const partial = analyzeWindowsPayloadInventory({
    files: [...componentFiles, ...engine.slice(1)],
    arch: "x64",
  });
  assert.deepStrictEqual(partial.missingFiles, [engine[0]]);
});

it("admits only the explicitly staged preview inventory", () => {
  const previewFiles = ["ScientConversationPreview.dll", "licenses/json-c.txt"];
  const result = analyzeWindowsPayloadInventory({
    files: [
      ...componentFiles,
      ...previewFiles.map((file) => `resources/conversation-preview/${file}`),
    ],
    arch: "x64",
    previewFiles,
  });
  assert.lengthOf(result.missingFiles, 0);
  assert.lengthOf(result.unexpectedFiles, 0);
  assert.equal(result.allowance, 39);
});

it.each(["x64", "arm64"] as const)(
  "rejects foreign natives while retaining Windows and WSL %s resources",
  (arch) => {
    const foreign = arch === "x64" ? "arm64" : "x64";
    const invalid = [
      `resources/server.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/pty.node`,
      `resources/server.asar.unpacked/node_modules/node-pty/prebuilds/linux-${foreign}/pty.node`,
      `resources/server.asar.unpacked/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node`,
      `resources/app.asar.unpacked/node_modules/@napi-rs/keyring-linux-${arch}-gnu/keyring.linux-${arch}-gnu.node`,
    ];
    const valid = [
      `resources/server.asar.unpacked/node_modules/node-pty/prebuilds/linux-${arch}/pty.node`,
      `resources/server.asar.unpacked/node_modules/node-pty/prebuilds/win32-${arch}/conpty.node`,
      `resources/node_modules/@cursor/sdk-linux-${arch}/bin/rg`,
    ];
    assert.deepStrictEqual(unexpectedWindowsNativeFiles([...invalid, ...valid], arch), invalid);
  },
);

it("does not grant additional allowance to a large dependency spill", () => {
  const spill = Array.from(
    { length: 20_000 },
    (_, index) => `resources/server.asar.unpacked/node_modules/spill/file-${index}.js`,
  );
  const result = analyzeWindowsPayloadInventory({
    files: [...componentFiles, ...spill],
    arch: "x64",
  });
  assert.equal(result.allowance, 37);
  assert.equal(result.counts.core, 20_000);
});

it("counts the server compile cache apart from the core budget, up to its cap", () => {
  const cache = (count: number) =>
    Array.from({ length: count }, (_, index) => `resources/server-compile-cache/${index}`);
  const core = ["resources/app.asar", "Scient.exe"];
  const base = analyzeWindowsPayloadInventory({ files: core, arch: "x64" }).allowance;
  const result = analyzeWindowsPayloadInventory({ files: [...core, ...cache(39)], arch: "x64" });
  assert.equal(result.counts.compileCache, 39);
  assert.equal(result.counts.core, 2);
  assert.equal(result.allowance, base + 39);
  const oversized = analyzeWindowsPayloadInventory({ files: [...core, ...cache(70)], arch: "x64" });
  assert.equal(oversized.allowance, base + 64);
});
