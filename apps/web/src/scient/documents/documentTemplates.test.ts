import { describe, expect, it } from "vite-plus/test";

import { latexDocumentLanguage } from "../latex/latexLanguage";
import { assembleVisualProject, type VisualProjectFile } from "../latex/latexProjectVisual";
import { latexGuidance } from "../latex/latexGuidance";
import { rewriteGuidedPlaces } from "../latex/latexGuidanceText";
import { projectLatexVisualDocument } from "../latex/latexVisualDocument";
import {
  DOCUMENT_TEMPLATES,
  companionFiles,
  createNewDocumentSource,
  isUntouchedNewLatexDocument,
  newDocumentCandidate,
  newDocumentStem,
  newDocumentTitle,
  sameTitleText,
  switchNewLatexDocument,
  templateCompanions,
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
        titled.replace("Summarize the contribution", "We summarize"),
        "article",
        "english",
      ),
    ).toBe(false);
    const report = switchNewLatexDocument(titled, "lab-report", "english");
    expect(report).toContain("\\title{Mixing times}");
    expect(isUntouchedNewLatexDocument(report, "lab-report", "english")).toBe(true);
    expect(isUntouchedNewLatexDocument(report, "article", "english")).toBe(false);
  });

  it("knows which templates print a title", () => {
    for (const template of DOCUMENT_TEMPLATES)
      if (template.id !== "letter" && template.id !== "cv")
        expect(templateHasTitle(template.id)).toBe(true);
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
    const back = switchNewLatexDocument(letter, "lab-report", "english", "Heat flow & sinks");
    expect(newDocumentTitle(back, "latex")).toBe("Heat flow sinks");
    expect(back).toContain("\\title{Heat flow \\& sinks}");
    expect(isUntouchedNewLatexDocument(back, "lab-report", "english")).toBe(true);
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
    expect(source).not.toContain("{lmodern}");
    expect(source).toContain("\\usepackage{polyglossia}");
    expect(source).toContain("\\title{מאמר}");
    expect(isUntouchedNewLatexDocument(source, "blank", "hebrew")).toBe(true);
    const language = latexDocumentLanguage(source);
    expect(language.main).toBe("hebrew");
    expect(language.hebrewFont).toBe("Times New Roman");
  });

  it("opens every template in Visual without a source-only block, in each language", () => {
    for (const template of DOCUMENT_TEMPLATES)
      for (const language of ["english", "hebrew"] as const) {
        const source = createNewDocumentSource({
          format: "latex",
          template: template.id,
          language,
        });
        // Visual reads a document with the files it includes, as the editor assembles them.
        const files = new Map<string, VisualProjectFile>([
          ["main.tex", { contents: source, revision: "r", truncated: false }],
          ...templateCompanions(template.id, source).map(
            (file) =>
              [file.name, { contents: file.contents, revision: "r", truncated: false }] as const,
          ),
        ]);
        const assembled = assembleVisualProject("main.tex", files);
        expect([...assembled.missing, ...assembled.errors]).toEqual([]);
        const projection = projectLatexVisualDocument(assembled.source);
        // Every place left to write in shows its guidance; no sample text is printed.
        const places =
          (assembled.source.match(/^% Guide:[^\n]*\n\\par$/gmu) ?? []).length +
          (
            assembled.source.match(
              /\\begin\{[A-Za-z]+\*?\}(?:\[[^\]]*\])?\n% Guide:[^\n]*\n\\end\{/gu,
            ) ?? []
          ).length;
        expect(latexGuidance(projection).size, `${template.id}/${language}`).toBe(places);
        expect(projection.content.content).toHaveLength(projection.blocks.length);
        const pictured: string[] = [];
        rewriteGuidedPlaces(assembled.source, (text) => {
          pictured.push(text);
          return "";
        });
        expect(pictured).toEqual([...latexGuidance(projection).values()]);
        expect(
          projection.blocks
            .filter((block) => block.node.type === "latexRawBlock")
            .map((block) => `${template.id}/${language}: ${String(block.node.attrs?.raw)}`),
        ).toEqual([]);
        expect(isUntouchedNewLatexDocument(source, template.id, language)).toBe(true);
      }
  });

  it("gives the templates that cite a bibliography beside them", () => {
    const cites = DOCUMENT_TEMPLATES.filter(
      (template) => companionFiles(template.source).length > 0,
    ).map((template) => template.id);
    expect(cites).toEqual(["article", "thesis", "lab-report", "lecture-notes", "grant-proposal"]);
    for (const id of cites)
      expect(
        companionFiles(
          createNewDocumentSource({ format: "latex", template: id, language: "english" }),
        ),
      ).toEqual(["references.bib"]);
  });
});
