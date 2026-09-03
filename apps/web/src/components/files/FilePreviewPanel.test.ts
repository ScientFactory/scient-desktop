import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  resolveMarkdownTaskPreviewUpdate,
  resolveFilePreviewKind,
  setMarkdownTaskChecked,
  shouldLoadFileAsText,
  shouldShowFileExplorer,
} from "./filePreviewMode";

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("PDF file routing", () => {
  it.each(["paper.pdf", "sources/PAPER.PDF", "paper.pdf?download=1"])(
    "bypasses projects.readFile for %s",
    (path) => {
      expect(resolveFilePreviewKind(path)).toBe("pdf");
      expect(shouldLoadFileAsText(path)).toBe(false);
    },
  );

  it("keeps binary-image and text routing distinct", () => {
    expect(resolveFilePreviewKind("figure.png")).toBe("image");
    expect(shouldLoadFileAsText("figure.png")).toBe(false);
    expect(resolveFilePreviewKind("clip.mp4")).toBe("video");
    expect(shouldLoadFileAsText("clip.mp4")).toBe(false);
    expect(resolveFilePreviewKind("notes.md")).toBe("text");
    expect(shouldLoadFileAsText("notes.md")).toBe(true);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });

  it("refuses rendered task-list mutations for a truncated Markdown read", () => {
    const fullMarkdown = `- [ ] Keep the complete file\n${"x".repeat(1024 * 1024)}`;
    const truncatedMarkdown = fullMarkdown.slice(0, 1024 * 1024);

    expect(
      resolveMarkdownTaskPreviewUpdate({
        markdown: truncatedMarkdown,
        markerOffset: 2,
        checked: true,
        truncated: true,
      }),
    ).toBeNull();
    expect(fullMarkdown.startsWith(truncatedMarkdown)).toBe(true);
    expect(fullMarkdown.length).toBeGreaterThan(truncatedMarkdown.length);
  });

  it("returns a task-list update for a complete Markdown read", () => {
    expect(
      resolveMarkdownTaskPreviewUpdate({
        markdown,
        markerOffset: 2,
        checked: true,
        truncated: false,
      }),
    ).toBe("- [x] First\n- [x] Second\n");
  });
});
