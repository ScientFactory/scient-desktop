import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import {
  adoptLatexVisualContent,
  applyLatexVisualDocumentChange,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
} from "./latexVisualDocument";
import { latexPreviewRebuildReason } from "./latexPreviewPolicy";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  content: value ? [text(value)] : [],
});
const document = (body: string) =>
  `\\documentclass{article}\n% keep the preamble\n\\begin{document}\n${body}\n\\end{document}\n% keep the trailer\n`;
const edit = (source: string, content: JSONContent[]) =>
  applyLatexVisualDocumentChange(source, projectLatexVisualDocument(source), {
    type: "doc",
    content,
  });

describe("source-derived writing projection", () => {
  it("changes only the edited range, retaining preamble, comments and unknown commands", () => {
    const source = document(
      "\\section*{Title}\n\nHello world.\n\n% keep this comment\n\\custom{opaque}",
    );
    const projected = projectLatexVisualDocument(source);
    const nodes = structuredClone(projected.content.content!);
    nodes[1] = paragraph("A better paragraph.");
    expect(edit(source, nodes)?.source).toBe(source.replace("Hello world.", "A better paragraph."));
    expect(projected.rawBlocks).toBe(2);
  });

  it("accepts spaces while typing without losing session offsets", () => {
    let source = document("Hello");
    let projection = projectLatexVisualDocument(source);
    for (const value of [
      "Hello ",
      "Hello  ",
      "Hello  world",
      "Hello  world ",
      "Hello  world again",
    ]) {
      const content = { type: "doc", content: [paragraph(value)] };
      const change = applyLatexVisualDocumentChange(source, projection, content);
      expect(change, value).not.toBeNull();
      source = change!.source;
      projection = adoptLatexVisualContent(source, content);
    }
    expect(source).toBe(document("Hello  world again"));
  });

  it("supports Enter, typing in the empty paragraph and merging it back", () => {
    let source = document("First");
    for (const nodes of [
      [paragraph("First"), paragraph("")],
      [paragraph("First"), paragraph("Second")],
      [paragraph("FirstSecond")],
    ]) {
      const changed = edit(source, nodes);
      expect(changed).not.toBeNull();
      source = changed!.source;
    }
    expect(source).toBe(document("FirstSecond"));
  });

  it("handles heading level changes without trusting inherited source attributes", () => {
    const source = document("\\section*{Title}");
    expect(
      edit(source, [
        {
          type: "heading",
          attrs: { level: 2, latexCommand: "section", unnumbered: true },
          content: [text("New title")],
        },
      ])?.source,
    ).toBe(document("\\subsection*{New title}"));
  });

  it("round-trips nested lists and empty list items", () => {
    const nodes: JSONContent[] = [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("One"),
              {
                type: "orderedList",
                attrs: { start: 1 },
                content: [{ type: "listItem", content: [paragraph("Nested")] }],
              },
            ],
          },
          { type: "listItem", content: [paragraph("")] },
        ],
      },
    ];
    const result = edit(document("Start"), nodes);
    expect(result).not.toBeNull();
    expect(projectLatexVisualDocument(result!.source).rawBlocks).toBe(0);
  });

  it("escapes typed TeX characters instead of executing them", () => {
    const result = edit(document("Hello"), [paragraph("50% & $2_# {yes} \\ ~ ^")]);
    expect(result).not.toBeNull();
    expect(result!.source).toContain(
      "50\\% \\& \\$2\\_\\# \\{yes\\} \\textbackslash{} \\textasciitilde{} \\textasciicircum{}",
    );
  });

  it("supports empty inline math and hard line breaks", () => {
    const result = edit(document("Start"), [
      {
        type: "paragraph",
        content: [
          text("Before "),
          { type: "latexInlineMath", attrs: { tex: "" } },
          { type: "hardBreak" },
          text("After"),
        ],
      },
    ]);
    expect(result).not.toBeNull();
    expect(result!.source).toContain("\\(\\)\\\\\nAfter");
  });

  it("preserves numbered math environments when editing an equation", () => {
    const source = document("\\begin{equation}\nx^2\n\\end{equation}");
    const nodes = structuredClone(projectLatexVisualDocument(source).content.content!);
    nodes[0]!.attrs!.tex = "\\frac{x}{2}";
    expect(edit(source, nodes)?.source).toBe(source.replace("x^2", "\\frac{x}{2}"));
  });

  it("preserves inline and display math wrappers while editing", () => {
    const source = document("Inline $x$ here.\n\n$$\ny^2\n$$");
    const nodes = structuredClone(projectLatexVisualDocument(source).content.content!);
    nodes[0]!.content![1]!.attrs!.tex = "z";
    nodes[1]!.attrs!.tex = "z^2";
    expect(edit(source, nodes)?.source).toBe(document("Inline $z$ here.\n\n$$\nz^2\n$$"));
  });

  it("validates complete math source and structured environments", () => {
    expect(parseLatexVisualMathSource("$x+1$", false)).toEqual({
      tex: "x+1",
      wrapper: "dollar",
    });
    expect(parseLatexVisualMathSource("x+1", false)).toBeNull();
    expect(
      latexVisualMathSource({ tex: "a &= b", environment: "align", wrapper: "bracket" }, true),
    ).toContain("\\begin{align}");
    expect(parseStructuredMathEnvironment("\\begin{bmatrix}a&b\\end{bmatrix}")).not.toBeNull();
    expect(parseStructuredMathEnvironment("\\begin{unknown}x\\end{unknown}")).toBeNull();
  });

  it("shows expanded safe commands while retaining unknown and structural commands as source", () => {
    const projection = projectLatexVisualDocument(
      document("See \\citeauthor{key} on \\pageref{page}.\n\n\\foo{value}\n\n\\input{chapter}"),
    );
    expect(projection.blocks[0]!.node.type).toBe("paragraph");
    expect(projection.blocks[1]!.node.type).toBe("latexRawBlock");
    expect(projection.blocks[2]!.node.type).toBe("latexRawBlock");
  });

  it("does not interpret a commented environment end or a verbatim document end", () => {
    const source = document(
      "\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\n\nHello\n\n\\begin{unknown}\n% \\end{unknown}\nkeep\n\\end{unknown}",
    );
    const projection = projectLatexVisualDocument(source);
    expect(projection.blocks.map((block) => block.node.type)).toEqual([
      "latexRawBlock",
      "paragraph",
      "latexRawBlock",
    ]);
    const nodes = structuredClone(projection.content.content!);
    nodes[1] = paragraph("Changed");
    expect(edit(source, nodes)?.source).toBe(source.replace("Hello", "Changed"));
  });

  it("rejects deletion across raw blocks and stale source mappings", () => {
    const source = document("Hello\n\n\\unknown{keep}");
    expect(edit(source, [paragraph("Replacement")])).toBeNull();
    const projected = projectLatexVisualDocument(source);
    expect(applyLatexVisualDocumentChange(source + "\n", projected, projected.content)).toBeNull();
  });

  it("rejects unsupported pasted nodes and preserves optional arguments", () => {
    expect(edit(document("Hello"), [{ type: "image", attrs: { src: "x" } }])).toBeNull();
    expect(projectLatexVisualDocument(document("\\section[short]{Long title}")).rawBlocks).toBe(1);
    expect(projectLatexVisualDocument(document("\\cite[page 1]{key}")).rawBlocks).toBe(1);
  });

  it("preserves CRLF and supports a document with no body text", () => {
    const source = document("").replaceAll("\n", "\r\n");
    const result = edit(source, [paragraph("First"), paragraph("Second")]);
    expect(result?.source).toContain("First\r\n\r\nSecond");
    expect(result?.source.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("compares combined marks independently of schema attribute and mark order", () => {
    const source = document("\\emph{\\textbf{Hello}}");
    const result = edit(source, [
      {
        type: "paragraph",
        attrs: { sourceId: "copied", unnumbered: false },
        content: [{ type: "text", text: "Changed", marks: [{ type: "bold" }, { type: "italic" }] }],
      },
    ]);
    expect(result).not.toBeNull();
  });
});

describe("preview rebuild notices", () => {
  it("does not promise browser/TeX equivalence after a build", () => {
    expect(latexPreviewRebuildReason(document("A"), document("A"), true)).toBeNull();
    expect(latexPreviewRebuildReason(document("A"), document("B"), false)).toContain("pagination");
  });
  it("names preamble and macro invalidation", () => {
    expect(
      latexPreviewRebuildReason(document("A"), document("A").replace("article", "report"), false),
    ).toContain("preamble");
    expect(
      latexPreviewRebuildReason(document("A"), document("\\newcommand{\\x}{X}\nA"), false),
    ).toContain("macros");
  });
});
