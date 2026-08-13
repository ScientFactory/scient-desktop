import { describe, expect, it } from "vite-plus/test";

import { isLatexSourcePath, resolveLatexRoot } from "./latexRoot.ts";

describe("isLatexSourcePath", () => {
  it("recognizes LaTeX source extensions case-insensitively", () => {
    expect(isLatexSourcePath("paper/main.tex")).toBe(true);
    expect(isLatexSourcePath("MAIN.TEX")).toBe(true);
    expect(isLatexSourcePath("notes.latex")).toBe(true);
    expect(isLatexSourcePath("legacy.ltx")).toBe(true);
    expect(isLatexSourcePath("readme.md")).toBe(false);
    expect(isLatexSourcePath("main.tex.bak")).toBe(false);
  });
});

describe("resolveLatexRoot", () => {
  it("follows a magic root comment relative to the declaring file", () => {
    const resolution = resolveLatexRoot({
      relativePath: "sections/intro.tex",
      contents: "% !TEX root = ../main.tex\nHello",
    });

    expect(resolution).toEqual({ rootRelativePath: "main.tex", reason: "magic-comment" });
  });

  it("reads the magic comment case-insensitively with quotes", () => {
    const resolution = resolveLatexRoot({
      relativePath: "a/b/child.tex",
      contents: '%!tex ROOT = "sub/root.tex"',
    });

    expect(resolution).toEqual({ rootRelativePath: "a/b/sub/root.tex", reason: "magic-comment" });
  });

  it("treats a documentclass file as its own root", () => {
    const resolution = resolveLatexRoot({
      relativePath: "main.tex",
      contents: "\\documentclass{article}\n\\begin{document}hi\\end{document}",
    });

    expect(resolution).toEqual({ rootRelativePath: "main.tex", reason: "documentclass" });
  });

  it("ignores a commented-out documentclass", () => {
    const resolution = resolveLatexRoot({
      relativePath: "fragment.tex",
      contents: "% \\documentclass{article}\nJust a fragment.",
    });

    expect(resolution.reason).toBe("fallback-self");
  });

  it("falls back to the file itself and normalizes separators", () => {
    const resolution = resolveLatexRoot({
      relativePath: "sections\\intro.tex",
      contents: "no markers here",
    });

    expect(resolution).toEqual({
      rootRelativePath: "sections/intro.tex",
      reason: "fallback-self",
    });
  });

  it("rejects a magic root that is not a LaTeX source file", () => {
    const resolution = resolveLatexRoot({
      relativePath: "notes.tex",
      contents: "% !TEX root = ../Makefile",
    });

    expect(resolution.reason).toBe("fallback-self");
  });
});
