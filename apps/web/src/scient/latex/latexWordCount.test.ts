import { describe, expect, it } from "vite-plus/test";

import { countLatexWords } from "./latexWordCount";

describe("approximate LaTeX word count", () => {
  it("counts prose and leaves out the preamble, comments and commands", () => {
    const source = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\title{Not counted here}",
      "\\begin{document}",
      "\\section{Heat transport} % a comment with many extra words",
      "Thin \\textbf{films} appear in coatings.",
      "\\end{document}",
    ].join("\n");
    // Heat transport + Thin films appear in coatings.
    expect(countLatexWords(source)).toBe(7);
  });

  it("leaves out mathematics, labels, references and citations", () => {
    const source = [
      "\\begin{document}",
      "The flux is $q = -\\kappa \\nabla T$ and \\(x^2\\) too \\cite{smith2020}.",
      "\\begin{equation}",
      "  T(x) = T_0 + x \\label{eq:one}",
      "\\end{equation}",
      "See Section~\\ref{sec:results} and \\eqref{eq:one}.",
      "\\[ a = b \\]",
      "\\end{document}",
    ].join("\n");
    // The flux is and too. + See Section and.
    expect(countLatexWords(source)).toBe(8);
  });

  it("counts captions, table cells, theorem text and link text", () => {
    const source = [
      "\\begin{document}",
      "\\begin{theorem}[Convergence] The scheme converges. \\end{theorem}",
      "\\begin{table}\\caption{Error and rate.}",
      "\\begin{tabular}{rc} Grid & Error \\\\ 16 & small \\end{tabular}\\end{table}",
      "\\href{https://example.org/a_b}{the site}",
      "\\includegraphics[width=1cm]{figures/plot.png}",
      "\\end{document}",
    ].join("\n");
    // The scheme converges. | Error and rate. | Grid Error 16 small | the site
    expect(countLatexWords(source)).toBe(12);
  });

  it("counts a file without a document environment, such as an included chapter", () => {
    expect(countLatexWords("\\section{Method}\nTwo words. % not these")).toBe(3);
    expect(countLatexWords("")).toBe(0);
  });
});
