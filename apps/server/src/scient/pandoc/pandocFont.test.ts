/**
 * Word font handling that needs no Pandoc: the LaTeX size-group rewrite and the base font reads.
 */
import { describe, expect, it } from "vite-plus/test";

import { latexBaseFontOf, rewriteLatexSizeGroups } from "./pandocFont.ts";

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
