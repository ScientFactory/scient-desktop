import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { remapFileCommentAnnotations } from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  resolveMarkdownTaskPreviewUpdate,
  resolveFilePreviewKind,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldLoadFileAsText,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("file preview read errors", () => {
  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
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

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
  });
});
