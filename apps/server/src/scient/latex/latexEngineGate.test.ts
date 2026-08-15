import { describe, expect, it } from "@effect/vitest";

import { evaluateLatexEngineGate } from "./latexEngineGate.ts";

const PLAIN_PDFLATEX_DOCUMENT = [
  "\\documentclass[11pt]{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage{amsmath,amssymb, mathtools}",
  "\\RequirePackage{etoolbox}",
  "\\begin{document}",
  "Hello, world.",
  "\\end{document}",
].join("\n");

describe("evaluateLatexEngineGate", () => {
  it("passes a plain pdfLaTeX document", () => {
    expect(evaluateLatexEngineGate({ rootText: PLAIN_PDFLATEX_DOCUMENT })).toEqual({
      supported: true,
    });
  });

  it("passes an empty document", () => {
    expect(evaluateLatexEngineGate({ rootText: "" })).toEqual({ supported: true });
  });

  describe("the % !TEX program magic comment", () => {
    it.each([
      { source: "% !TEX program = xelatex", requiredEngine: "xelatex" },
      { source: "% !TEX program = xetex", requiredEngine: "xelatex" },
      { source: "% !TEX program = lualatex", requiredEngine: "lualatex" },
      { source: "% !TEX program = luatex", requiredEngine: "lualatex" },
    ] as const)("reads $source", ({ source, requiredEngine }) => {
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({ supported: false, requiredEngine, evidence: source });
    });

    it("reads the TS-program spelling TeXShop writes", () => {
      const verdict = evaluateLatexEngineGate({ rootText: "% !TEX TS-program = xelatex" });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "xelatex" });
    });

    it("is case-insensitive on the whole directive", () => {
      const verdict = evaluateLatexEngineGate({ rootText: "% !tex ts-program = LuaTeX" });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "lualatex" });
    });

    it("tolerates the whitespace variations real editors write", () => {
      const noSpaceAfterPercent = evaluateLatexEngineGate({
        rootText: "%!TEX program=xelatex",
      });
      expect(noSpaceAfterPercent).toMatchObject({ supported: false, requiredEngine: "xelatex" });

      const extraSpaces = evaluateLatexEngineGate({
        rootText: "%   !TEX    program   =   lualatex",
      });
      expect(extraSpaces).toMatchObject({ supported: false, requiredEngine: "lualatex" });

      const doublePercent = evaluateLatexEngineGate({
        rootText: "%% !TEX program = xelatex",
      });
      expect(doublePercent).toMatchObject({ supported: false, requiredEngine: "xelatex" });

      const leadingWhitespace = evaluateLatexEngineGate({
        rootText: "   % !TEX program = xelatex",
      });
      expect(leadingWhitespace).toMatchObject({ supported: false, requiredEngine: "xelatex" });
    });

    it("surfaces the matched line verbatim (trimmed) as evidence", () => {
      const source = "   % !TEX program = xelatex   ";
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({ supported: false, evidence: source.trim() });
    });

    it("finds the directive anywhere in the document, not only the first line", () => {
      const source = [
        "\\documentclass{article}",
        "% a comment about nothing in particular",
        "% !TEX program = lualatex",
        "\\begin{document}",
      ].join("\n");
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({
        supported: false,
        requiredEngine: "lualatex",
        evidence: "% !TEX program = lualatex",
      });
    });

    it("ignores an engine name it does not recognize, rather than flagging it", () => {
      // pdflatex named explicitly is fine; some other token is left alone too,
      // since this gate only knows what to say about xelatex/lualatex.
      expect(evaluateLatexEngineGate({ rootText: "% !TEX program = pdflatex" })).toEqual({
        supported: true,
      });
      expect(evaluateLatexEngineGate({ rootText: "% !TEX program = context" })).toEqual({
        supported: true,
      });
    });

    it("does not fire on a magic-comment-shaped line missing the ! marker", () => {
      expect(evaluateLatexEngineGate({ rootText: "% TEX program = xelatex" })).toEqual({
        supported: true,
      });
    });
  });

  describe("engine-only packages", () => {
    it("flags \\usepackage{fontspec}", () => {
      const source = "\\usepackage{fontspec}";
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({
        supported: false,
        requiredEngine: "xelatex",
        evidence: source,
      });
    });

    it("flags \\usepackage{unicode-math}", () => {
      const verdict = evaluateLatexEngineGate({ rootText: "\\usepackage{unicode-math}" });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "xelatex" });
    });

    it("flags \\RequirePackage{fontspec} and \\RequirePackage{unicode-math}", () => {
      expect(evaluateLatexEngineGate({ rootText: "\\RequirePackage{fontspec}" })).toMatchObject({
        supported: false,
        requiredEngine: "xelatex",
      });
      expect(evaluateLatexEngineGate({ rootText: "\\RequirePackage{unicode-math}" })).toMatchObject(
        { supported: false, requiredEngine: "xelatex" },
      );
    });

    it("flags fontspec named alongside other packages in one load", () => {
      const source = "\\usepackage{amsmath, fontspec, geometry}";
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({
        supported: false,
        requiredEngine: "xelatex",
        evidence: source,
      });
    });

    it("flags fontspec loaded with an options group", () => {
      const source = "\\usepackage[no-math]{fontspec}";
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "xelatex" });
    });

    it("does NOT flag fontspec mentioned in a fully commented-out line", () => {
      expect(evaluateLatexEngineGate({ rootText: "% \\usepackage{fontspec}" })).toEqual({
        supported: true,
      });
      expect(evaluateLatexEngineGate({ rootText: "  %\\usepackage{unicode-math}" })).toEqual({
        supported: true,
      });
    });

    it("does NOT flag fontspec mentioned only after a trailing comment marker", () => {
      // The package load on this line is `geometry`; "fontspec" only appears
      // in prose after the `%`, which comment-stripping must remove before
      // the package pattern ever sees it.
      const source = "\\usepackage{geometry} % not fontspec, just talking about it";
      expect(evaluateLatexEngineGate({ rootText: source })).toEqual({ supported: true });
    });

    it("still flags a real load on a line that also carries a trailing comment", () => {
      const source = "\\usepackage{fontspec} % for the display font";
      const verdict = evaluateLatexEngineGate({ rootText: source });
      expect(verdict).toMatchObject({
        supported: false,
        requiredEngine: "xelatex",
        // Evidence is the whole verbatim line, comment included, not just the
        // stripped part the detector matched against.
        evidence: source,
      });
    });

    it("does not confuse an unrelated package for fontspec", () => {
      expect(evaluateLatexEngineGate({ rootText: "\\usepackage{fontspecish}" })).toEqual({
        supported: true,
      });
    });
  });

  describe("checked texts beyond the root", () => {
    it("checks included texts when the root itself is clean", () => {
      const verdict = evaluateLatexEngineGate({
        rootText: PLAIN_PDFLATEX_DOCUMENT,
        includedTexts: ["\\usepackage{fontspec}"],
      });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "xelatex" });
    });

    it("passes when every text handed in is clean", () => {
      const verdict = evaluateLatexEngineGate({
        rootText: PLAIN_PDFLATEX_DOCUMENT,
        includedTexts: ["\\usepackage{geometry}", "% just a note"],
      });
      expect(verdict).toEqual({ supported: true });
    });

    it("prefers a magic-comment verdict over a package-load verdict found elsewhere", () => {
      const verdict = evaluateLatexEngineGate({
        rootText: "% !TEX program = lualatex",
        includedTexts: ["\\usepackage{fontspec}"],
      });
      expect(verdict).toMatchObject({ supported: false, requiredEngine: "lualatex" });
    });
  });

  it("names the package and the found line in the unsupported message", () => {
    const source = "\\usepackage{fontspec}";
    const verdict = evaluateLatexEngineGate({ rootText: source });
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) {
      expect(verdict.message).toContain("pdfLaTeX only");
      expect(verdict.message).toContain("fontspec");
      expect(verdict.message).toContain(source);
    }
  });

  it("names the requested engine and the found line in the magic-comment message", () => {
    const source = "% !TEX program = xelatex";
    const verdict = evaluateLatexEngineGate({ rootText: source });
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) {
      expect(verdict.message).toContain("pdfLaTeX only");
      expect(verdict.message).toContain("XeLaTeX");
      expect(verdict.message).toContain(source);
    }
  });
});
