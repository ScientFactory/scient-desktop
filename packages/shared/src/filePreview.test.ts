import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspacePreviewEntryPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each(["paper.pdf", "PAPER.PDF?download=1", "sources/report.pdf#page=4"])(
    "recognizes PDF preview path %s",
    (path) => {
      expect(isWorkspacePdfPreviewPath(path)).toBe(true);
    },
  );

  it.each(["paper.pdf.txt", "pdf", "paper.html"])("rejects non-PDF path %s", (path) => {
    expect(isWorkspacePdfPreviewPath(path)).toBe(false);
  });

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
});
