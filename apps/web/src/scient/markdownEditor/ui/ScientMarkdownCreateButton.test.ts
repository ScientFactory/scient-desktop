import { describe, expect, it } from "vite-plus/test";

import { normalizeMarkdownCreatePath, untitledMarkdownPath } from "./ScientMarkdownCreateButton";

describe("Scient Markdown create paths", () => {
  it("normalizes portable relative Markdown paths", () => {
    expect(normalizeMarkdownCreatePath(" notes\\experiment ")).toBe("notes/experiment.md");
    expect(normalizeMarkdownCreatePath("paper.markdown")).toBe("paper.markdown");
    expect(normalizeMarkdownCreatePath("paper.mdx")).toBeNull();
    expect(normalizeMarkdownCreatePath("../escape.md")).toBeNull();
    expect(normalizeMarkdownCreatePath("/absolute.md")).toBeNull();
    expect(normalizeMarkdownCreatePath("notes//paper.md")).toBeNull();
  });

  it("proposes collision suffixes beside the selected document", () => {
    expect(untitledMarkdownPath("papers/current.md")).toBe("papers/untitled.md");
    expect(untitledMarkdownPath("papers/current.md", 3)).toBe("papers/untitled-3.md");
    expect(untitledMarkdownPath(null, 2)).toBe("untitled-2.md");
  });
});
