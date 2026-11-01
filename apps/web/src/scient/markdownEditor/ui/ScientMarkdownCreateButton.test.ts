import { describe, expect, it } from "vite-plus/test";

import { normalizeMarkdownCreatePath } from "./ScientMarkdownCreateButton";

describe("Scient Markdown create paths", () => {
  it("normalizes portable relative Markdown paths", () => {
    expect(normalizeMarkdownCreatePath(" notes\\experiment ")).toBe("notes/experiment.md");
    expect(normalizeMarkdownCreatePath("paper.markdown")).toBe("paper.markdown");
    expect(normalizeMarkdownCreatePath("paper.mdx")).toBeNull();
    expect(normalizeMarkdownCreatePath("../escape.md")).toBeNull();
    expect(normalizeMarkdownCreatePath("/absolute.md")).toBeNull();
    expect(normalizeMarkdownCreatePath("notes//paper.md")).toBeNull();
  });
});
