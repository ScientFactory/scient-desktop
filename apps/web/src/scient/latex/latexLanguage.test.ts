import { describe, expect, it } from "vite-plus/test";
import { latexDocumentLanguage, latexDirectionOpening } from "./latexLanguage";
import { mathTextFormattingInput } from "./mathTextFormatting";

describe("source language resolution", () => {
  it("reads modern Babel's main language and language-specific fonts", () => {
    const setup =
      latexDocumentLanguage(String.raw`\usepackage[english,bidi=basic,layout=lists.tabular]{babel}
\babelprovide[import,main]{hebrew}
\babelprovide[import]{english}
\babelfont{rm}{Latin Modern Roman}
\babelfont[hebrew]{rm}[Script=Hebrew,ItalicFeatures={FakeSlant=0.2}]{Arial}`);
    expect(setup).toMatchObject({
      main: "hebrew",
      direction: "rtl",
      hebrewFont: "Arial",
      mainFont: "Arial",
      englishFont: "Latin Modern Roman",
      resolved: true,
      bidi: true,
    });
    expect([...setup.languages]).toEqual(["hebrew", "english"]);
  });
  it.each([
    String.raw`\usepackage[english,hebrew]{babel}`,
    String.raw`\usepackage[main=hebrew,english]{babel}`,
    String.raw`\usepackage{polyglossia}\setdefaultlanguage{hebrew}`,
  ])("resolves existing syntax: %s", (source) => {
    expect(latexDocumentLanguage(source)).toMatchObject({
      main: "hebrew",
      direction: "rtl",
      resolved: true,
    });
  });
  it("ignores language and font declarations inside macro bodies and comments", () => {
    expect(
      latexDocumentLanguage(String.raw`% \babelprovide[main]{hebrew}
\newcommand{\example}{\babelprovide[main]{hebrew}\babelfont{rm}{Arial}}
\usepackage[english]{babel}`),
    ).toMatchObject({ main: "english", mainFont: null, resolved: true });
  });
  it("distinguishes Babel tags' text direction from paragraph direction", () => {
    const setup = latexDocumentLanguage(
      String.raw`\usepackage[hebrew]{babel}\babeltags{english=english}`,
    );
    expect(latexDirectionOpening(String.raw`\begin{english}`, setup)?.layout).toMatchObject({
      direction: "ltr",
      language: "english",
      paragraphDirection: "inherit",
    });
    expect(
      latexDirectionOpening(String.raw`\begin{otherlanguage}{english}`, setup)?.layout,
    ).toMatchObject({ direction: "ltr", paragraphDirection: "ltr" });
  });
  it.each([
    String.raw`\usepackage{babel}`,
    String.raw`\input{language}`,
    String.raw`\ifdefined\foo\setdefaultlanguage{hebrew}\fi`,
    String.raw`\usepackage[french]{babel}`,
  ])("reports unresolved or unsupported setup: %s", (source) => {
    expect(latexDocumentLanguage(source).resolved).toBe(false);
    expect(latexDocumentLanguage(source).issues.length).toBeGreaterThan(0);
  });
  it("adapts nested math language scopes without exposing unsupported commands", () => {
    const input = mathTextFormattingInput(
      String.raw`\text{\texthebrew{מספר האיברים הוא}}\textenglish{count}`,
    );
    expect(input).toContain(String.raw`\htmlData{scient-format=texthebrew}{מספר האיברים הוא}`);
    expect(input).toContain(String.raw`\htmlData{scient-format=textenglish}{\text{count}}`);
    expect(input).not.toContain("\\texthebrew");
    expect(mathTextFormattingInput(input)).toBe(input);
  });
  it("leaves authored command overrides alone", () => {
    expect(
      mathTextFormattingInput(String.raw`\texthebrew{x}`, { texthebrew: { def: "#1", args: 1 } }),
    ).toBe(String.raw`\texthebrew{x}`);
  });
});
