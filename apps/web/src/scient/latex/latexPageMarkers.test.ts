import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vite-plus/test";

import { latexPageMarkersFromSource } from "./latexPageMarkers";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});

const source = ["First block", "continues here.", "", "Second block.", "", "Third block."].join(
  "\n",
);
// One projected block per paragraph, with its source range.
const blocks = [
  { from: 0, to: 27 },
  { from: 29, to: 42 },
  { from: 44, to: 56 },
];
const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("First block continues here.")]),
  schema.node("paragraph", null, [schema.text("Second block.")]),
  schema.node("paragraph", null, [schema.text("Third block.")]),
]);
const positions = [0, doc.child(0).nodeSize, doc.child(0).nodeSize + doc.child(1).nodeSize];

describe("PDF page markers from source offsets", () => {
  it("places each page at the start of the block containing its first offset", () => {
    expect(
      latexPageMarkersFromSource(doc, blocks, {
        key: "build",
        source,
        pageCount: 3,
        anchors: [
          { page: 1, offset: 0 },
          { page: 2, offset: source.indexOf("Second") },
          { page: 3, offset: source.indexOf("Third") },
        ],
      }),
    ).toEqual({
      key: "build",
      pageCount: 3,
      anchors: [
        { page: 1, position: positions[0] },
        { page: 2, position: positions[1] },
        { page: 3, position: positions[2] },
      ],
    });
  });

  it("keeps a page that begins inside the previous page's block at that block", () => {
    const markers = latexPageMarkersFromSource(doc, blocks, {
      key: "build",
      source,
      pageCount: 3,
      anchors: [
        { page: 1, offset: 0 },
        { page: 2, offset: source.indexOf("continues") },
        { page: 3, offset: source.indexOf("Third") },
      ],
    });
    expect(markers?.anchors).toEqual([
      { page: 1, position: positions[0] },
      { page: 2, position: positions[0] },
      { page: 3, position: positions[2] },
    ]);
  });

  it("places nothing when the projection does not describe this document", () => {
    expect(
      latexPageMarkersFromSource(doc, blocks.slice(1), {
        key: "build",
        source,
        pageCount: 1,
        anchors: [{ page: 1, offset: 0 }],
      }),
    ).toBeNull();
  });
});
