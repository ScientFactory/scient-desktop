import { assert, it } from "@effect/vitest";
import {
  analyzeWindowsPayloadInventory,
  unexpectedWindowsNativeFiles,
  unexpectedWindowsServerAsarEntries,
  windowsCursorFiles,
  windowsTranscribeFiles,
} from "./windows-payload.ts";

const cursorFiles = windowsCursorFiles("x64").map(
  (file) => `resources/node_modules/@cursor/${file}`,
);
const speechFiles = windowsTranscribeFiles("x64").map(
  (file) =>
    `resources/server.asar.unpacked/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/${file}`,
);
const componentFiles = [...cursorFiles, ...speechFiles];

// regression: 175444cee1 fix(desktop): validate Windows payload components and native targets
it.each(componentFiles)("rejects a missing required component file: %s", (missing) => {
  const result = analyzeWindowsPayloadInventory({
    files: componentFiles.filter((file) => file !== missing),
    arch: "x64",
  });
  assert.deepStrictEqual(result.missingFiles, [missing]);
});

it.each([
  "resources/node_modules/@cursor/sdk-win32-x64/extra.txt",
  "resources/conversation-preview/extra.txt",
])("rejects unapproved component files even below the total cap: %s", (extra) => {
  const result = analyzeWindowsPayloadInventory({ files: [...componentFiles, extra], arch: "x64" });
  assert.deepStrictEqual(result.unexpectedFiles, [extra]);
});

it("admits T3's transcription engine as its own component", () => {
  const omitted = analyzeWindowsPayloadInventory({ files: cursorFiles, arch: "x64" });
  assert.deepStrictEqual(omitted.missingFiles, speechFiles);
  const result = analyzeWindowsPayloadInventory({
    files: componentFiles,
    arch: "x64",
  });
  assert.equal(result.counts.transcribe, 13);
  assert.equal(result.allowance, 22 + 13);
  const partial = analyzeWindowsPayloadInventory({
    files: [...cursorFiles, ...speechFiles.slice(1)],
    arch: "x64",
  });
  assert.deepStrictEqual(partial.missingFiles, [speechFiles[0]]);
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
  assert.equal(result.allowance, 37);
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
  assert.equal(result.allowance, 35);
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

it("validates slim Windows payloads without Linux Cursor helpers or Linux natives", () => {
  const slimCursorFiles = windowsCursorFiles("x64", false).map(
    (file) => `resources/node_modules/@cursor/${file}`,
  );
  assert.equal(slimCursorFiles.length, 11);
  assert.isFalse(slimCursorFiles.some((file) => file.includes("sdk-linux-")));

  const slimOk = analyzeWindowsPayloadInventory({
    files: [...slimCursorFiles, ...speechFiles],
    arch: "x64",
    linuxBackend: false,
  });
  assert.deepStrictEqual(slimOk.missingFiles, []);
  assert.deepStrictEqual(slimOk.unexpectedFiles, []);
  assert.equal(slimOk.allowance, 11 + 13);

  const injectedLinux = [
    "resources/node_modules/@cursor/sdk-linux-x64/bin/rg",
    "resources/server.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node",
  ];
  const slimRejected = analyzeWindowsPayloadInventory({
    files: [...slimCursorFiles, ...speechFiles, ...injectedLinux],
    arch: "x64",
    linuxBackend: false,
  });
  assert.deepStrictEqual(slimRejected.unexpectedFiles, injectedLinux);

  const asarEntries = [
    "/apps/server/dist/bin.mjs",
    "/apps/server/dist/synctex-runtime/linux-x64/synctex",
    "/node_modules/@napi-rs/canvas-win32-x64-msvc/canvas.win32-x64-msvc.node",
    "/node_modules/@napi-rs/canvas-linux-x64-gnu/canvas.linux-x64-gnu.node",
    "/node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
    "/node_modules/node-pty/prebuilds/linux-x64/pty.node",
  ];
  assert.deepStrictEqual(unexpectedWindowsServerAsarEntries(asarEntries, "x64", true), []);
  assert.deepStrictEqual(unexpectedWindowsServerAsarEntries(asarEntries, "x64", false), [
    "/apps/server/dist/synctex-runtime/linux-x64/synctex",
    "/node_modules/@napi-rs/canvas-linux-x64-gnu/canvas.linux-x64-gnu.node",
    "/node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
    "/node_modules/node-pty/prebuilds/linux-x64/pty.node",
  ]);
});
