/**
 * Word font handling that needs no Pandoc: the LaTeX size-group rewrite and the base font reads.
 */
import { FONT_CATALOGUE } from "@scientfactory/scient-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFontSpans,
  type FontPass,
  latexBaseFontOf,
  rewriteLatexSizeGroups,
} from "./pandocFont.ts";
import { scientReferenceDocumentParts, type WordLocalFont } from "./scientReferenceDocument.ts";

const carrier = (name: string, body: string) => `\\ScientSize{scient-size-${name}}{${body}}`;

describe("rewriteLatexSizeGroups", () => {
  it("rewrites a size group and leaves the rest of the source unchanged", () => {
    const rewritten = rewriteLatexSizeGroups("A {\\Large big} B");
    expect(rewritten).toContain(`A ${carrier("14p4", "big")} B`);
    expect(rewritten.startsWith("\\newcommand{\\ScientSize}")).toBe(true);
  });

  it("keeps nested groups and family commands inside the body", () => {
    expect(rewriteLatexSizeGroups("{\\large a {\\small b} \\textsf{c}}")).toContain(
      carrier("12", `a ${carrier("9", "b")} \\textsf{c}`),
    );
  });

  it("returns the source untouched when it has no size group", () => {
    const source = "Plain {grouped} text with \\textbf{bold}.";
    expect(rewriteLatexSizeGroups(source)).toBe(source);
  });

  it("does not touch escaped braces, comments, math or an unbalanced group", () => {
    for (const source of [
      "\\{\\Large not a group\\}",
      "% {\\Large in a comment}\nText",
      "Math $a {\\large b}$ here",
      "Open {\\Large never closed",
    ]) {
      expect(rewriteLatexSizeGroups(source)).toBe(source);
    }
  });

  it("leaves a size command inside a command argument alone", () => {
    for (const source of [
      "\\textbf{\\large x}",
      "\\section{\\large Title}",
      "\\newcommand{\\a}{\\small z}",
      "\\begin{tabular}{l}\\\\[2pt]\\end{tabular}",
    ]) {
      expect(rewriteLatexSizeGroups(source)).toBe(source);
    }
  });

  it("does not touch verbatim environments or bracket math", () => {
    for (const source of [
      "\\begin{verbatim}{\\large x}\\end{verbatim}",
      "\\begin{lstlisting}\n{\\large x}\n\\end{lstlisting}",
      "\\[ a {\\large b} \\]",
      "\\( a {\\large b} \\)",
    ]) {
      expect(rewriteLatexSizeGroups(source)).toBe(source);
    }
  });

  it("still rewrites a group after bracket math", () => {
    expect(rewriteLatexSizeGroups("\\[ a \\] {\\large x}")).toContain(carrier("12", "x"));
  });

  it("does not match a longer command that starts with a size name", () => {
    const source = "{\\largesse text}";
    expect(rewriteLatexSizeGroups(source)).toBe(source);
  });
});

describe("latexBaseFontOf", () => {
  it("reads the class option and the default family", () => {
    expect(
      latexBaseFontOf(
        "\\documentclass[a4paper,12pt]{article}\n\\renewcommand{\\familydefault}{\\ttdefault}",
      ),
    ).toEqual({ sizePoints: 12, family: "Courier New" });
  });

  it("keeps the Word default when nothing is set", () => {
    expect(latexBaseFontOf("\\documentclass{article}")).toEqual({
      sizePoints: 11,
      family: null,
    });
  });
});

describe("local fonts become Word character styles", () => {
  const raw = (html: string) => ({ t: "RawInline", c: ["html", html] });
  const close = raw("</span>");
  const word = { t: "Str", c: "word" };
  const pass = (): FontPass => ({
    base: { sizePoints: 11, family: null },
    used: new Map<string, WordLocalFont>(),
  });
  const stylesOf = (inlines: unknown) =>
    JSON.stringify(inlines).match(/custom-style","([^"]*)/gu) ?? [];

  it("names an absolute size in points", () => {
    const text = [{ t: "Para", c: [raw('<span style="font-size:13.5pt">'), word, close] }];
    const used = pass();
    applyFontSpans(text, used);
    expect(stylesOf(text)).toEqual(['custom-style","13.5 pt']);
    expect([...used.used.keys()]).toEqual(["13.5 pt"]);
  });

  it("names a font and combines a nested size and font in one style", () => {
    const text = [
      {
        t: "Para",
        c: [
          raw('<span style="font-size:14pt">'),
          raw("<span style=\"font-family:'Times New Roman'\">"),
          word,
          close,
          close,
        ],
      },
    ];
    const used = pass();
    applyFontSpans(text, used);
    expect(stylesOf(text).at(-1)).toBe('custom-style","Times New Roman 14 pt');
    expect(used.used.has("Times New Roman 14 pt")).toBe(true);
  });

  it("leaves a name outside the catalogue as plain source", () => {
    const text = [
      { t: "Para", c: [raw("<span style=\"font-family:'Comic Sans'\">"), word, close] },
    ];
    applyFontSpans(text, pass());
    expect(stylesOf(text)).toEqual([]);
  });

  it("defines each used style with half-point sizes and the right fonts", () => {
    const styles = scientReferenceDocumentParts({ sizePoints: 11, family: null }, [
      { size: 13.3, family: "Arial" },
      { family: "Times New Roman" },
    ]).find(([name]) => name === "word/styles.xml")?.[1];
    // 13.3 pt rounds to 26.5 pt, written as 27 half points.
    expect(styles).toMatch(/w:styleId="ScientArial13_3pt"[\s\S]*?<w:sz w:val="27"/u);
    expect(styles).toContain('w:ascii="Times New Roman" w:hAnsi="Times New Roman"');
    expect(styles).toContain('w:cs="Times New Roman"');
  });
});

describe("LaTeX font sizes", () => {
  it("reads a fontsize group in points", () => {
    expect(rewriteLatexSizeGroups("A {\\fontsize{13}{15.6}\\selectfont big} B")).toContain(
      `A ${carrier("13", "big")} B`,
    );
  });

  it("keeps a decimal size and a leading space after selectfont{}", () => {
    expect(rewriteLatexSizeGroups("{\\fontsize{13.5}{16}\\selectfont{} x}")).toContain(
      carrier("13p5", " x"),
    );
  });

  it("maps a named size through the class option", () => {
    const source = "\\documentclass[12pt]{article}\n{\\large x}";
    expect(rewriteLatexSizeGroups(source)).toContain(carrier("14p4", "x"));
    expect(rewriteLatexSizeGroups("{\\large x}")).toContain(carrier("12", "x"));
  });

  it("ignores a commented class option and a commented family default", () => {
    const source =
      "%\\documentclass[12pt]{article}\n% \\renewcommand{\\familydefault}{\\ttdefault}";
    expect(latexBaseFontOf(source)).toEqual({ sizePoints: 11, family: null });
  });

  it("rewrites a font family group in both written forms", () => {
    const index = FONT_CATALOGUE.findIndex((font) => font.name === "Times New Roman");
    const code = rewriteLatexSizeGroups("{\\fontfamily{qtm}\\selectfont serif}");
    expect(code).toContain(`\\ScientSize{scient-font-${index}}{serif}`);
    const named = rewriteLatexSizeGroups(
      "{\\IfFontExistsTF{Times New Roman}{\\fontspec{Times New Roman}}{\\fontspec{Latin Modern Roman}} serif}",
    );
    expect(named).toContain(`\\ScientSize{scient-font-${index}}{serif}`);
  });
});
