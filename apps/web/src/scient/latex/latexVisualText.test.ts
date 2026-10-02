import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
const visibleText = (content: JSONContent): string =>
  content.text ?? (content.content ?? []).map(visibleText).join("");

describe("Visual text and hidden comments", () => {
  it("hides standalone comments without losing source offsets or interpreting their commands", () => {
    const source =
      "% \\catcode fake preamble\n\\begin{document}\n% \\newcommand{fake}\nHello\n\n% end note\n\\end{document}";
    const projected = projectLatexVisualDocument(source);
    expect(projected.rawBlocks).toBe(0);
    expect(projected.blocks).toHaveLength(1);
    expect(visibleText(projected.content)).toBe("Hello");
    expect(projected.blocks[0]!.from).toBe(source.indexOf("Hello"));
    const changed = applyLatexVisualDocumentChange(source, projected, {
      type: "doc",
      content: [paragraph("Hello again")],
    });
    expect(changed?.source).toBe(source.replace("Hello", "Hello again"));
  });

  it.each([
    ["Hello% ignored\n  world", "Helloworld"],
    ["Hello % ignored\r\n  world", "Hello world"],
    ["Hello\n% ignored\nworld", "Hello world"],
    ["50\\% complete", "50% complete"],
    ["Hello\\\\% ignored\nworld", "Helloworld"],
  ])("projects %s as %s", (source, text) => {
    const projected = projectLatexVisualDocument(source);
    expect(projected.rawBlocks).toBe(0);
    expect(visibleText(projected.content)).toBe(text);
  });

  it("preserves an inline comment exactly during edits on either side", () => {
    const source = "Hello % keep this\nworld";
    let projection = projectLatexVisualDocument(source);
    const changed = applyLatexVisualDocumentChange(source, projection, {
      type: "doc",
      content: [paragraph("Hello earth")],
    });
    expect(changed?.source).toBe("Hello % keep this\nearth");
    projection = changed!.projection;
    expect(
      applyLatexVisualDocumentChange(changed!.source, projection, {
        type: "doc",
        content: [paragraph("Goodbye earth")],
      })?.source,
    ).toBe("Goodbye % keep this\nearth");
  });

  it("keeps comments when the edited span crosses one or splits a paragraph", () => {
    const source = "First % keep this\nsecond";
    const projected = projectLatexVisualDocument(source);
    for (const content of [[paragraph("Replacement")], [paragraph("First"), paragraph("second")]]) {
      const changed = applyLatexVisualDocumentChange(source, projected, { type: "doc", content });
      expect(changed).not.toBeNull();
      expect(changed!.source).toContain("% keep this");
      expect(changed!.projection.rawBlocks).toBe(0);
      expect(visibleText(changed!.projection.content)).toBe(content.map(visibleText).join(""));
    }
  });

  it.each([
    "% only a comment",
    "% only a comment\n",
    "\\begin{document}\n% only a comment\n\\end{document}",
  ])("lets a comment-only document receive repeated edits: %s", (source) => {
    let current = source;
    let projection = projectLatexVisualDocument(current);
    expect(visibleText(projection.content)).toBe("");
    for (const value of ["New text", "New text again"]) {
      const changed = applyLatexVisualDocumentChange(current, projection, {
        type: "doc",
        content: [paragraph(value)],
      });
      expect(changed).not.toBeNull();
      current = changed!.source;
      projection = changed!.projection;
      expect(current).toContain("% only a comment");
      expect(visibleText(projectLatexVisualDocument(current).content)).toBe(value);
    }
  });

  it("keeps percent signs literal inside code environments", () => {
    const source = "\\begin{verbatim}\n% this is code\n\\end{verbatim}";
    const projected = projectLatexVisualDocument(source);
    expect(projected.blocks[0]!.node.attrs?.body).toBe("% this is code");
    expect(projected.blocks[0]!.source).toBe(source);
  });

  it("renders text commands, sizes, accents, nonbreaking spaces and explicit breaks as editable content", () => {
    const source = String.raw`Normal, \textbf{bold}, \textit{italic}, \emph{emphasized},
\texttt{monospace}, \textsc{small capitals}, and \underline{underlined}.

{\small Small text.} {\Large Large text.}

Examples: caf\'e, na\"ive, fa\c{c}ade, Stra\ss e, \AA ngstr\"om.

An unbreakable pair: Figure~1.\\
This starts on a new line.`;
    const projected = projectLatexVisualDocument(source);
    expect(projected.rawBlocks).toBe(0);
    expect(projected.blocks.every((block) => block.editable)).toBe(true);
    const first = projected.blocks[0]!.node.content!;
    for (const [text, type] of [
      ["bold", "bold"],
      ["italic", "italic"],
      ["emphasized", "italic"],
      ["monospace", "code"],
      ["small capitals", "latexSmallCaps"],
      ["underlined", "underline"],
    ])
      expect(first.find((node) => node.text === text)?.marks).toEqual([{ type }]);
    expect(visibleText(projected.blocks[2]!.node)).toBe(
      "Examples: café, naïve, façade, Straße, Ångström.",
    );
    expect(visibleText(projected.blocks[3]!.node)).toContain("Figure\u00a01.");
    expect(projected.blocks[3]!.node.content!.some((node) => node.type === "hardBreak")).toBe(true);
  });
});
