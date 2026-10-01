import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import {
  applyLatexVisualDocumentChange,
  projectLatexVisualDocument,
  latexVisualScientificSource,
} from "./latexVisualDocument";

const document = (body: string) =>
  "\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}";
const edit = (source: string, change: (nodes: JSONContent[]) => void) => {
  const projection = projectLatexVisualDocument(source);
  const nodes = structuredClone(projection.content.content!);
  change(nodes);
  return applyLatexVisualDocumentChange(source, projection, { type: "doc", content: nodes });
};

describe("Hands-on review source preservation", () => {
  it.each([
    "theorem",
    "lemma",
    "proposition",
    "corollary",
    "claim",
    "definition",
    "example",
    "remark",
    "remarks",
    "proof",
  ])("edits a newly inserted empty %s", (environment) => {
    const source = document(latexVisualScientificSource(environment)!);
    expect(projectLatexVisualDocument(source).blocks[0]!.editable).toBe(true);
    const first = edit(source, (nodes) => {
      nodes[0]!.content = [
        { type: "paragraph", content: [{ type: "text", text: "First statement." }] },
      ];
    });
    expect(first?.source).toContain("First statement.");
    const second = edit(first!.source, (nodes) => {
      nodes[0]!.content![0]!.content![0]!.text = "First statement. More text.";
    });
    expect(second?.source).toContain("First statement. More text.");
    const titled = edit(second!.source, (nodes) => {
      nodes[0]!.attrs!.title = "A title";
      nodes[0]!.content![0]!.content!.push({
        type: "latexInlineCommand",
        attrs: { name: "label", argument: "statement:test", raw: "\\label{statement:test}" },
      });
    });
    expect(titled?.source).toContain("\\begin{" + environment + "}[A title]");
    expect(titled?.source).toContain("\\label{statement:test}");
  });
  it.each(["theorem", "proof", "remark", "abstract"])(
    "shows exact source for unsupported %s commands",
    (environment) => {
      const raw =
        "\\begin{" +
        environment +
        "}\nFor $u_0 \\in L^2(\\Omega)$, $t \\ge 0$.\n\\custom{Keep exactly}.\n\\end{" +
        environment +
        "}";
      const projection = projectLatexVisualDocument(document(raw));
      expect(projection.blocks[0]!.node).toMatchObject({ type: "latexRawBlock", attrs: { raw } });
      expect(projection.blocks[0]!.editable).toBe(false);
    },
  );
  it("patches a theorem body without moving its label or normalizing its wrapped title", () => {
    const source = document(
      "\\begin{theorem}[\\textbf{Main result}]\n  Every supported\n  edit survives.\n\\label{thm:main}\n\\end{theorem}",
    );
    const first = edit(source, (nodes) => {
      nodes[0]!.content![0]!.content![0]!.text = "Every supported edit round-trips. ";
    });
    expect(first?.source).toBe(source.replace("survives.", "round-trips."));
    const second = edit(first!.source, (nodes) => {
      nodes[0]!.content![0]!.content![0]!.text = "Every supported edit works. ";
    });
    expect(second?.source).toBe(source.replace("survives.", "works."));
  });
  it("retains an abstract wrapper, indentation and CRLF on a body edit", () => {
    const source = document(
      "\\begin{abstract}\n  \\emph{A wrapped\n  introduction.}\n\\end{abstract}",
    ).replaceAll("\n", "\r\n");
    expect(
      edit(source, (nodes) => {
        nodes[0]!.attrs!.body = "A wrapped summary.";
      })?.source,
    ).toBe(source.replace("introduction.", "summary."));
  });
  it("adds one bold command inside an existing italic command", () => {
    const source = document("An \\textit{important} -- result.");
    const changed = edit(source, (nodes) => {
      nodes[0]!.content![1]!.marks = [{ type: "italic" }, { type: "bold" }];
    });
    expect(changed?.source).toBe(
      source.replace("\\textit{important}", "\\textit{\\textbf{important}}"),
    );
  });
  it("keeps textit and the original dash spelling when splitting a paragraph", () => {
    const source = document("\\textit{First -- second}");
    const changed = edit(source, (nodes) => {
      nodes.splice(
        0,
        1,
        {
          type: "paragraph",
          content: [{ type: "text", text: "First –", marks: [{ type: "italic" }] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "second", marks: [{ type: "italic" }] }],
        },
      );
    });
    expect(changed?.source).toBe(
      source.replace("\\textit{First -- second}", "\\textit{First --}\n\n\\textit{second}"),
    );
  });
  it("does not add a blank line to a paragraph continuing below display math", () => {
    const source = document("\\[x=1\\]\nwhere x is constant.");
    const changed = edit(source, (nodes) => {
      nodes.splice(1, 0, { type: "latexDisplayMath", attrs: { tex: "y=2", wrapper: "bracket" } });
    });
    expect(changed?.source).toBe(source.replace("\\]\nwhere", "\\]\n\\[\ny=2\n\\]\nwhere"));
  });
  it("does not display protected table cells as stripped previews", () => {
    const raw = "\\begin{tabular}{c} $\\frac{1}{2}$ \\\\ \\end{tabular}";
    expect(projectLatexVisualDocument(raw).blocks[0]!.node).toMatchObject({
      type: "latexRawBlock",
      attrs: { raw },
    });
  });
});
