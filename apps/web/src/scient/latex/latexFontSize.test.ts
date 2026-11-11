import { describe, expect, it } from "vite-plus/test";
import { latexFontGroupSource, latexTextDeclarationAt } from "./latexTextFormatting";
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
    expect(
      latexFontGroupSource({ type: "latexFontSize", attrs: { points: 13, leading: 15.6 } }, "word"),
    ).toBe("{\\fontsize{13}{15.6}\\selectfont word}");
    expect(
      latexFontGroupSource(
        { type: "latexFontSize", attrs: { points: 13, leading: 15.6 } },
        " here",
      ),
    ).toBe("{\\fontsize{13}{15.6}\\selectfont{} here}");
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

describe("named fonts in LaTeX", () => {
  const pdftex = "\\fontfamily{qtm}\\selectfont";
  const fontspec =
    "\\IfFontExistsTF{Times New Roman}{\\fontspec{Times New Roman}}{\\fontspec{Latin Modern Roman}}";

  it("reads both written forms as the same catalogue font", () => {
    expect(latexTextDeclarationAt(`${pdftex} text`)?.mark).toBe(
      "latexFontFamily:pdftex:Times New Roman",
    );
    expect(latexTextDeclarationAt(`${fontspec} text`)?.mark).toBe(
      "latexFontFamily:fontspec:Times New Roman",
    );
  });

  it("does not read a family code or font name the catalogue does not offer", () => {
    expect(latexTextDeclarationAt("\\fontfamily{zzz}\\selectfont x")).toBeNull();
    expect(
      latexTextDeclarationAt(
        "\\IfFontExistsTF{Comic Sans}{\\fontspec{Comic Sans}}{\\fontspec{X}} x",
      ),
    ).toBeNull();
    expect(
      latexTextDeclarationAt(`${fontspec.replace("Latin Modern Roman", "Evil")} x`),
    ).toBeNull();
  });

  it("writes only forms the engine offers", () => {
    const mark = (engine: string, family: string) => ({
      type: "latexFontFamily",
      attrs: { engine, family },
    });
    expect(latexFontGroupSource(mark("pdftex", "Times New Roman"), "word")).toBe(
      `{${pdftex} word}`,
    );
    expect(latexFontGroupSource(mark("fontspec", "Times New Roman"), " word")).toBe(
      `{${fontspec}{} word}`,
    );
    // Calibri has no pdfLaTeX package font: the text is written without a group.
    expect(latexFontGroupSource(mark("pdftex", "Calibri"), "word")).toBe("word");
  });

  it("round-trips a font group inside a paragraph", () => {
    const source = document(`Before {${pdftex} serif} after.`);
    const projection = projectLatexVisualDocument(source);
    const texts = projection.content.content![0]!.content!.map((node) => [
      node.text,
      node.marks?.[0]?.attrs?.family,
    ]);
    expect(texts).toEqual([
      ["Before ", undefined],
      ["serif", "Times New Roman"],
      [" after.", undefined],
    ]);
    const unchanged = applyLatexVisualDocumentChange(source, projection, projection.content, {});
    expect(unchanged === null || unchanged.source === source).toBe(true);
  });
});

describe("fix-cm for exact sizes", () => {
  it("adds fix-cm once when a size group is first written, and not when a scalable package is loaded", () => {
    const base = document("Plain text.");
    const projection = projectLatexVisualDocument(base);
    const paragraph = projection.content.content![0]!;
    const sized = {
      ...projection.content,
      content: [
        {
          ...paragraph,
          content: [
            {
              type: "text",
              text: "Plain text.",
              marks: [{ type: "latexFontSize", attrs: { points: 13, leading: 15.6 } }],
            },
          ],
        },
      ],
    };
    const result = applyLatexVisualDocumentChange(base, projection, sized, {});
    expect(result?.source).toContain("\\usepackage{fix-cm}");
    expect(result?.source).toContain("{\\fontsize{13}{15.6}\\selectfont Plain text.}");
    const withPackage = base.replace(
      "\\begin{document}",
      "\\usepackage{lmodern}\n\\begin{document}",
    );
    const second = projectLatexVisualDocument(withPackage);
    const again = applyLatexVisualDocumentChange(
      withPackage,
      second,
      { ...sized, content: sized.content },
      {},
    );
    expect(again?.source).not.toContain("fix-cm");
  });
});
