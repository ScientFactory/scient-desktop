import { describe, expect, it } from "vite-plus/test";
import {
  applyLatexVisualDocumentChange,
  projectLatexVisualDocument,
  latexTableInlineContent,
  latexVisualTableCellsClipboard,
} from "./latexVisualDocument";

const document = (body: string) =>
  `\\documentclass{article}\n\\usepackage{amsmath,amsthm,booktabs}\n\\begin{document}\n${body}\n\\end{document}`;

describe("shared editable containers", () => {
  it("keeps abstract prose, multiple paragraphs and both math placements editable", () => {
    const source = document(
      "\\begin{abstract}\nBefore \\(x\\) after.\n\nSecond paragraph.\n\\end{abstract}",
    );
    const original = projectLatexVisualDocument(source);
    expect(original.rawBlocks).toBe(0);
    expect(original.blocks[0]?.node.type).toBe("latexScientific");
    const next = structuredClone(original.content);
    next.content![0]!.content!.push({
      type: "latexDisplayMath",
      attrs: { tex: "a=b", wrapper: "bracket", environment: null },
    });
    const changed = applyLatexVisualDocumentChange(source, original, next);
    expect(changed?.source).toMatch(/\\\[\s*a=b\s*\\\]/u);
    expect(changed?.source).toContain("Before \\(x\\) after.");
    expect(changed?.projection.rawBlocks).toBe(0);
  });

  it("inserts mixed math into an empty cell and preserves rules, caption and neighboring cells", () => {
    const source = document(
      "\\begin{table}\\begin{tabular}{|ll|}\\hline\nAlpha & \\\\\nKeep & $x$\\\\\\hline\n\\end{tabular}\\caption{Caption}\\end{table}",
    );
    const original = projectLatexVisualDocument(source);
    expect(original.rawBlocks).toBe(0);
    const next = structuredClone(original.content);
    next.content![0]!.attrs!.rows[0][1] = "Before \\(y^2\\) after \\textbf{bold}";
    const changed = applyLatexVisualDocumentChange(source, original, next);
    expect(changed).not.toBeNull();
    expect(changed!.source).toContain("Alpha & Before \\(y^2\\) after \\textbf{bold}");
    expect(changed!.source).toContain("Keep & $x$");
    expect(changed!.source).toContain("\\caption{Caption}");
    expect(changed!.projection.rawBlocks).toBe(0);
    const copy = latexVisualTableCellsClipboard(changed!.projection.blocks[0]!.node, 0, 1, 0, 1);
    expect(copy).toContain("\\(y^2\\)");
    const restored = applyLatexVisualDocumentChange(
      changed!.source,
      changed!.projection,
      original.content,
    );
    expect(restored?.projection.blocks[0]?.node.attrs?.rows).toEqual(
      original.blocks[0]?.node.attrs?.rows,
    );
  });

  it("round-trips clearing multiple rich cells and restoring them together", () => {
    const source = document(
      "\\begin{tabular}{ll}\nText \\(a\\) & $b$\\\\\n$c$ & \\textbf{word}\\\\\n\\end{tabular}",
    );
    const original = projectLatexVisualDocument(source);
    const next = structuredClone(original.content);
    next.content![0]!.attrs!.rows = [
      ["", ""],
      ["$c$", "\\textbf{word}"],
    ];
    const changed = applyLatexVisualDocumentChange(source, original, next);
    expect(changed).not.toBeNull();
    const restored = applyLatexVisualDocumentChange(
      changed!.source,
      changed!.projection,
      original.content,
    );
    expect(restored?.projection.blocks[0]?.node.attrs?.rows).toEqual(
      original.blocks[0]?.node.attrs?.rows,
    );
    expect(restored?.source.match(/\\begin\{tabular\}/g)).toHaveLength(1);
  });

  it("allows bold formatting to change inferred header status without blocking a cell edit", () => {
    for (const [before, after] of [
      ["Heading", "\\textbf{Heading}"],
      ["\\textbf{Heading}", "Heading"],
    ]) {
      const source = document(`\\begin{tabular}{l}\n${before}\\\\\nBody\\\\\n\\end{tabular}`);
      const original = projectLatexVisualDocument(source);
      const next = structuredClone(original.content);
      next.content![0]!.attrs!.rows[0][0] = after;
      const changed = applyLatexVisualDocumentChange(source, original, next);
      expect(changed?.projection.blocks[0]?.node.attrs?.rows[0][0]).toBe(after);
    }
  });

  it("parses escaped literal symbols without treating them as new math", () => {
    expect(latexTableInlineContent("Cost \\$5 \\& 10\\%")?.map((n) => n.type)).toEqual(["text"]);
    expect(latexTableInlineContent("Before $x$ after")?.map((n) => n.type)).toEqual([
      "text",
      "latexInlineMath",
      "text",
    ]);
    expect(latexTableInlineContent("\\begin{tabular}{l}x\\end{tabular}")).toBeNull();
  });
});
