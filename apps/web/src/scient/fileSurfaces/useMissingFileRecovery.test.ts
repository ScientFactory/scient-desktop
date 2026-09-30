import { describe, expect, it } from "vite-plus/test";

import { missingFileCandidates } from "./useMissingFileRecovery";

describe("missingFileCandidates", () => {
  it("offers every same-named project file except the missing path itself", () => {
    expect(
      missingFileCandidates("reviews/notes.md", [
        { path: "reviews/notes.md", kind: "file" },
        { path: "archive/notes.md", kind: "file" },
        { path: "drafts/notes.md", kind: "file" },
        { path: "drafts/notes.md.bak", kind: "file" },
        { path: "notes.md", kind: "directory" },
      ]),
    ).toEqual(["archive/notes.md", "drafts/notes.md"]);
  });

  it("matches the basename of an absolute host path", () => {
    expect(
      missingFileCandidates("/Users/me/reviews/notes.md", [
        { path: "reviews/notes.md", kind: "file" },
      ]),
    ).toEqual(["reviews/notes.md"]);
  });

  it("caps the choices it offers", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `dir${index}/notes.md`,
      kind: "file" as const,
    }));
    expect(missingFileCandidates("notes.md", entries)).toHaveLength(5);
  });
});
