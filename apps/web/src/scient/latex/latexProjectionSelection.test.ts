import { Schema } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";
import { latexProjectionSelection } from "./latexProjectionSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", attrs: { sourceId: { default: null } } },
    object: { group: "block", atom: true, attrs: { title: { default: "" } } },
    text: {},
  },
});
const paragraph = (text: string, sourceId = "old") =>
  schema.node("paragraph", { sourceId }, text ? schema.text(text) : undefined);
const doc = (...text: string[]) =>
  schema.node(
    "doc",
    null,
    text.map((value) => paragraph(value)),
  );

describe("selection on an outside source refresh", () => {
  it("retains a backwards range through insertions before and after its paragraph", () => {
    const before = doc("first", "selected", "last");
    const after = schema.node(
      "doc",
      null,
      ["new first", "first", "selected", "last", "new last"].map((text, index) =>
        paragraph(text, `new-${index}`),
      ),
    );
    const selection = TextSelection.create(before, 14, 10);
    const mapped = latexProjectionSelection(before, after, selection);
    expect(mapped.anchor).toBe(selection.anchor + 11);
    expect(mapped.head).toBe(selection.head + 11);
    expect(after.textBetween(mapped.from, mapped.to)).toBe(
      before.textBetween(selection.from, selection.to),
    );
  });

  it("maps a caret through text added inside its paragraph", () => {
    const before = doc("alpha beta");
    const after = doc("prefix alpha beta");
    const mapped = latexProjectionSelection(before, after, TextSelection.create(before, 7));
    expect(mapped.from).toBe(14);
  });

  it("keeps the second of identical paragraphs selected when the first changes", () => {
    const before = doc("same", "same");
    const after = doc("changed", "same");
    const selection = TextSelection.create(before, 8, 10);
    const mapped = latexProjectionSelection(before, after, selection);
    expect(mapped.anchor).toBe(11);
    expect(mapped.head).toBe(13);
  });

  it("keeps an object selected when its metadata changes", () => {
    const before = schema.node("doc", null, [
      schema.node("object", { title: "old" }),
      paragraph("body"),
    ]);
    const after = schema.node("doc", null, [
      schema.node("object", { title: "new" }),
      paragraph("body"),
    ]);
    const mapped = latexProjectionSelection(before, after, NodeSelection.create(before, 0));
    expect(mapped).toBeInstanceOf(NodeSelection);
    expect((mapped as NodeSelection).node.attrs.title).toBe("new");
  });
});
