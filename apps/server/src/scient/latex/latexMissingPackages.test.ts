import { describe, expect, it } from "vite-plus/test";

import {
  extractMissingLatexInputs,
  missingLatexPackages,
  packageNameForMissingInput,
} from "./latexMissingPackages.ts";

/** What a TinyTeX base install prints for a document that uses `mathtools`. */
const MATHTOOLS_TRANSCRIPT = [
  "This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2026)",
  "entering extended mode",
  "(./main.tex",
  "LaTeX2e <2026-06-01>",
  "./main.tex:3: LaTeX Error: File `mathtools.sty' not found.",
  "",
  "Type X to quit or <RETURN> to proceed,",
  "or enter new name. (Default extension: sty)",
  "",
  "! Emergency stop.",
  "",
].join("\n");

describe("extractMissingLatexInputs", () => {
  it("reads the file out of the error a base TinyTeX install prints", () => {
    expect(extractMissingLatexInputs(MATHTOOLS_TRANSCRIPT)).toEqual(["mathtools.sty"]);
  });

  it("reads a missing document class the same way", () => {
    const transcript = "./main.tex:1: LaTeX Error: File `revtex4-2.cls' not found.\n";

    expect(extractMissingLatexInputs(transcript)).toEqual(["revtex4-2.cls"]);
  });

  it("reads TeX's own prompt and latexmk's summary of it", () => {
    const transcript = [
      "! I can't find file `chapters/intro.tex'.",
      "<*> chapters/intro",
      "Latexmk: Missing input file: 'siunitx.sty' from line",
      "  '! LaTeX Error: File `siunitx.sty' not found.'",
    ].join("\n");

    // The same failure is reported twice; one name comes back.
    expect(extractMissingLatexInputs(transcript)).toEqual(["siunitx.sty", "chapters/intro.tex"]);
  });

  it("reads tectonic's labelled wording", () => {
    const transcript = [
      "error: main.tex:4: file `booktabs.sty' not found",
      "error: unable to open file `unicode-math.sty'",
    ].join("\n");

    expect(extractMissingLatexInputs(transcript)).toEqual(["booktabs.sty", "unicode-math.sty"]);
  });

  it("normalizes the printed path and finds nothing in an ordinary run", () => {
    expect(extractMissingLatexInputs("! LaTeX Error: File `./sub\\pkg.sty' not found.")).toEqual([
      "sub/pkg.sty",
    ]);
    expect(extractMissingLatexInputs("Output written on main.pdf (3 pages).")).toEqual([]);
  });

  it("stops at ten, so a preamble that goes wrong early cannot run away", () => {
    const transcript = Array.from(
      { length: 25 },
      (_unused, index) => `! LaTeX Error: File \`pkg${String(index)}.sty' not found.`,
    ).join("\n");

    expect(extractMissingLatexInputs(transcript)).toHaveLength(10);
  });
});

describe("packageNameForMissingInput", () => {
  it("maps package and class files to the package that ships them", () => {
    expect(packageNameForMissingInput("mathtools.sty")).toBe("mathtools");
    expect(packageNameForMissingInput("revtex4-2.cls")).toBe("revtex4-2");
    expect(packageNameForMissingInput("texmf/tex/latex/foo/foo.STY")).toBe("foo");
  });

  it("maps the author's own files to nothing at all", () => {
    // No repository has these, and offering to install one would be a lie.
    expect(packageNameForMissingInput("chapters/intro.tex")).toBeNull();
    expect(packageNameForMissingInput("references.bib")).toBeNull();
    expect(packageNameForMissingInput("figures/plot.pdf")).toBeNull();
    expect(packageNameForMissingInput("logo.png")).toBeNull();
    expect(packageNameForMissingInput("intro")).toBeNull();
    expect(packageNameForMissingInput(".sty")).toBeNull();
    // Nothing a package manager would be asked for by that name.
    expect(packageNameForMissingInput("two words.sty")).toBeNull();
  });
});

describe("missingLatexPackages", () => {
  it("answers only what a repository could supply, once each", () => {
    const transcript = [
      MATHTOOLS_TRANSCRIPT,
      "! LaTeX Error: File `mathtools.sty' not found.",
      "! I can't find file `chapters/intro.tex'.",
      "! LaTeX Error: File `revtex4-2.cls' not found.",
    ].join("\n");

    expect(missingLatexPackages(transcript)).toEqual(["mathtools", "revtex4-2"]);
  });
});
