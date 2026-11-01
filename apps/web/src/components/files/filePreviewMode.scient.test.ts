import { describe, expect, it } from "vite-plus/test";

import { shouldUseLargeTextPreview } from "./filePreviewMode";

describe("large text admission", () => {
  const input = { path: "results.csv", truncated: true, draft: false, citationRevealActive: false };

  it("streams truncated ordinary text and tables while preserving source owners", () => {
    expect(shouldUseLargeTextPreview(input)).toBe(true);
    for (const path of [
      "run.py",
      "run.m",
      "paper.tex",
      "references.bib",
      "notes.md",
      "diagram.mmd",
      "page.html",
      "saved.ipynb",
    ]) {
      expect(shouldUseLargeTextPreview({ ...input, path }), path).toBe(false);
    }
  });

  it("retains the current source for drafts, whole files and citation reveals", () => {
    expect(shouldUseLargeTextPreview({ ...input, path: null })).toBe(false);
    expect(shouldUseLargeTextPreview({ ...input, draft: true })).toBe(false);
    expect(shouldUseLargeTextPreview({ ...input, truncated: false })).toBe(false);
    expect(shouldUseLargeTextPreview({ ...input, citationRevealActive: true })).toBe(false);
  });
});
