import { describe, expect, it } from "vite-plus/test";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspacePreviewEntryPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  // regression: 7a52cad490 test(files): distinguish PDF paths from authored URLs
  it.each([
    "paper.pdf",
    "PAPER.PDF",
    "sources/report.pdf",
    "document#draft.pdf",
    "paper?draft.PDF",
    "reports#archive/document.pdf",
    "reports?old/document.pdf",
    "report.pdf#copy.pdf",
    "report.pdf?copy.pdf",
  ])("recognizes literal PDF preview path %s", (path) => {
    expect(isWorkspacePdfPreviewPath(path)).toBe(true);
    expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
  });

  // regression: 7a52cad490 test(files): distinguish PDF paths from authored URLs
  it.each([
    "paper.pdf.txt",
    "pdf",
    "paper.html",
    "PAPER.PDF?download=1",
    "sources/report.pdf#page=4",
    "paper.pdf#notes.txt",
    "paper.pdf?notes.txt",
    "paper%2Epdf",
  ])("rejects literal non-PDF path %s", (path) => {
    expect(isWorkspacePdfPreviewPath(path)).toBe(false);
  });

  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each(["image.png.ts", "image.png#notes.txt", "image%2Epng"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
});
