import { Schema, type Node as DocumentNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import {
  latexPageMarkers,
  latexPageMarkersFromSource,
  latexPageMarkersKey,
  type LatexPageAnchor,
} from "./latexPageMarkers";

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

describe("PDF page markers through edits", () => {
  // The Visual editor's block shapes that matter here: retypable text blocks and a
  // one-token equation that keeps its source identity.
  const editing = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
      latexDisplayMath: {
        group: "block",
        atom: true,
        attrs: { tex: { default: "" }, sourceId: { default: null } },
      },
      text: {},
    },
  });
  const paragraph = (text: string) => editing.node("paragraph", null, [editing.text(text)]);
  const equation = (tex: string, sourceId: string | null) =>
    editing.node("latexDisplayMath", { tex, sourceId });
  const document = editing.node("doc", null, [
    paragraph("Opening."),
    paragraph("Kept."),
    equation("x=1", "eq-1"),
    paragraph("Replaced."),
  ]);
  const offsets: number[] = [];
  document.forEach((_node, offset) => offsets.push(offset));
  const [, kept, math, replaced] = offsets as [number, number, number, number];
  const marked = (anchors: readonly LatexPageAnchor[]) => {
    const state = EditorState.create({ doc: document, plugins: [latexPageMarkers()] });
    return state.apply(
      state.tr.setMeta(latexPageMarkersKey, { key: "build", pageCount: 3, anchors }),
    );
  };
  const edit = (state: EditorState, change: (tr: Transaction) => Transaction) => {
    const next = state.apply(change(state.tr));
    const markers = latexPageMarkersKey.getState(next)!;
    return {
      doc: next.doc as DocumentNode,
      markers,
      pages: markers.anchors.map((anchor) => anchor.page),
    };
  };
  const pages = [
    { page: 1, position: 0 },
    { page: 2, position: kept },
    { page: 3, position: math },
  ];

  it("keeps a page marker with its block when content is inserted right before it", () => {
    const { doc, markers } = edit(marked(pages), (tr) => tr.insert(kept, paragraph("Inserted.")));
    expect(markers.stale).toBe(true);
    expect(markers.anchors.map((anchor) => doc.nodeAt(anchor.position)?.textContent)).toEqual([
      "Opening.",
      "Kept.",
      "",
    ]);
    // The drawn marker moves with it rather than staying before the inserted block.
    expect(markers.decorations.find().map((marker) => marker.from)).toEqual(
      markers.anchors.map((anchor) => anchor.position),
    );
  });

  it("removes a page marker with the equation it begins at", () => {
    const size = document.nodeAt(math)!.nodeSize;
    expect(edit(marked(pages), (tr) => tr.delete(math, math + size)).pages).toEqual([1, 2]);
  });

  it("removes a page marker when its block is replaced, but keeps it when the block is retyped", () => {
    const anchors = [
      { page: 1, position: kept },
      { page: 2, position: replaced },
    ];
    const retyped = edit(marked(anchors), (tr) =>
      tr
        .setBlockType(kept + 1, kept + 1, editing.nodes.heading!, { level: 2 })
        .replaceWith(replaced, replaced + document.nodeAt(replaced)!.nodeSize, paragraph("New.")),
    );
    expect(retyped.doc.nodeAt(kept)?.type.name).toBe("heading");
    expect(retyped.pages).toEqual([1]);
  });

  it("keeps an equation's marker through an edit of the same equation, not a replacement", () => {
    const anchors = [{ page: 1, position: math }];
    const replace = (sourceId: string | null) =>
      edit(marked(anchors), (tr) => tr.replaceWith(math, math + 1, equation("z=0", sourceId)));
    expect(replace("eq-1").pages).toEqual([1]);
    expect(replace(null).pages).toEqual([]);
  });
});
