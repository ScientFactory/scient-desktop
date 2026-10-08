import { describe, expect, it } from "vite-plus/test";

import { latexDocumentLanguage } from "../latex/latexLanguage";
import { createNewDocumentSource, newDocumentPath, newDocumentStem } from "./documentTemplates";

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

  it("takes the first free name, whatever its case on disk", () => {
    expect(newDocumentPath("Notes", "markdown", [])).toBe("notes.md");
    expect(newDocumentPath("Notes", "latex", ["notes.md"])).toBe("notes.tex");
    expect(newDocumentPath("Notes", "latex", ["Notes.tex", "notes-2.tex"])).toBe("notes-3.tex");
  });

  it("starts Markdown with its title as the first heading", () => {
    expect(
      createNewDocumentSource({
        format: "markdown",
        title: " Lab notebook\n",
        template: "blank",
        language: "english",
      }),
    ).toBe("# Lab notebook\n\n");
    expect(
      createNewDocumentSource({
        format: "markdown",
        title: "",
        template: "blank",
        language: "english",
      }),
    ).toBe("# Untitled\n\n");
  });

  it("starts LaTeX from the chosen template with the title set", () => {
    const article = createNewDocumentSource({
      format: "latex",
      title: "Bounds & limits",
      template: "blank",
      language: "english",
    });
    expect(article).toContain("\\documentclass[11pt,a4paper]{article}");
    expect(article).toContain("\\title{Bounds \\& limits}");
    expect(article).not.toContain("polyglossia");
    expect(
      createNewDocumentSource({
        format: "latex",
        title: "R",
        template: "report",
        language: "english",
      }),
    ).toContain("\\begin{abstract}");
  });

  it("sets Hebrew up the way the editor reads it, on a Unicode engine", () => {
    const source = createNewDocumentSource({
      format: "latex",
      title: "מאמר",
      template: "blank",
      language: "hebrew",
    });
    expect(source.startsWith("% !TEX program = xelatex\n")).toBe(true);
    expect(source).not.toContain("{fontenc}");
    expect(source).not.toContain("{inputenc}");
    expect(source).toContain("\\usepackage{polyglossia}");
    expect(source).toContain("\\title{מאמר}");
    const language = latexDocumentLanguage(source);
    expect(language.main).toBe("hebrew");
    expect(language.direction).toBe("rtl");
    expect(language.hebrewFont).toBe("Times New Roman");
  });
});
