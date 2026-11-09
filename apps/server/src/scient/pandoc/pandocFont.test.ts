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
