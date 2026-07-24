import { describe, expect, it } from "vitest";

import { extractMessageArtifacts } from "./messageArtifacts";

describe("extractMessageArtifacts", () => {
  it("returns linked HTML and Markdown documents in citation order", () => {
    expect(
      extractMessageArtifacts(
        "Open [Heart failure](topics/cardiology/heart-failure.html) and [review notes](notes/review.md).",
        "/study",
      ),
    ).toEqual([
      { path: "/study/topics/cardiology/heart-failure.html", label: "Heart failure", kind: "html" },
      { path: "/study/notes/review.md", label: "review notes", kind: "markdown" },
    ]);
  });

  it("deduplicates files and humanizes filename-only labels", () => {
    expect(
      extractMessageArtifacts(
        "[heart-failure.html](./heart-failure.html) and [again](./heart-failure.html)",
        "/study",
      ),
    ).toEqual([{ path: "/study/heart-failure.html", label: "Heart failure", kind: "html" }]);
  });

  it("ignores images, code examples, external links, and other file types", () => {
    expect(
      extractMessageArtifacts(
        [
          "![preview](lesson.html)",
          "`[inline](notes.md)`",
          "```md\n[example](draft.md)\n```",
          "[website](https://example.com/page.html)",
          "[source](src/index.ts)",
        ].join("\n"),
        "/study",
      ),
    ).toEqual([]);
  });
});
