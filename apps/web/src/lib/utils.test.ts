import { describe, assert, it } from "vite-plus/test";
import { resizeCursorForPlatform } from "./utils";

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
