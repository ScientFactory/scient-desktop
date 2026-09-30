import { describe, expect, it } from "vite-plus/test";

import { pickChangedFileForLink } from "./changedFileLinkEvidence";

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
