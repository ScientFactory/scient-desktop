/**
 * Word font handling that needs no Pandoc: the LaTeX size-group rewrite and the base font reads.
 */
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
    expect(rewritten).toContain(`A ${carrier("Large", "big")} B`);
    expect(rewritten.startsWith("\\newcommand{\\ScientSize}")).toBe(true);
  });

  it("keeps nested groups and family commands inside the body", () => {
    expect(rewriteLatexSizeGroups("{\\large a {\\small b} \\textsf{c}}")).toContain(
      carrier("large", `a ${carrier("small", "b")} \\textsf{c}`),
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
    expect(rewriteLatexSizeGroups("\\[ a \\] {\\large x}")).toContain(carrier("large", "x"));
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
    ).toEqual({ sizePoints: 12, family: "monospace" });
  });

  it("keeps the Word default when nothing is set", () => {
    expect(latexBaseFontOf("\\documentclass{article}")).toEqual({
      sizePoints: 11,
      family: "sans-serif",
    });
  });
});

describe("a local size keeps its share of the surrounding text", () => {
  const open = { t: "RawInline", c: ["html", '<span style="font-size:1.2em">'] };
  const close = { t: "RawInline", c: ["html", "</span>"] };
  const word = { t: "Str", c: "word" };
  const pass = (sizePoints = 11): FontPass => ({
    base: { sizePoints, family: "sans-serif" },
    inContext: new Map<string, WordLocalFont>(),
  });
  const attributes = ["", [], []];
  const styleOf = (inlines: Array<unknown>) =>
    JSON.stringify(inlines).match(/Scient[^"]*/u)?.[0] ?? null;

  it("names the heading size in the style of a size set inside a heading", () => {
    const heading = [{ t: "Header", c: [1, attributes, [open, word, close]] }];
    const used = pass();
    applyFontSpans(heading, used);
    expect(styleOf(heading)).toBe("Scient Size 120% of 18pt");
    expect([...used.inContext.keys()]).toEqual(["Scient Size 120% of 18pt"]);
  });

  it("uses the footnote size inside a footnote", () => {
    const note = [{ t: "Para", c: [{ t: "Note", c: [{ t: "Para", c: [open, word, close] }] }] }];
    const used = pass();
    applyFontSpans(note, used);
    expect(styleOf(note)).toBe("Scient Size 120% of 9pt");
  });

  it("keeps the plain style in a paragraph, and in a heading the size of the base", () => {
    const text = [{ t: "Para", c: [open, word, close] }];
    const same = [{ t: "Header", c: [5, attributes, [open, word, close]] }];
    const used = pass();
    applyFontSpans(text, used);
    applyFontSpans(same, used);
    expect(styleOf(text)).toBe("Scient Size 120%");
    expect(styleOf(same)).toBe("Scient Size 120%");
    expect(used.inContext.size).toBe(0);
  });

  it("writes the style of a heading size with the heading size times the share", () => {
    const font = { em: 1.2, context: 18 };
    const styles = scientReferenceDocumentParts(undefined, [font]).find(
      ([name]) => name === "word/styles.xml",
    )?.[1];
    // 1.2 x 18 pt = 21.6 pt, kept to the half point: 21.5 pt, which Word writes as 43.
    expect(styles).toMatch(
      /<w:style [^>]*w:styleId="ScientSize120of18pt"(?:(?!<\/w:style>)[\s\S])*?<w:sz w:val="43"/u,
    );
  });

  it("does not carry the font around a footnote reference into the footnote text", () => {
    const family = { t: "RawInline", c: ["html", '<span style="font-family:monospace">'] };
    const text = [
      {
        t: "Para",
        c: [open, { t: "Note", c: [{ t: "Para", c: [family, word, close] }] }, close],
      },
    ];
    applyFontSpans(text, pass());
    expect(JSON.stringify(text)).toContain("Scient Font monospace");
    expect(JSON.stringify(text)).not.toContain("120% of 9pt Font");
  });

  it("combines a size and a family in a heading", () => {
    const family = { t: "RawInline", c: ["html", '<span style="font-family:serif">'] };
    const heading = [{ t: "Header", c: [2, attributes, [open, family, word, close, close]] }];
    const used = pass();
    applyFontSpans(heading, used);
    // Pandoc keeps only the innermost style of a run, so the innermost one names both.
    expect(
      JSON.stringify(heading)
        .match(/Scient[^"]*/gu)
        ?.at(-1),
    ).toBe("Scient Size 120% of 15pt Font serif");
    expect(used.inContext.has("Scient Size 120% of 15pt Font serif")).toBe(true);
  });
});
