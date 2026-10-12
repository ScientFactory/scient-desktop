import { describe, expect, it } from "vite-plus/test";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import {
  introducesLatexParagraphDirection,
  latexParagraphDirectionSupported,
  prepareLatexParagraphDirectionSetup,
} from "./latexParagraphDirectionSetup";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";

const document = (setup = "") =>
  "\\documentclass{article}\n" +
  setup +
  "\\begin{document}\nBody. % !TEX program = pdflatex\n\\end{document}";
describe("paragraph direction setup", () => {
  it("adds bidi after all packages, selects XeLaTeX, and preserves the entire body", () => {
    const source = document("\\usepackage{hyperref}\n% retained preamble comment\n");
    const prepared = prepareLatexParagraphDirectionSetup(source)!;
    expect(prepared.source).toContain(
      "\\usepackage{hyperref}\n% retained preamble comment\n\\usepackage{bidi}\n\\begin{document}",
    );
    expect(prepared.source).toMatch(/^% !TEX program = xelatex\n/u);
    expect(prepared.source.slice(prepared.source.indexOf("\\begin{document}"))).toBe(
      source.slice(source.indexOf("\\begin{document}")),
    );
    expect(applyDocumentSourcePatches(source, prepared.patches)).toBe(prepared.source);
    expect(prepareLatexParagraphDirectionSetup(prepared.source)?.patches).toEqual([]);
  });
  it.each(["xelatex", "lualatex"] as const)(
    "preserves an explicit %s engine and uses its matching package",
    (engine) => {
      const source = "% !TEX program = " + engine + "\n" + document();
      const prepared = prepareLatexParagraphDirectionSetup(source)!;
      expect(prepared.source).toMatch(new RegExp("^% !TEX program = " + engine + "\\n", "u"));
      expect(prepared.source).toContain(
        engine === "lualatex" ? "\\usepackage{luabidi}" : "\\usepackage{bidi}",
      );
      expect(latexParagraphDirectionSupported(prepared.source)).toBe(true);
    },
  );
  it("upgrades explicit pdfLaTeX to the Unicode engine needed by bidi and preserves CRLF", () => {
    const source = ("% !TEX program = pdflatex\n" + document()).replace(/\n/gu, "\r\n");
    const prepared = prepareLatexParagraphDirectionSetup(source)!;
    expect(prepared.source).toMatch(/^% !TEX program = xelatex\r\n/u);
    expect(prepared.source).not.toMatch(/(?<!\r)\n/u);
  });
  it.each([
    "\\usepackage{polyglossia}\n\\setdefaultlanguage{hebrew}\n",
    "\\usepackage{bidi}\n",
    "\\usepackage{luabidi}\n",
    "\\usepackage{babelbidi}\n",
  ])("retains an existing direction provider without duplicate setup", (setup) => {
    const source = document(setup);
    expect(prepareLatexParagraphDirectionSetup(source)).toEqual({ source, patches: [] });
  });
  it("refuses a rootless fragment", () => {
    expect(prepareLatexParagraphDirectionSetup("Body only.")).toBeNull();
  });
  it("requests setup only for new or changed directions, rather than ordinary text edits", () => {
    const before = projectLatexVisualDocument("\\begin{LTR}\nBefore.\n\\end{LTR}").content.content!;
    const typed = projectLatexVisualDocument("\\begin{LTR}\nTyped.\n\\end{LTR}").content.content!;
    const rtl = projectLatexVisualDocument("\\begin{RTL}\nTyped.\n\\end{RTL}").content.content!;
    expect(introducesLatexParagraphDirection(before, typed)).toBe(false);
    expect(introducesLatexParagraphDirection(before, rtl)).toBe(true);
  });
  it("requires permission to update a separate root and then retains the child source", () => {
    const source = "Child paragraph.";
    const root = document("\\input{preamble}\n");
    const projection = projectLatexVisualDocument(source, 0, root);
    const next = projectLatexVisualDocument(
      "\\begin{RTL}\nChild paragraph.\n\\end{RTL}",
      0,
      root,
    ).content;
    const notices: string[] = [];
    expect(
      applyLatexVisualDocumentChange(source, projection, next, {
        rootSource: root,
        allowRootUpdates: false,
        onMissingRequirement: (message) => notices.push(message),
      }),
    ).toBeNull();
    expect(notices).toHaveLength(1);
    const result = applyLatexVisualDocumentChange(source, projection, next, {
      rootSource: root,
      allowRootUpdates: true,
    });
    expect(result?.source).toBe("\\begin{RTL}\nChild paragraph.\n\\end{RTL}");
  });
});
