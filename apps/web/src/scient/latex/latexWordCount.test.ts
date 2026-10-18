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

  it("keeps a word whole across accents, grouping braces and escaped characters", () => {
    expect(countLatexWords("caf\\'e")).toBe(1);
    expect(countLatexWords('na\\"{\\i}ve Erd\\H{o}s Fran\\c{c}ois')).toBe(3);
    expect(countLatexWords("co{oper}ate")).toBe(1);
    expect(countLatexWords("a rate of 100\\% is \\$5 well spent")).toBe(8);
    expect(countLatexWords("\\begin{document}{Hello world}\\end{document}")).toBe(2);
  });

  it("treats literal code as code, not as comments or prose", () => {
    // \verb|a%| is one item, and the percent sign in it starts no comment.
    expect(countLatexWords("\\verb|a%| tail words")).toBe(3);
    expect(
      countLatexWords(
        "Before.\n\\begin{lstlisting}[language=Python]\nx = 1 % not a comment\n\\end{lstlisting}\nAfter.",
      ),
    ).toBe(2);
    expect(countLatexWords("Price \\$5 and $x = \\$ + 1$ done")).toBe(4);
  });

  it("stays fast when many delimiters are never closed", () => {
    const source = `${"Some words here \\[ never closed \\begin{equation} $ \n".repeat(20000)}`;
    const started = performance.now();
    expect(countLatexWords(source)).toBeGreaterThan(40000);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("does not read the percent sign of an address as a comment", () => {
    expect(countLatexWords("\\url{https://example.test/a%20b} after words.")).toBe(2);
    expect(countLatexWords("\\href{https://example.test/a%20b}{the site} is here")).toBe(4);
    expect(countLatexWords("See \\path{C:/a%b/c.tex} now")).toBe(2);
  });

  it("stays fast on one very long line of literal code or unfinished options", () => {
    for (const source of [
      "\\verb|x| word ".repeat(40000),
      "\\verb|never closed ".repeat(40000),
      "\\textbf[ word ".repeat(40000),
      "\\url{never closed ".repeat(40000),
      "\\begin{never closed ".repeat(40000),
      `${"\\url{one far closer ".repeat(40000)}}`,
    ]) {
      const started = performance.now();
      expect(countLatexWords(source)).toBeGreaterThan(30000);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it("counts a file without a document environment, such as an included chapter", () => {
    expect(countLatexWords("\\section{Method}\nTwo words. % not these")).toBe(3);
    expect(countLatexWords("")).toBe(0);
  });
});
