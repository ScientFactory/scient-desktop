import { describe, expect, it } from "vitest";

import { MAX_CLIPBOARD_TEXT_LENGTH, normalizeClipboardText } from "./clipboardText";

describe("normalizeClipboardText", () => {
  it("preserves valid text exactly", () => {
    expect(normalizeClipboardText("  feature/native-copy\n")).toBe("  feature/native-copy\n");
  });

  it.each([null, undefined, 42, {}, ""])("rejects invalid clipboard input %#", (value) => {
    expect(normalizeClipboardText(value)).toBeNull();
  });

  it("accepts the size boundary and rejects oversized renderer input", () => {
    expect(normalizeClipboardText("a".repeat(MAX_CLIPBOARD_TEXT_LENGTH))).not.toBeNull();
    expect(normalizeClipboardText("a".repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1))).toBeNull();
  });
});
