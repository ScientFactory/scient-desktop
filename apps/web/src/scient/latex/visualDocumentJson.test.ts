import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vite-plus/test";
import { serializedVisualDocument, visualDocumentJson } from "./visualDocumentJson";

const schema = new Schema({
  nodes: { doc: { content: "paragraph*" }, paragraph: { content: "text*" }, text: {} },
  marks: { strong: {} },
});

describe("immutable visual document encoding", () => {
  it("preserves empty documents and document attributes", () => {
    const attributed = new Schema({
      nodes: {
        doc: { content: "paragraph*", attrs: { language: { default: "en" } } },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    for (const doc of [schema.node("doc"), attributed.node("doc", { language: "he" })]) {
      expect(visualDocumentJson(doc)).toEqual(doc.toJSON());
      expect(JSON.parse(serializedVisualDocument(doc))).toEqual(doc.toJSON());
    }
  });
  it("reuses only unchanged blocks and keeps text, formatting and escaping exact", () => {
    const first = schema.node(
      "paragraph",
      null,
      schema.text('Quote " and newline\n', [schema.mark("strong")]),
    );
    const second = schema.node("paragraph", null, schema.text("Before"));
    const before = schema.node("doc", null, [first, second]);
    const after = schema.node("doc", null, [
      first,
      schema.node("paragraph", null, schema.text("After")),
    ]);
    const previous = visualDocumentJson(before),
      next = visualDocumentJson(after);
    expect(previous.content![0]).toBe(next.content![0]);
    expect(previous.content![1]).not.toBe(next.content![1]);
    expect(JSON.parse(serializedVisualDocument(before))).toEqual(before.toJSON());
    expect(JSON.parse(serializedVisualDocument(after))).toEqual(after.toJSON());
    expect(JSON.parse(serializedVisualDocument(before))).toEqual(before.toJSON());
  });
});
