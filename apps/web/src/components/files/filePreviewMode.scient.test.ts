import { describe, expect, it } from "vite-plus/test";

import { keepsBoundedSourceView } from "./filePreviewMode";

describe("bounded source view", () => {
  it("keeps compute, LaTeX and BibTeX sources on their bounded view", () => {
    for (const path of ["run.py", "run.m", "paper.tex", "references.bib"]) {
      expect(keepsBoundedSourceView(path, false), path).toBe(true);
    }
  });

  it("lets ordinary text, tables and Markdown stream in full", () => {
    for (const path of ["results.csv", "notes.md", "page.html", "log.txt"]) {
      expect(keepsBoundedSourceView(path, false), path).toBe(false);
    }
  });

  it("keeps the current source while a citation is revealed", () => {
    expect(keepsBoundedSourceView("results.csv", true)).toBe(true);
  });
});
