import { describe, expect, it } from "vite-plus/test";
import { documentLayoutSettings } from "./latexDocumentLayoutSettings";
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

describe("document settings font family", () => {
  it.each([
    ["serif", "rmdefault"],
    ["sans-serif", "sfdefault"],
    ["monospace", "ttdefault"],
  ] as const)("writes and reads the %s default", (fontFamily, command) => {
    const next = updateLatexDocumentSettingsSource(document(), { fontFamily })!;
    expect(next).toContain(`\\renewcommand{\\familydefault}{\\${command}}`);
    expect(documentLayoutSettings(next).fontFamily).toBe(fontFamily);
    expect(documentBody(next)).toBe(documentBody(document()));
  });

  it("replaces a previous choice and removes it on Default", () => {
    const sans = updateLatexDocumentSettingsSource(document(), { fontFamily: "sans-serif" })!;
    const mono = updateLatexDocumentSettingsSource(sans, { fontFamily: "monospace" })!;
    expect(mono.match(/familydefault/gu)).toHaveLength(1);
    const none = updateLatexDocumentSettingsSource(mono, { fontFamily: "default" })!;
    expect(none).not.toContain("familydefault");
    expect(documentLayoutSettings(none).fontFamily).toBe("default");
  });

  it("removes only the active family declaration on Default", () => {
    const commented = String.raw`% \renewcommand{\familydefault}{\sfdefault}
\newcommand{\mono}{\renewcommand{\familydefault}{\ttdefault}}
`;
    const withActive = updateLatexDocumentSettingsSource(
      document().replace("\\begin{document}", `${commented}\\begin{document}`),
      { fontFamily: "serif" },
    )!;
    const none = updateLatexDocumentSettingsSource(withActive, { fontFamily: "default" })!;
    expect(none).toContain("% \\renewcommand{\\familydefault}{\\sfdefault}");
    expect(none).toContain("\\newcommand{\\mono}{\\renewcommand{\\familydefault}{\\ttdefault}}");
    expect(none).not.toContain("{\\rmdefault}");
    expect(documentLayoutSettings(none).fontFamily).toBe("default");
  });
});

describe("document settings named fonts", () => {
  const xelatex = (preamble = "") => document(`% !TEX program = xelatex\n${preamble}`);

  it("writes a pdfLaTeX family code for a font with a look-alike, and reads it back", () => {
    const next = updateLatexDocumentSettingsSource(document(), { fontFamily: "Times New Roman" })!;
    expect(next).toContain("\\renewcommand{\\familydefault}{ptm}");
    expect(documentLayoutSettings(next).fontFamily).toBe("Times New Roman");
    expect(documentBody(next)).toBe(documentBody(document()));
  });

  it("refuses a font pdfLaTeX has no look-alike for, and an unknown name", () => {
    expect(updateLatexDocumentSettingsSource(document(), { fontFamily: "Garamond" })).toBeNull();
    expect(updateLatexDocumentSettingsSource(document(), { fontFamily: "Comic Sans" })).toBeNull();
  });

  it("writes setmainfont under XeLaTeX and no familydefault", () => {
    const sans = updateLatexDocumentSettingsSource(xelatex(), { fontFamily: "sans-serif" })!;
    const next = updateLatexDocumentSettingsSource(sans, { fontFamily: "Garamond" })!;
    expect(next).toContain("\\setmainfont{Garamond}");
    expect(next).toContain("\\usepackage{fontspec}");
    expect(next).not.toContain("familydefault");
    expect(documentLayoutSettings(next).fontFamily).toBe("Garamond");
    expect(documentBody(next)).toBe(documentBody(document()));
  });

  it("preserves an optioned main font and custom family across picker changes", () => {
    const source = xelatex("\\usepackage{fontspec}\n\\setmainfont[Ligatures=TeX]{Georgia}\n");
    expect(documentLayoutSettings(source).fontFamily).toBe("Georgia");
    const next = updateLatexDocumentSettingsSource(source, { fontFamily: "Garamond" })!;
    expect(next).toContain("\\IfFontExistsTF{Garamond}{\\setmainfont[Ligatures=TeX]{Garamond}}{}");
    expect(documentLayoutSettings(next).fontFamily).toBe("Garamond");
    const reset = updateLatexDocumentSettingsSource(next, { fontFamily: "default" })!;
    expect(reset).toContain("\\setmainfont[Ligatures=TeX]{Georgia}");
    const custom = document("\\renewcommand{\\familydefault}{mycustom}\n");
    expect(updateLatexDocumentSettingsSource(custom, { fontFamily: "default" })).toBe(custom);
  });

  it("applies a font together with the engine change in one update", () => {
    const next = updateLatexDocumentSettingsSource(document(), {
      engine: "xelatex",
      fontFamily: "Garamond",
    })!;
    expect(next).toContain("\\setmainfont{Garamond}");
    expect(documentLayoutSettings(next)).toMatchObject({
      engine: "xelatex",
      fontFamily: "Garamond",
    });
  });

  it("clears a catalogue main font on a new choice or Default, and keeps the author's own", () => {
    const named = updateLatexDocumentSettingsSource(xelatex(), { fontFamily: "Garamond" })!;
    const serif = updateLatexDocumentSettingsSource(named, { fontFamily: "serif" })!;
    expect(serif).not.toContain("\\setmainfont");
    expect(serif).toContain("\\renewcommand{\\familydefault}{\\rmdefault}");
    const none = updateLatexDocumentSettingsSource(named, { fontFamily: "default" })!;
    expect(none).not.toContain("\\setmainfont");
    const own = xelatex("\\usepackage{fontspec}\n\\setmainfont{Charter}\n");
    const kept = updateLatexDocumentSettingsSource(own, { fontFamily: "default" })!;
    expect(kept).toContain("\\setmainfont{Charter}");
  });
});
