import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import { scientificStatementsFixture as source } from "./scientificStatements.fixture";

function edit(change: (nodes: JSONContent[]) => void, original = source) {
  const projection = projectLatexVisualDocument(original);
  const nodes = structuredClone(projection.content.content!);
  change(nodes);
  return applyLatexVisualDocumentChange(original, projection, { type: "doc", content: nodes });
}
function find(
  node: JSONContent,
  predicate: (node: JSONContent) => boolean,
): JSONContent | undefined {
  if (predicate(node)) return node;
  for (const child of node.content ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return undefined;
}
describe("scientific block prose and math", () => {
  it("projects all four supplied blocks with paragraphs, equations and references", () => {
    const projection = projectLatexVisualDocument(source);
    expect(projection.rawBlocks).toBe(0);
    expect(projection.blocks.slice(0, 4).map((block) => block.node.type)).toEqual(
      Array(4).fill("latexScientific"),
    );
    const theorem = projection.blocks[1]!.node;
    expect(theorem.content!.filter((node) => node.type === "latexDisplayMath")).toHaveLength(2);
    expect(find(theorem, (node) => node.attrs?.name === "eqref")).toBeDefined();
    const proof = projection.blocks[2]!.node;
    expect(find(proof, (node) => node.text?.includes("Poincaré") === true)).toBeDefined();
    expect(find(proof, (node) => node.text?.includes("Grönwall") === true)).toBeDefined();
  });
  it("does not write or normalize any source on projection", () => {
    const projection = projectLatexVisualDocument(source);
    expect(applyLatexVisualDocumentChange(source, projection, projection.content)?.source).toBe(
      source,
    );
  });
  it("patches one prose word and preserves all neighboring syntax", () => {
    const changed = edit((nodes) => {
      const text = find(nodes[1]!, (node) => node.text?.startsWith("Assume") === true)!;
      text.text = text.text!.replace("Assume", "Suppose");
    });
    expect(changed?.source).toBe(source.replace("Assume", "Suppose"));
  });
  it("edits nested display math and retains its wrapper and indentation", () => {
    const changed = edit((nodes) => {
      const math = find(nodes[1]!, (node) => node.type === "latexDisplayMath")!;
      math.attrs!.tex = math.attrs!.tex.replace("\\sup", "\\max");
    });
    expect(changed?.source).toBe(source.replace("\\sup", "\\max"));
  });
  it("edits an inline equation while retaining its dollar wrapper", () => {
    const changed = edit((nodes) => {
      const math = find(nodes[1]!, (node) => node.type === "latexInlineMath")!;
      math.attrs!.tex = math.attrs!.tex.replace("u_0", "u_1");
    });
    expect(changed?.source).toBe(source.replace("$u_0", "$u_1"));
  });
  it("retains accent commands when nearby prose changes", () => {
    const changed = edit((nodes) => {
      const text = find(nodes[2]!, (node) => node.text?.includes("Poincaré inequality") === true)!;
      text.text = text.text!.replace("Poincaré inequality", "Poincaré estimate");
    });
    expect(changed?.source).toBe(source.replace("Poincar\\'e inequality", "Poincar\\'e estimate"));
  });
  it("patches a reference without changing its surrounding paragraphs or math", () => {
    const changed = edit((nodes) => {
      find(nodes[1]!, (node) => node.attrs?.name === "eqref")!.attrs!.argument = "eq:new";
    });
    expect(changed?.source).toBe(source.replace("\\eqref{eq:bc}", "\\eqref{eq:new}"));
  });
  it("keeps exact source for unsupported body commands", () => {
    const raw = "\\begin{remark}\nText \\custom{must survive}.\n\\end{remark}";
    expect(projectLatexVisualDocument(raw).blocks[0]!.node).toMatchObject({
      type: "latexRawBlock",
      attrs: { raw },
    });
  });
  it.each(["$\\custom{u}$", "\\[\\custom{u}\\]", "\\[\\begin{custommath}u\\end{custommath}\\]"])(
    "keeps exact source for unsupported math: %s",
    (math) => {
      const raw = "\\begin{theorem}\nText " + math + ".\n\\end{theorem}";
      expect(projectLatexVisualDocument(raw).blocks[0]!.node).toMatchObject({
        type: "latexRawBlock",
        attrs: { raw },
      });
    },
  );
  it("edits prose repeatedly using fresh body ranges", () => {
    const first = edit((nodes) => {
      find(nodes[1]!, (node) => node.text?.startsWith("Assume") === true)!.text =
        "Suppose the Dirichlet branch of ";
    })!;
    const second = edit((nodes) => {
      find(nodes[1]!, (node) => node.text?.startsWith("Suppose") === true)!.text =
        "Consider the Dirichlet branch of ";
    }, first.source);
    expect(second?.source).toBe(source.replace("Assume", "Consider"));
  });
});
