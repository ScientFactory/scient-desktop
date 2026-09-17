import { describe, assert, it } from "vite-plus/test";
import { getLocalFileManagerName, isWindowsPlatform, resizeCursorForPlatform } from "./utils";

describe("getLocalFileManagerName", () => {
  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "File Explorer"],
    ["Linux", "Files"],
  ])("uses the %s file manager name", (platform, expected) => {
    assert.strictEqual(getLocalFileManagerName(platform), expected);
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("resizeCursorForPlatform", () => {
  it("preserves the barred resize cursors outside Windows", () => {
    assert.strictEqual(resizeCursorForPlatform("horizontal", "MacIntel"), "col-resize");
    assert.strictEqual(resizeCursorForPlatform("vertical", "MacIntel"), "row-resize");
  });

  it("uses directional resize cursors on Windows", () => {
    assert.strictEqual(resizeCursorForPlatform("horizontal", "Win32"), "ew-resize");
    assert.strictEqual(resizeCursorForPlatform("vertical", "Win32"), "ns-resize");
  });
});
