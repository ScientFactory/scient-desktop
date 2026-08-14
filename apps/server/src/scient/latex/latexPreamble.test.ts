import { describe, expect, it } from "@effect/vitest";

import {
  latexPreambleIncludes,
  latexPreamblePackages,
  stripLatexComments,
} from "./latexPreamble.ts";

const PREAMBLE = [
  "\\documentclass[11pt]{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage{amsmath,amssymb, mathtools}",
  "\\RequirePackage{etoolbox}",
  "% \\usepackage{neverwanted}",
  "\\usepackage{microtype} % 50\\% of the reason this looks right",
  "\\begin{document}",
].join("\n");

describe("stripLatexComments", () => {
  it("drops what a comment introduces and keeps an escaped percent sign", () => {
    expect(stripLatexComments("a % b")).toBe("a ");
    expect(stripLatexComments("50\\% off % but not this")).toBe("50\\% off ");
    // `\\` is a line break, so the percent after it starts a comment.
    expect(stripLatexComments("x \\\\% comment")).toBe("x \\\\");
  });
});

describe("latexPreamblePackages", () => {
  it("reads every package the source asks for, once, in order", () => {
    expect(latexPreamblePackages(PREAMBLE)).toEqual([
      "inputenc",
      "amsmath",
      "amssymb",
      "mathtools",
      "etoolbox",
      "microtype",
    ]);
  });

  it("never reads a commented-out request, and never returns something that is not a name", () => {
    expect(latexPreamblePackages("% \\usepackage{mathtools}")).toEqual([]);
    // A name built from a macro is not a name this can act on, and a leading
    // dash is an option to `tlmgr`.
    expect(latexPreamblePackages("\\usepackage{\\mypkg}\n\\usepackage{-gui}")).toEqual([]);
    // An option group carrying its own braces does not swallow the name.
    expect(latexPreamblePackages("\\usepackage[a=b]{geometry}")).toEqual(["geometry"]);
  });

  it("is bounded, so a generated file cannot become a giant tlmgr argv", () => {
    const many = Array.from(
      { length: 80 },
      (_unused, index) => `\\usepackage{pkg${String(index)}}`,
    );
    expect(latexPreamblePackages(many.join("\n"))).toHaveLength(40);
  });
});

describe("latexPreambleIncludes", () => {
  it("supplies the extension the author left off and keeps the path relative", () => {
    expect(
      latexPreambleIncludes(
        "\\input{sections/intro}\n\\include{appendix.tex}\n\\input{macros.sty}",
      ),
    ).toEqual(["sections/intro.tex", "appendix.tex", "macros.sty"]);
  });

  it("never hands back a path that leaves the document's own directory", () => {
    expect(
      latexPreambleIncludes(
        ["\\input{../secrets}", "\\input{/etc/passwd}", "\\input{C:/other/x}"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("stops at one level's worth of files", () => {
    const many = Array.from({ length: 20 }, (_unused, index) => `\\input{part${String(index)}}`);
    expect(latexPreambleIncludes(many.join("\n"))).toHaveLength(8);
  });
});
