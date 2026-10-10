import { describe, expect, it } from "vite-plus/test";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import { createVisualProcessingState, visualChangeDelta } from "./visualProcessingState";
import type { VisualChangeInput } from "./visualProcessingProtocol";

const source =
  "\\documentclass{article}\n\\begin{document}\nFirst.\n\nMiddle.\n\nLast.\n\\end{document}\n";

function edit(): VisualChangeInput {
  const projection = projectLatexVisualDocument(source);
  const content = {
    ...projection.content,
    content: projection.content.content!.map((node, index) =>
      index === 1 ? { ...node, content: [{ type: "text", text: "Revised middle." }] } : node,
    ),
  };
  return {
    kind: "change",
    source,
    projection,
    content,
    rootSource: source,
    allowRootUpdates: false,
  };
}

describe("incremental visual worker input", () => {
  it("transfers only the edit and produces the same source, mappings and content as full input", () => {
    const input = edit();
    const delta = visualChangeDelta(input, 1)!;
    expect(delta).toMatchObject({ base: 1, prefix: 1, suffix: 1 });
    expect(delta.content.content).toHaveLength(1);
    const state = createVisualProcessingState();
    state.retain(1, input.projection);
    const restored = state.expand(structuredClone(delta))!;
    expect(restored.content).toEqual(input.content);
    expect(restored.content.content![0]).toBe(input.projection.content.content![0]);
    expect(restored.content.content![2]).toBe(input.projection.content.content![2]);
    const apply = (value: VisualChangeInput) =>
      applyLatexVisualDocumentChange(value.source, value.projection, value.content, value);
    expect(apply(restored)).toEqual(apply(input));
    expect(apply(restored)?.source).toBe(source.replace("Middle.", "Revised middle."));
  });

  it("preserves deletions, insertions and document metadata", () => {
    const input = edit();
    input.content = {
      type: "doc",
      attrs: { custom: "retained" },
      content: [input.projection.content.content![0]!, input.projection.content.content![2]!],
    };
    const state = createVisualProcessingState();
    state.retain(1, input.projection);
    expect(state.expand(visualChangeDelta(input, 1)!)?.content).toEqual(input.content);
    input.content.content!.splice(1, 0, { type: "paragraph", content: [] });
    expect(state.expand(visualChangeDelta(input, 1)!)?.content).toEqual(input.content);
  });

  it("requires the exact accepted source and reusable immutable blocks", () => {
    const input = edit();
    expect(visualChangeDelta({ ...input, source: "outside update" }, 1)).toBeNull();
    expect(visualChangeDelta({ ...input, content: structuredClone(input.content) }, 1)).toBeNull();
  });

  it("requests full input after eviction, restart or an invalid range", () => {
    const input = edit(),
      delta = visualChangeDelta(input, 1)!;
    const state = createVisualProcessingState(1);
    state.retain(1, input.projection);
    expect(state.expand({ ...delta, prefix: 50 })).toBeNull();
    state.retain(2, input.projection);
    expect(state.expand(delta)).toBeNull();
    expect(createVisualProcessingState().expand(delta)).toBeNull();
    const small = createVisualProcessingState(4, 1);
    small.retain(1, input.projection);
    expect(small.expand(delta)).toBeNull();
  });
});
