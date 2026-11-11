import { describe, expect, it } from "vite-plus/test";
import { latexTextDeclarationAt, latexFontSizeGroupSource } from "./latexTextFormatting";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";

const document = (body: string) =>
  `\\documentclass{article}\n\n\\begin{document}\n${body}\n\\end{document}\n`;

describe("numeric font size in LaTeX", () => {
  it("reads a size declaration with or without units and rejects bad values", () => {
    expect(latexTextDeclarationAt("\\fontsize{12}{14.4}\\selectfont text")?.mark).toBe(
      "latexFontSize:12/14.4",
    );
    expect(latexTextDeclarationAt("\\fontsize{12pt}{15pt}\\selectfont{} text")?.length).toBe(
      "\\fontsize{12pt}{15pt}\\selectfont{}".length,
    );
    expect(latexTextDeclarationAt("\\fontsize{300}{360}\\selectfont x")).toBeNull();
    expect(latexTextDeclarationAt("\\fontsize{12}{14.4} x")).toBeNull();
    expect(latexTextDeclarationAt("\\large text")?.mark).toBe("latexSize_large");
  });

  it("writes one group per run and keeps a leading space", () => {
    expect(latexFontSizeGroupSource(13, 15.6, "word")).toBe(
      "{\\fontsize{13}{15.6}\\selectfont word}",
    );
    expect(latexFontSizeGroupSource(13, 15.6, " here")).toBe(
      "{\\fontsize{13}{15.6}\\selectfont{} here}",
    );
  });

  it("round-trips a size group inside a paragraph and keeps surrounding bytes", () => {
    const source = document("Before {\\fontsize{14}{16.8}\\selectfont big} after.");
    const projection = projectLatexVisualDocument(source);
    const paragraph = projection.content.content![0]!;
    const texts = paragraph.content!.map((node) => [node.text, node.marks?.[0]?.attrs?.points]);
    expect(texts).toEqual([
      ["Before ", undefined],
      ["big", 14],
      [" after.", undefined],
    ]);
    const unchanged = applyLatexVisualDocumentChange(source, projection, projection.content, {});
    expect(unchanged === null || unchanged.source === source).toBe(true);
  });
});
