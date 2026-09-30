import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatFileOpenNeedsLookup,
  pickClosestPathMatch,
  resolveChatFileOpenPath,
} from "./changedFileLinkEvidence";

const root = "/Users/me/scient-open-file-test";

describe("pickClosestPathMatch", () => {
  it("recovers a link written relative to another directory", () => {
    // The agent's shell was in tmp/, so it wrote ../reviews/..., which from
    // the project root points one level too high.
    expect(
      pickClosestPathMatch(
        "/Users/me/reviews/document-editing/notes.md",
        ["reviews/document-editing/notes.md", "tmp/sample.md"],
        root,
      ),
    ).toBe("reviews/document-editing/notes.md");
    // Links written relative to a subfolder the agent was thinking in.
    expect(pickClosestPathMatch("reviews/inside.md", ["project/reviews/inside.md"], root)).toBe(
      "project/reviews/inside.md",
    );
    expect(pickClosestPathMatch("../outside/locked.md", ["outside/locked.md"], root)).toBe(
      "outside/locked.md",
    );
  });

  it("prefers the candidate sharing the longest path ending", () => {
    expect(
      pickClosestPathMatch(
        "/elsewhere/reviews/notes.md",
        ["drafts/notes.md", "archive/reviews/notes.md"],
        root,
      ),
    ).toBe("archive/reviews/notes.md");
  });

  it("refuses to choose between equally plausible files", () => {
    expect(
      pickClosestPathMatch(
        "dup.md",
        ["project/reviews/a/dup.md", "project/reviews/b/dup.md"],
        root,
      ),
    ).toBeNull();
  });

  it("needs the exact file name", () => {
    expect(
      pickClosestPathMatch("/elsewhere/reviews/notes.md", ["reviews/other.md"], root),
    ).toBeNull();
    expect(pickClosestPathMatch("/elsewhere/Notes.md", ["reviews/notes.md"], root)).toBeNull();
    // On POSIX a backslash belongs to the file name.
    expect(pickClosestPathMatch("/tmp/draft\\notes.md", ["reviews/notes.md"], root)).toBeNull();
  });

  it("does nothing when the link already names a candidate", () => {
    expect(
      pickClosestPathMatch("reviews/notes.md", ["reviews/notes.md", "other/notes.md"], root),
    ).toBeNull();
  });
});

describe("resolveChatFileOpenPath", () => {
  const existing =
    (...paths: string[]) =>
    async (path: string) =>
      paths.includes(path);
  const noFiles = async () => [];

  it("opens the link as written whenever it exists", async () => {
    const exists = vi.fn(existing(`${root}/notes.md`));
    const findFilesNamed = vi.fn(async () => ["reviews/notes.md"]);
    await expect(
      resolveChatFileOpenPath({
        panelPath: "notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists,
        findFilesNamed,
      }),
    ).resolves.toEqual({ path: "notes.md" });
    expect(exists).toHaveBeenCalledWith(`${root}/notes.md`);
    expect(findFilesNamed).not.toHaveBeenCalled();
  });

  it("prefers a file the link's turn changed, then the closest project file", async () => {
    await expect(
      resolveChatFileOpenPath({
        panelPath: "/Users/me/reviews/notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists: existing(),
        findFilesNamed: async () => ["archive/reviews/notes.md"],
      }),
    ).resolves.toEqual({
      path: "reviews/notes.md",
      missingLinkPath: "/Users/me/reviews/notes.md",
    });
    await expect(
      resolveChatFileOpenPath({
        panelPath: "reviews/inside.md",
        workspaceRoot: root,
        changedPaths: [],
        exists: existing(),
        findFilesNamed: async () => ["project/reviews/inside.md"],
      }),
    ).resolves.toEqual({
      path: "project/reviews/inside.md",
      missingLinkPath: `${root}/reviews/inside.md`,
    });
  });

  it("keeps the link when the host cannot say it is missing", async () => {
    // A permission or connection problem is reported as existing, so the user
    // sees that problem on the linked file instead of another document.
    await expect(
      resolveChatFileOpenPath({
        panelPath: "/Users/me/reviews/notes.md",
        workspaceRoot: root,
        changedPaths: ["reviews/notes.md"],
        exists: async () => true,
        findFilesNamed: noFiles,
      }),
    ).resolves.toEqual({ path: "/Users/me/reviews/notes.md" });
  });

  it("opens the link as written when there is no single best match", async () => {
    await expect(
      resolveChatFileOpenPath({
        panelPath: "dup.md",
        workspaceRoot: root,
        changedPaths: [],
        exists: existing(),
        findFilesNamed: async () => ["project/reviews/a/dup.md", "project/reviews/b/dup.md"],
      }),
    ).resolves.toEqual({ path: "dup.md" });
    await expect(
      resolveChatFileOpenPath({
        panelPath: "reports/missing.md",
        workspaceRoot: root,
        changedPaths: [],
        exists: existing(),
        findFilesNamed: noFiles,
      }),
    ).resolves.toEqual({ path: "reports/missing.md" });
  });
});

describe("chatFileOpenNeedsLookup", () => {
  it("checks every link in a workspace thread and none without one", () => {
    const input = { panelPath: "reviews/notes.md", changedPaths: [] };
    expect(chatFileOpenNeedsLookup({ ...input, workspaceRoot: root })).toBe(true);
    expect(chatFileOpenNeedsLookup({ ...input, workspaceRoot: undefined })).toBe(false);
  });
});
