import { history, redo, undo } from "@tiptap/pm/history";
import { Schema, type Node as DocumentNode } from "@tiptap/pm/model";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { expect, it } from "vite-plus/test";

import { latexBlockNeighbours } from "./latexBlockNeighbours";
import { latexPagedKey } from "./latexPagedGeometry";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    heading: { group: "block", content: "text*", attrs: { level: { default: 4 } } },
    latexDisplayMath: { group: "block", atom: true },
    latexScientific: { group: "block", content: "block+" },
    text: {},
  },
});
const { paragraph, heading, latexDisplayMath, latexScientific } = schema.nodes;
const text = (value: string) => [schema.text(value)];

// Stands in for the paged layout: its marks move with edits until it publishes again.
const paged = new Plugin({
  key: latexPagedKey,
  state: {
    init: () => ({ decorations: DecorationSet.empty, plan: null, geometry: [], revision: 0 }),
    apply: (tr, value) =>
      tr.getMeta(latexPagedKey) ?? {
        ...value,
        decorations: value.decorations.map(tr.mapping, tr.doc),
      },
  },
});

function marks(state: EditorState, plugin: Plugin<DecorationSet>) {
  return plugin
    .getState(state)!
    .find()
    .map((decoration) => `${decoration.from} ${String(decoration.spec.latexNeighbour)}`)
    .sort();
}

it("keeps each block's neighbour marks through edits, undo and paged publications", () => {
  const plugin = latexBlockNeighbours();
  const doc = schema.node("doc", null, [
    heading.create(null, text("Run-in")),
    paragraph.create(null, text("Beside it.")),
    paragraph.create(null, text("Before a display")),
    latexDisplayMath.create(),
    latexDisplayMath.create(),
    latexScientific.create(null, [
      paragraph.create(null, text("Inside")),
      latexDisplayMath.create(),
      heading.create({ level: 5 }, text("Nested")),
      paragraph.create(null, text("After")),
    ]),
    heading.create(null, text("Alone")),
    latexDisplayMath.create(),
  ]);
  let state = EditorState.create({ doc, plugins: [paged, plugin, history()] });
  // A fresh plugin, shown the current paged marks as a publication.
  const expected = () => {
    const fresh = latexBlockNeighbours();
    const base = EditorState.create({ doc: state.doc, plugins: [paged, fresh] });
    return marks(base.apply(base.tr.setMeta(latexPagedKey, latexPagedKey.getState(state)!)), fresh);
  };
  const publish = (tr: Transaction, displays: readonly number[]) =>
    tr.setMeta(latexPagedKey, {
      decorations: DecorationSet.create(
        tr.doc,
        displays.map((at) => Decoration.node(at, at + 1, {}, { latexShortDisplay: true })),
      ),
      plan: null,
      geometry: [],
      revision: 0,
    });
  expect(marks(state, plugin)).toEqual(["0 run-in", "20 display", "41 display", "50 run-in"]);
  state = state.apply(publish(state.tr, [38]));
  expect(marks(state, plugin)).toContain("20 short display");
  // The next display moves up against the paragraph, but was never set short.
  state = state.apply(state.tr.delete(38, 39));
  expect(marks(state, plugin)).toContain("20 display");
  // A heading level change alone maps no positions.
  state = state.apply(state.tr.setNodeAttribute(0, "level", 3));
  expect(marks(state, plugin)).not.toContain("0 run-in");
  state = state.apply(state.tr.setNodeAttribute(0, "level", 4));
  expect(marks(state, plugin)).toContain("0 run-in");

  let seed = 7;
  const random = (count: number) => (seed = (seed * 48271) % 2147483647) % count;
  for (let step = 0; step < 400; step++) {
    const blocks: { node: DocumentNode; position: number }[] = [];
    state.doc.descendants((node, position) => {
      blocks.push({ node, position });
      return !node.isTextblock;
    });
    const { node, position } = blocks[random(blocks.length)]!;
    const end = position + node.nodeSize;
    const tr = state.tr;
    const action = random(8);
    if (action === 0) tr.insert(end, latexDisplayMath.create());
    else if (action === 1) tr.insert(end, paragraph.create(null, text("P")));
    else if (action === 2) tr.insert(end, heading.create({ level: 4 + random(2) }, text("H")));
    else if (action === 3 && state.doc.childCount > 1) tr.delete(position, end);
    else if (action === 4 && node.isTextblock && node.content.size > 1) tr.split(position + 2);
    else if (action === 5 && node.type === heading) {
      // Attribute steps map no positions; mix one with a structural edit elsewhere.
      if (random(2)) tr.setNodeMarkup(position, undefined, { level: 3 + random(3) });
      else tr.setNodeAttribute(position, "level", 3 + random(3));
      if (random(2)) tr.insert(tr.doc.content.size, paragraph.create(null, text("P")));
    } else if (action === 6) {
      const displays: number[] = [];
      state.doc.descendants((child, at) => {
        if (child.type === latexDisplayMath && random(2)) displays.push(at);
      });
      publish(tr, displays);
    } else {
      (random(2) ? undo : redo)(state, (next) => (state = state.apply(next)));
      expect(marks(state, plugin), `step ${step}`).toEqual(expected());
      continue;
    }
    state = state.apply(tr);
    expect(marks(state, plugin), `step ${step}`).toEqual(expected());
  }
});
