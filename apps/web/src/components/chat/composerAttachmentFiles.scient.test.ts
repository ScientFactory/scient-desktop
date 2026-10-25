import { describe, expect, it } from "vite-plus/test";

import {
  classifyComposerAttachmentFile,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  // One row per branch: a typed non-image file and a file whose type is unknown.
  it.each([
    ["paper.pdf", "application/pdf"],
    ["unknown.custom", ""],
  ])("accepts %s without a file-type allowlist", (name, type) => {
    expect(classifyComposerAttachmentFile({ name, type })).toBe("file");
  });
  it("accepts images without a native vision path as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "file",
    );
  });
  it("claims non-native image pastes as files even when a caption is present", () => {
    expect(
      shouldHandleComposerAttachmentPaste({
        files: [new File(["svg"], "diagram.svg", { type: "image/svg+xml" })],
        plainText: "Image caption",
      }),
    ).toBe(true);
  });
});
