import { describe, expect, it } from "vite-plus/test";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspacePreviewEntryPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["PAPER.PDF", "paper?draft.PDF", "report.pdf#copy.pdf"])(
    "recognizes literal PDF preview path %s",
    (path) => {
      expect(isWorkspacePdfPreviewPath(path)).toBe(true);
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
    },
  );

  it.each(["paper.pdf.txt", "PAPER.PDF?download=1", "sources/report.pdf#page=4", "paper%2Epdf"])(
    "rejects literal non-PDF path %s",
    (path) => {
      expect(isWorkspacePdfPreviewPath(path)).toBe(false);
    },
  );

  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each(["image.png.ts", "image.png#notes.txt", "document.pdf?download=1", "image%2Epng"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
});
