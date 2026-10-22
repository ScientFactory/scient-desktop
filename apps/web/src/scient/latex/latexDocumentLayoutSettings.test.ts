import { expect, it } from "vite-plus/test";
import { updateLatexDocumentSettingsSource } from "./latexDocumentSettingsSource";
import { documentLayoutSettings } from "./latexDocumentLayoutSettings";
import { latexVisualLayoutProfile } from "./latexVisualLayout";

const source = String.raw`% Keep this comment.
\documentclass[11pt,a4paper]{article}
\usepackage[margin=23mm]{geometry}
\newcommand{\sample}{\setlength{\columnsep}{99pt}}
\begin{document}
Existing \textbf{content}, $x^2$, and \input{chapter}.
\end{document}
`;
it("preserves first-page examples and macro bodies when changing the supported hook", () => {
  const configured =
    source.replace(
      "\\begin{document}",
      String.raw`\AtBeginDocument{\thispagestyle{plain}}
\newcommand{\example}{\AtBeginDocument{\thispagestyle{plain}}}
\begin{document}`,
    ) + String.raw`\AtBeginDocument{\thispagestyle{plain}}`;
  const next = updateLatexDocumentSettingsSource(configured, { firstPageStyle: "empty" })!;
  expect(next).toContain(
    String.raw`\newcommand{\example}{\AtBeginDocument{\thispagestyle{plain}}}`,
  );
  expect(next.slice(next.indexOf("\\begin{document}"))).toBe(
    configured.slice(configured.indexOf("\\begin{document}")),
  );
  expect(documentLayoutSettings(next).firstPageStyle).toBe("empty");
});
it("refuses replacing a custom section format with a generic setting", () => {
  const custom = source.replace(
    "\\begin{document}",
    String.raw`\usepackage{titlesec}
\titleformat{\section}{\Large\color{blue}}{\thesection}{1em}{\underline}
\begin{document}`,
  );
  expect(updateLatexDocumentSettingsSource(custom, { headingSize: 18 })).toBeNull();
});
it("retains section indentation and first-paragraph behavior when changing heading spacing", () => {
  const custom = source.replace(
    "\\begin{document}",
    String.raw`\titlespacing{\section}{2em}{3ex}{1ex}
\begin{document}`,
  );
  const next = updateLatexDocumentSettingsSource(custom, { headingAfter: "2ex" })!;
  expect(next).toContain(String.raw`\titlespacing{\section}{2em}{3ex}{2ex}`);
});
it("reads cleared and inherited fancyhdr fields in declaration order", () => {
  const custom = source.replace(
    "\\begin{document}",
    String.raw`\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{Running title}
\fancyhead[LE]{Even title}
\begin{document}`,
  );
  expect(documentLayoutSettings(custom)).toMatchObject({
    headerLeft: "Running title",
    evenHeaderLeft: "Even title",
    footerCenter: "",
  });
});
it("applies columns and typography together while preserving the body, comments and definitions", () => {
  const next = updateLatexDocumentSettingsSource(source, {
    columns: 2,
    columnGap: "5mm",
    paragraphIndent: "0pt",
    lineSpacing: 1.5,
    headingSize: 18,
    numberingDepth: 2,
  })!;
  expect(next.slice(next.indexOf("\\begin{document}"))).toBe(
    source.slice(source.indexOf("\\begin{document}")),
  );
  expect(next).toContain("\\newcommand{\\sample}{\\setlength{\\columnsep}{99pt}}");
  expect(documentLayoutSettings(next)).toMatchObject({
    columns: 2,
    lineSpacing: 1.5,
    headingSize: 18,
    numberingDepth: 2,
  });
  expect(latexVisualLayoutProfile(next).columnGapPt).toBeCloseTo((5 * 72.27) / 25.4);
  expect(
    updateLatexDocumentSettingsSource(next, { columns: 2, columnGap: "5mm", lineSpacing: 1.5 }),
  ).toBe(next);
});
it("keeps unrelated geometry when custom dimensions and binding are applied", () => {
  const next = updateLatexDocumentSettingsSource(source, {
    paperWidth: "18cm",
    paperHeight: "25cm",
    mirroredMargins: true,
    gutter: "5mm",
  })!;
  const profile = latexVisualLayoutProfile(next);
  expect(profile.paperWidthIn).toBeCloseTo(18 / 2.54);
  expect(profile.marginLeftIn).toBeCloseTo(28 / 25.4);
  expect(profile.marginRightIn).toBeCloseTo(23 / 25.4);
  expect(profile.twoSided).toBe(true);
});
it("changes simple running furniture without touching custom macro declarations", () => {
  const next = updateLatexDocumentSettingsSource(source, {
    headerLeft: "Research paper",
    footerCenter: "\\thepage",
    pageNumbering: "roman",
  })!;
  expect(documentLayoutSettings(next)).toMatchObject({
    headerLeft: "Research paper",
    footerCenter: "\\thepage",
    pageNumbering: "roman",
  });
  expect(next).toContain("\\usepackage{fancyhdr}");
  expect(updateLatexDocumentSettingsSource(source, { headerLeft: "\\input{secret}" })).toBeNull();
});
it("keeps font options and refuses an incompatible engine or invalid combined changes", () => {
  const unicode =
    "% !TEX program = lualatex\n" +
    source.replace(
      "\\begin{document}",
      "\\usepackage{fontspec}\n\\setmainfont[Ligatures=TeX]{Arial}\n\\begin{document}",
    );
  expect(updateLatexDocumentSettingsSource(unicode, { mainFont: "Times New Roman" })).toContain(
    "\\setmainfont[Ligatures=TeX]{Times New Roman}",
  );
  expect(updateLatexDocumentSettingsSource(unicode, { engine: "pdflatex" })).toBeNull();
  expect(updateLatexDocumentSettingsSource(source, { columns: 2, lineSpacing: 100 })).toBeNull();
  expect(
    updateLatexDocumentSettingsSource(source, { columns: 2, paragraphIndent: "\\custom" }),
  ).toBeNull();
});
