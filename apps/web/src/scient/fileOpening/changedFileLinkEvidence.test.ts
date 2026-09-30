import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatFileOpenNeedsLookup,
  pickChangedFileForLink,
  resolveChatFileOpenPath,
} from "./changedFileLinkEvidence";

const root = "/Users/me/ScientFactory";

describe("pickChangedFileForLink", () => {
  it("recovers a link written relative to the agent's shell directory", () => {
    // The agent's shell was in ScientFactory/tmp, so it wrote ../reviews/...,
    // which from the project root points at /Users/me/reviews/....
    expect(
      pickChangedFileForLink(
        "/Users/me/reviews/document-editing/pr353-app-review-notes.md",
        ["reviews/document-editing/pr353-app-review-notes.md", "tmp/sample.md"],
        root,
      ),
    ).toBe("reviews/document-editing/pr353-app-review-notes.md");
    expect(
      pickChangedFileForLink(
        "../reviews/document-editing/pr353-app-review-notes.md",
        ["reviews/document-editing/pr353-app-review-notes.md"],
        root,
      ),
    ).toBe("reviews/document-editing/pr353-app-review-notes.md");
  });

  it("prefers the changed file sharing the longest path suffix", () => {
    expect(
      pickChangedFileForLink(
        "/elsewhere/reviews/notes.md",
        ["drafts/notes.md", "archive/reviews/notes.md"],
        root,
      ),
    ).toBe("archive/reviews/notes.md");
  });

  it("refuses to choose between equally plausible changed files", () => {
    expect(
      pickChangedFileForLink("/elsewhere/notes.md", ["a/notes.md", "b/notes.md"], root),
    ).toBeNull();
  });

  it("needs the file name itself to match", () => {
    expect(
      pickChangedFileForLink("/elsewhere/reviews/notes.md", ["reviews/other.md"], root),
    ).toBeNull();
    expect(pickChangedFileForLink("/elsewhere/Notes.md", ["reviews/notes.md"], root)).toBeNull();
  });

  it("does nothing when the link already names a changed file", () => {
    expect(
      pickChangedFileForLink("reviews/notes.md", ["reviews/notes.md", "other/notes.md"], root),
    ).toBeNull();
  });

  it("matches a bare file name only through the turn's own changes", () => {
    expect(pickChangedFileForLink("notes.md", ["reviews/notes.md"], root)).toBe("reviews/notes.md");
    expect(pickChangedFileForLink("notes.md", [], root)).toBeNull();
  });
});

describe("resolveChatFileOpenPath", () => {
  const notFoundExcept =
    (...existing: string[]) =>
    async (path: string) =>
      existing.includes(path);
  const noBasenameMatch = async () => null;

  it("opens the link as written whenever it exists, even with a same-named change", async () => {
    const exists = vi.fn(notFoundExcept("/Users/me/ScientFactory/notes.md"));
    await expect(
      resolveChatFileOpenPath({
        panelPath: "notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists,
        findBasenameMatch: async () => "docs/notes.md",
      }),
    ).resolves.toBe("notes.md");
    expect(exists).toHaveBeenCalledWith("/Users/me/ScientFactory/notes.md");
  });

  it("falls back to the turn's changed file only when the link does not exist", async () => {
    await expect(
      resolveChatFileOpenPath({
        panelPath: "/Users/me/reviews/notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists: notFoundExcept(),
        findBasenameMatch: noBasenameMatch,
      }),
    ).resolves.toBe("reviews/notes.md");
  });

  it("keeps the link when the host cannot say it is missing", async () => {
    // A permission or connection problem is reported as existing, so the
    // user sees that problem on the linked file instead of another document.
    await expect(
      resolveChatFileOpenPath({
        panelPath: "/Users/me/reviews/notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists: async () => true,
        findBasenameMatch: noBasenameMatch,
      }),
    ).resolves.toBe("/Users/me/reviews/notes.md");
  });

  it("checks a bare file name on disk before trusting the search index", async () => {
    const findBasenameMatch = vi.fn(async () => "docs/notes.md");
    await expect(
      resolveChatFileOpenPath({
        panelPath: "notes.md",
        workspaceRoot: root,
        changedPaths: [],
        exists: notFoundExcept("/Users/me/ScientFactory/notes.md"),
        findBasenameMatch,
      }),
    ).resolves.toBe("notes.md");
    expect(findBasenameMatch).not.toHaveBeenCalled();

    await expect(
      resolveChatFileOpenPath({
        panelPath: "notes.md",
        workspaceRoot: root,
        changedPaths: [],
        exists: notFoundExcept(),
        findBasenameMatch,
      }),
    ).resolves.toBe("docs/notes.md");
  });

  it("opens the link as written when nothing better is known", async () => {
    await expect(
      resolveChatFileOpenPath({
        panelPath: "reports/missing.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists: notFoundExcept(),
        findBasenameMatch: noBasenameMatch,
      }),
    ).resolves.toBe("reports/missing.md");
  });
});

describe("chatFileOpenNeedsLookup", () => {
  it("consults the host only for links that could be redirected", () => {
    const base = { workspaceRoot: root, changedPaths: ["reviews/notes.md"] };
    expect(chatFileOpenNeedsLookup({ ...base, panelPath: "/Users/me/reviews/notes.md" })).toBe(
      true,
    );
    expect(chatFileOpenNeedsLookup({ ...base, panelPath: "notes.md" })).toBe(true);
    expect(chatFileOpenNeedsLookup({ ...base, panelPath: "reviews/notes.md" })).toBe(false);
    expect(chatFileOpenNeedsLookup({ ...base, panelPath: "docs/other.md" })).toBe(false);
    expect(
      chatFileOpenNeedsLookup({ ...base, workspaceRoot: undefined, panelPath: "notes.md" }),
    ).toBe(false);
  });
});
