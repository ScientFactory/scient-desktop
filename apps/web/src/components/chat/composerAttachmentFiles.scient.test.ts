import { describe, expect, it } from "vite-plus/test";

import { classifyComposerAttachmentFile } from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  // A file whose type is unknown takes the empty-MIME inference path. Typed PDFs, SVG files and
  // captioned SVG pastes are covered in composerAttachmentFiles.test.ts.
  it("accepts unknown.custom without a file-type allowlist", () => {
    expect(classifyComposerAttachmentFile({ name: "unknown.custom", type: "" })).toBe("file");
  });
});
