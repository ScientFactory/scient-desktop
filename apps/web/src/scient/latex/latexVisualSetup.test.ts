import { describe, expect, it } from "vite-plus/test";
import { latexDocumentColors } from "./latexColorBoxes";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const preamble = String.raw`\documentclass{article}
\usepackage{amsmath,xcolor,amsthm}
\newcommand{\localSetupMacro}{x}
\definecolor{setupAccent}{HTML}{245A81}
\newtheorem{setupLemma}{Lemma}
`;
const document = (body: string, setup = preamble) =>
  `${setup}\\begin{document}\n${body}\n\\end{document}`;

describe("Visual declaration setup", () => {
  it("reuses unchanged declarations when the body or imported fragment changes", () => {
    const first = projectLatexVisualDocument(document("First paragraph."));
    const next = projectLatexVisualDocument(document("Edited paragraph."));
    const imported = projectLatexVisualDocument("Imported paragraph.", 0, document("Root body."));
    expect(next.setup).toBe(first.setup);
    expect(imported.setup).toBe(first.setup);
    expect(next.content).not.toEqual(first.content);
  });

  it("refreshes macros, colors, and environment titles after a preamble edit", () => {
    const first = projectLatexVisualDocument(document("Paragraph."));
    const changed = preamble
      .replace("{x}", "{y}")
      .replace("245A81", "B85B16")
      .replace("{Lemma}", "{Claim}")
      .replace("amsmath,xcolor,amsthm", "xcolor,amsthm");
    const next = projectLatexVisualDocument(document("Paragraph.", changed));
    expect(next.setup).not.toBe(first.setup);
    expect(next.setup?.math.macros.localSetupMacro?.def).toBe("y");
    expect(next.setup?.colors.setupAccent).toBe("#B85B16");
    expect(next.setup?.declarations.environments.get("setupLemma")?.title).toBe("Claim");
    expect(first.setup?.math.macros.localSetupMacro?.def).toBe("x");
    expect(first.setup?.colors.setupAccent).toBe("#245A81");
    expect(next.setup?.math.packages.loaded.has("amsmath")).toBe(false);
    expect(first.setup?.math.packages.loaded.has("amsmath")).toBe(true);
  });

  it("keeps declaration-only fragments isolated without a document boundary", () => {
    const first = projectLatexVisualDocument(
      "First.",
      0,
      String.raw`\newcommand{\fragmentMacro}{a}`,
    );
    const next = projectLatexVisualDocument("Next.", 0, String.raw`\newcommand{\fragmentMacro}{b}`);
    expect(next.setup?.math.macros.fragmentMacro?.def).toBe("b");
    expect(first.setup?.math.macros.fragmentMacro?.def).toBe("a");
    expect(next.setup).not.toBe(first.setup);
  });

  it("does not stop colors at a document marker in a comment or macro body", () => {
    const source = String.raw`% \begin{document}
\newcommand{\exampleMarker}{\begin{document}}
\definecolor{setupAccent}{HTML}{245A81}
\begin{document}
Body.
\end{document}`;
    expect(latexDocumentColors(source).setupAccent).toBe("#245A81");
  });

  it("ignores body color declarations after a spaced document boundary", () => {
    const source = String.raw`\definecolor{setupAccent}{HTML}{245A81}
\begin {document}
\definecolor{setupAccent}{HTML}{B85B16}
\end{document}`;
    expect(latexDocumentColors(source).setupAccent).toBe("#245A81");
  });
});
