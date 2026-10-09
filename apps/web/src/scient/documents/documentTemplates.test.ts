import { describe, expect, it } from "vite-plus/test";

import { latexDocumentLanguage } from "../latex/latexLanguage";
import {
  createNewDocumentSource,
  isUntouchedNewLatexDocument,
  newDocumentCandidate,
  newDocumentStem,
  newDocumentTitle,
  sameTitleText,
  switchNewLatexDocument,
  templateHasTitle,
} from "./documentTemplates";

const article = createNewDocumentSource({
  format: "latex",
  template: "article",
  language: "english",
});

describe("new documents", () => {
  it("names the file from the title", () => {
    expect(newDocumentStem("Spectral bounds for random graphs")).toBe(
      "spectral-bounds-for-random-graphs",
    );
    expect(newDocumentStem("  Étude: Q&A / 2026 ")).toBe("étude-q-a-2026");
    expect(newDocumentStem("גבולות ספקטרליים")).toBe("גבולות-ספקטרליים");
    expect(newDocumentStem("")).toBe("untitled");
    expect(newDocumentStem("../..")).toBe("untitled");
    expect(newDocumentStem("a".repeat(200))).toHaveLength(80);
  });

  it("numbers further attempts and keeps the folder", () => {
    expect(newDocumentCandidate("untitled", "latex", 1)).toBe("untitled.tex");
    expect(newDocumentCandidate("untitled", "markdown", 3)).toBe("untitled-3.md");
    expect(newDocumentCandidate("notes", "latex", 2, "papers/")).toBe("papers/notes-2.tex");
  });

  it("starts with an empty title for the person to write", () => {
    expect(
      createNewDocumentSource({ format: "markdown", template: "blank", language: "english" }),
    ).toBe("# \n");
    expect(article).toContain("\\title{}");
    expect(article).toContain("\\begin{abstract}");
    expect(newDocumentTitle(article, "latex")).toBe("");
  });

  it("reads the title a document gives itself", () => {
    expect(newDocumentTitle("# Lab notebook\n\nText", "markdown")).toBe("Lab notebook");
    expect(newDocumentTitle("#   \n", "markdown")).toBe("");
    expect(
      newDocumentTitle(
        article.replace("\\title{}", "\\title{Bounds \\& {\\em sharp} limits}"),
        "latex",
      ),
    ).toBe("Bounds sharp limits");
  });

  it("allows a template change only while nothing but the title was written", () => {
    const titled = article.replace("\\title{}", "\\title{Mixing times}");
    expect(isUntouchedNewLatexDocument(titled, "article", "english")).toBe(true);
    expect(isUntouchedNewLatexDocument(titled + "%", "article", "english")).toBe(false);
    expect(
      isUntouchedNewLatexDocument(
        titled.replace("Present what you found.", "We found it."),
        "article",
        "english",
      ),
    ).toBe(false);
    const report = switchNewLatexDocument(titled, "report", "english");
    expect(report).toContain("\\title{Mixing times}");
    expect(isUntouchedNewLatexDocument(report, "report", "english")).toBe(true);
    expect(isUntouchedNewLatexDocument(report, "article", "english")).toBe(false);
  });

  it("knows which templates print a title", () => {
    for (const template of [
      "blank",
      "article",
      "report",
      "thesis",
      "proposal",
      "assignment",
    ] as const)
      expect(templateHasTitle(template)).toBe(true);
    expect(templateHasTitle("letter")).toBe(false);
    expect(templateHasTitle("cv")).toBe(false);
  });

  it("carries a title into a name and a name into a title across templates", () => {
    const titled = switchNewLatexDocument(article, "article", "english").replace(
      "\\title{}",
      "\\title{Heat flow}",
    );
    const letter = switchNewLatexDocument(titled, "letter", "english");
    expect(newDocumentTitle(letter, "latex")).toBe("");
    expect(isUntouchedNewLatexDocument(letter, "letter", "english")).toBe(true);
    const back = switchNewLatexDocument(letter, "report", "english", "Heat flow & sinks");
    expect(newDocumentTitle(back, "latex")).toBe("Heat flow sinks");
    expect(back).toContain("\\title{Heat flow \\& sinks}");
    expect(isUntouchedNewLatexDocument(back, "report", "english")).toBe(true);
  });

  it("compares title text as words", () => {
    expect(sameTitleText("Heat \\& light", "Heat & light")).toBe(true);
    expect(sameTitleText("Heat  kernel", " Heat kernel ")).toBe(true);
    expect(sameTitleText("Heat", "Heat kernel")).toBe(false);
  });

  it("sets Hebrew up the way the editor reads it, on a Unicode engine", () => {
    const source = switchNewLatexDocument(
      article.replace("\\title{}", "\\title{מאמר}"),
      "blank",
      "hebrew",
    );
    expect(source.startsWith("% !TEX program = xelatex\n")).toBe(true);
    expect(source).not.toContain("{fontenc}");
    expect(source).not.toContain("{inputenc}");
    expect(source).toContain("\\usepackage{polyglossia}");
    expect(source).toContain("\\title{מאמר}");
    expect(isUntouchedNewLatexDocument(source, "blank", "hebrew")).toBe(true);
    const language = latexDocumentLanguage(source);
    expect(language.main).toBe("hebrew");
    expect(language.hebrewFont).toBe("Times New Roman");
  });
});
