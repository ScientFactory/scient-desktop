import { describe, expect, it } from "vite-plus/test";

import {
  isBrowserPreviewFile,
  isTrackableWorkspaceHtml,
  resolveWorkspaceFileLinkOpenTarget,
} from "./openFileInPreview";

describe("workspace file link routing", () => {
  it.each(["paper.pdf", "sources/PAPER.PDF", "paper.pdf?download=1", "paper.pdf#page=4"])(
    "routes PDF link %s to the Scient file surface",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(true);
      expect(resolveWorkspaceFileLinkOpenTarget(path)).toBe("file");
    },
  );

  it.each(["report.html", "preview.HTM?mode=full"])(
    "preserves T3 browser-first behavior for %s",
    (path) => {
      expect(resolveWorkspaceFileLinkOpenTarget(path)).toBe("browser");
    },
  );

  it("tracks HTML source updates without treating Browser-opened PDFs as HTML", () => {
    expect(isTrackableWorkspaceHtml("reports/result.html")).toBe(true);
    expect(isTrackableWorkspaceHtml("papers/heavy.pdf")).toBe(false);
  });

  it("keeps ordinary workspace files on the file surface", () => {
    expect(resolveWorkspaceFileLinkOpenTarget("notes.md")).toBe("file");
  });
});
