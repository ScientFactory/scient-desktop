import { describe, expect, it } from "vite-plus/test";
import { updateLatexDocumentSettingsSource } from "./latexDocumentSettingsSource";
import { latexDocumentLanguage, latexLanguageLabels } from "./latexLanguage";
import { DOCUMENT_TEMPLATES, createNewDocumentSource } from "../documents/documentTemplates";

const body = String.raw`\section{Existing section}
English prose with \textbf{formatting}, a citation \cite{kept}, and $x^2$.
\begin{hebrew}טקסט בעברית\end{hebrew}
\textenglish{An explicit English passage.}
\input{chapters/existing}
`;
const document = (preamble = "", eol = "\n") =>
  `\\documentclass[11pt,a4paper]{article}\n${preamble}\\begin{document}\n${body}\\end{document}\n`.replaceAll(
    "\n",
    eol,
  );
const documentBody = (source: string) => source.slice(source.lastIndexOf("\\begin{document}"));

describe("document settings language application", () => {
  it.each(DOCUMENT_TEMPLATES.map(({ id }) => id))(
    "changes an existing %s template to Hebrew without recreating its body",
    (template) => {
      const source = createNewDocumentSource({
        format: "latex",
        template,
        language: "english",
      }).replace("\\begin{document}", `\\begin{document}\n${body}`);
      const next = updateLatexDocumentSettingsSource(source, { language: "hebrew" })!;
      expect(next).not.toBeNull();
      expect(documentBody(next)).toBe(documentBody(source));
      expect(next).not.toContain("\\usepackage[T1]{fontenc}");
      expect(next).not.toContain("\\usepackage{lmodern}");
      expect(next).toContain("% !TEX program = xelatex");
      expect(latexDocumentLanguage(next)).toMatchObject({ main: "hebrew", direction: "rtl" });
      expect(latexLanguageLabels(latexDocumentLanguage(next).main).abstract).toBe("תקציר");
      expect(updateLatexDocumentSettingsSource(next, { language: "hebrew" })).toBe(next);
    },
  );

  it("retains custom Hebrew fonts, a Unicode compiler, and explicit passages when returning to English", () => {
    const source =
      "% !TEX program = lualatex\n" +
      document(String.raw`\usepackage{fontspec}
\usepackage{polyglossia}
\setdefaultlanguage{hebrew}
\setotherlanguage{english}
\setmainfont{TeX Gyre Termes}
\newfontfamily\hebrewfont[Script=Hebrew]{Arial}
`);
    const next = updateLatexDocumentSettingsSource(source, { language: "english" })!;
    expect(latexDocumentLanguage(next)).toMatchObject({
      main: "english",
      direction: "ltr",
      hebrewFont: "Arial",
      mainFont: "TeX Gyre Termes",
    });
    expect(next).toContain("% !TEX program = lualatex");
    expect(documentBody(next)).toBe(documentBody(source));
  });

  it("combines language and page changes and refuses the entire update when layout is invalid", () => {
    const source = document();
    const next = updateLatexDocumentSettingsSource(source, {
      language: "hebrew",
      baseFontPt: 12,
      paper: "letter",
      orientation: "landscape",
    })!;
    expect(next).toContain("\\documentclass[12pt,letterpaper,landscape]{article}");
    expect(latexDocumentLanguage(next).main).toBe("hebrew");
    expect(documentBody(next)).toBe(documentBody(source));
    expect(
      updateLatexDocumentSettingsSource(source, { language: "hebrew", margin: "20in" }),
    ).toBeNull();
  });

  it.each([
    "\\usepackage[english,hebrew]{babel}\n",
    "\\usepackage{polyglossia}\n\\setdefaultlanguage[variant=british]{english}\n",
    "\\input{language-setup}\n",
    "\\usepackage{polyglossia}\n\\setdefaultlanguage{french}\n",
  ])("leaves Source-owned language setups untouched: %s", (preamble) => {
    const source = document(preamble);
    expect(latexDocumentLanguage(source).canConfigure).toBe(false);
    expect(updateLatexDocumentSettingsSource(source, { language: "hebrew" })).toBeNull();
    const next = updateLatexDocumentSettingsSource(source, { baseFontPt: 12 })!;
    expect(next).toBe(source.replace("11pt,a4paper", "a4paper,12pt"));
  });

  it("uses the real document boundary and preserves comments and macro bodies", () => {
    const preamble = String.raw`% \begin{document} and \setdefaultlanguage{french}
\newcommand{\example}{\begin{document}\usepackage[T1]{fontenc}}
\usepackage[T1]{fontenc} % retain this comment
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[hidelinks]{hyperref}
`;
    const source = document(preamble);
    const next = updateLatexDocumentSettingsSource(source, { language: "hebrew" })!;
    expect(next).toContain(
      String.raw`\newcommand{\example}{\begin{document}\usepackage[T1]{fontenc}}`,
    );
    expect(next).toContain("% retain this comment");
    expect(next).toContain("% \\begin{document} and \\setdefaultlanguage{french}");
    expect(next.indexOf("\\setdefaultlanguage{hebrew}")).toBeGreaterThan(
      next.indexOf("\\usepackage[hidelinks]{hyperref}"),
    );
    expect(documentBody(next)).toBe(documentBody(source));
  });

  it("keeps CRLF source and refuses a fragment without a document root", () => {
    const source = document("", "\r\n");
    const next = updateLatexDocumentSettingsSource(source, { language: "hebrew" })!;
    expect(next.replaceAll("\r\n", "")).not.toContain("\n");
    expect(documentBody(next)).toBe(documentBody(source));
    expect(updateLatexDocumentSettingsSource(body, { language: "hebrew" })).toBeNull();
  });
});
