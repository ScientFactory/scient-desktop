import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { latexPagedKey } from "./latexPagedGeometry";

const latexBlockNeighboursKey = new PluginKey<DecorationSet>("scientLatexBlockNeighbours");

/** Where the paged layout set a display against the line above it. */
function shortDisplays(set: DecorationSet | undefined): number[] {
  return (
    set
      ?.find(undefined, undefined, (spec) => spec.latexShortDisplay === true)
      .map((decoration) => decoration.from) ?? []
  );
}

/** Decorations for the top-level blocks `first..last`, starting at `start`, and their contents. */
function decorate(
  doc: DocumentNode,
  first: number,
  last: number,
  start: number,
  short: ReadonlySet<number>,
): Decoration[] {
  const decorations: Decoration[] = [];
  const visit = (node: DocumentNode, position: number, next: DocumentNode | null) => {
    const end = position + node.nodeSize;
    if (node.type.name === "paragraph" && next?.type.name === "latexDisplayMath") {
      const neighbour = short.has(end) ? "short" : "";
      decorations.push(
        Decoration.node(
          position,
          end,
          { "data-latex-before-display": neighbour },
          { latexNeighbour: neighbour ? "short display" : "display" },
        ),
      );
    } else if (
      node.type.name === "heading" &&
      [4, 5].includes(Number(node.attrs.level)) &&
      next?.type.name === "paragraph"
    )
      decorations.push(
        Decoration.node(position, end, { "data-latex-run-in": "" }, { latexNeighbour: "run-in" }),
      );
  };
  let position = start;
  for (let index = first; index <= last; index++) {
    const node = doc.child(index);
    visit(node, position, doc.maybeChild(index + 1));
    node.descendants((child, offset, parent, childIndex) => {
      visit(child, position + 1 + offset, parent!.maybeChild(childIndex + 1));
      return !child.isTextblock;
    });
    position += node.nodeSize;
  }
  return decorations;
}

function changedRange(tr: Transaction): [number, number] | null {
  let from = Infinity,
    to = -Infinity;
  tr.mapping.maps.forEach((map, index) => {
    const rest = tr.mapping.slice(index + 1);
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      from = Math.min(from, rest.map(newFrom, -1));
      to = Math.max(to, rest.map(newTo, 1));
    });
  });
  return from <= to ? [from, to] : null;
}

/**
 * Marks a block by the block after it in the document: sibling `:has(+ …)` selectors
 * restyle every top-level block on each insertion in Chromium. Pagination gaps, page
 * markers and note bands between two blocks do not separate them here.
 */
export function latexBlockNeighbours() {
  return new Plugin<DecorationSet>({
    key: latexBlockNeighboursKey,
    state: {
      init: (_config, state) =>
        DecorationSet.create(
          state.doc,
          decorate(state.doc, 0, state.doc.childCount - 1, 0, new Set()),
        ),
      apply(tr, previous, before) {
        const published = tr.getMeta(latexPagedKey);
        if (published) {
          const short = new Set(shortDisplays(published.decorations));
          const current = previous.find(
            undefined,
            undefined,
            (spec) => spec.latexNeighbour === "short display",
          );
          if (
            !tr.docChanged &&
            current.length === short.size &&
            current.every((decoration) => short.has(decoration.to))
          )
            return previous;
          return DecorationSet.create(tr.doc, decorate(tr.doc, 0, tr.doc.childCount - 1, 0, short));
        }
        const range = tr.docChanged ? changedRange(tr) : null;
        if (!range) return previous;
        const mapped = previous.map(tr.mapping, tr.doc);
        // The block before a change may have gained or lost the block after it.
        const $from = tr.doc.resolve(range[0]),
          $to = tr.doc.resolve(range[1]);
        const first = Math.max(0, $from.index(0) - 1);
        const last = Math.min(tr.doc.childCount - 1, $to.index(0));
        const from = $from.posAtIndex(first, 0);
        const to = $to.posAtIndex(last, 0) + tr.doc.child(last).nodeSize;
        const stale = mapped
          .find(from, to)
          .filter((decoration) => decoration.from >= from && decoration.to <= to);
        // Until the paged layout publishes again, its short displays move with the edit.
        const short = new Set<number>();
        for (const display of shortDisplays(latexPagedKey.getState(before)?.decorations)) {
          const moved = tr.mapping.mapResult(display, 1);
          if (!moved.deleted) short.add(moved.pos);
        }
        return mapped.remove(stale).add(tr.doc, decorate(tr.doc, first, last, from, short));
      },
    },
    props: { decorations: (state) => latexBlockNeighboursKey.getState(state) },
  });
}
