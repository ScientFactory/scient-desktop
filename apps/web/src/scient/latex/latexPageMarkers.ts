import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** Where a page of the last compiled PDF begins in this document. */
export interface LatexPageAnchor {
  readonly page: number;
  readonly position: number;
}

/** Page markers from one compiled PDF. `key` identifies that build. */
export interface LatexPageMarkerInput {
  readonly key: string;
  readonly pageCount: number;
  readonly anchors: readonly LatexPageAnchor[];
}

/** Where each page of one build begins, by workspace file and line, and the
 * revision of every file the build compiled. `key` identifies the build. */
export interface LatexBuildPageAnchors {
  readonly key: string;
  readonly pageCount: number;
  readonly anchors: readonly {
    readonly page: number;
    readonly relativePath: string;
    readonly line: number;
  }[];
  readonly sourceRevisions: Readonly<Record<string, string>>;
}

/** Page anchors of one build as offsets into an editor source, valid only for exactly `source`. */
export interface LatexSourcePageAnchors {
  readonly key: string;
  readonly source: string;
  readonly pageCount: number;
  readonly anchors: readonly { readonly page: number; readonly offset: number }[];
}

/**
 * Places each page's marker at the start of the top-level block containing the
 * offset where the page begins. A page that begins inside the same block as the
 * previous page shares that block's marker. `blocks` are the projection's
 * source ranges, one per top-level node.
 */
export function latexPageMarkersFromSource(
  doc: DocumentNode,
  blocks: readonly { readonly from: number; readonly to: number }[],
  input: LatexSourcePageAnchors,
): LatexPageMarkerInput | null {
  if (doc.childCount !== blocks.length) return null;
  const positions: number[] = [];
  let position = 0;
  doc.forEach((node) => {
    positions.push(position);
    position += node.nodeSize;
  });
  const anchors: LatexPageAnchor[] = [];
  let previous = -1;
  for (const { page, offset } of input.anchors) {
    // The first block that ends after the page starts.
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (blocks[middle]!.to > offset) high = middle;
      else low = middle + 1;
    }
    // A page beginning inside the previous page's block shares its position.
    if (low >= blocks.length || low < previous) continue;
    previous = low;
    anchors.push({ page, position: positions[low]! });
  }
  return { key: input.key, pageCount: input.pageCount, anchors };
}

interface PageMarkerState {
  readonly key: string | null;
  readonly pageCount: number;
  /** Sorted by position; mapped through every edit, dropped when deleted. */
  readonly anchors: readonly LatexPageAnchor[];
  /** The document changed after the build that produced these markers. */
  readonly stale: boolean;
  readonly decorations: DecorationSet;
}

export const latexPageMarkersKey = new PluginKey<PageMarkerState>("scientLatexPageMarkers");

const empty: PageMarkerState = {
  key: null,
  pageCount: 0,
  anchors: [],
  stale: false,
  decorations: DecorationSet.empty,
};

function marker(label: string) {
  return () => {
    const element = document.createElement("span");
    element.className = "scient-latex-page-marker";
    element.contentEditable = "false";
    element.dataset.page = label;
    element.setAttribute("aria-hidden", "true");
    return element;
  };
}

/** One marker per position; pages sharing a block are labelled as a range. */
function decorate(state: EditorState, anchors: readonly LatexPageAnchor[]) {
  const decorations: Decoration[] = [];
  for (let index = 0; index < anchors.length;) {
    const { page, position } = anchors[index]!;
    let last = index;
    while (anchors[last + 1]?.position === position) last++;
    const label = last > index ? `${page}–${anchors[last]!.page}` : String(page);
    decorations.push(
      Decoration.widget(position, marker(label), {
        side: -1,
        key: `page:${label}`,
        ignoreSelection: true,
        latexPageMarker: page,
      }),
    );
    index = last + 1;
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Whether a step deleted or replaced the opening token of the block at
 * `position` (all of a one-token block such as an equation). Content inserted
 * before the block does not, and neither does changing the same block in
 * place: retyping it, or editing a one-token block that keeps its source.
 */
function removesOpening(transaction: Transaction, position: number): boolean {
  let at = position;
  for (const [index, step] of transaction.steps.entries()) {
    const map = step.getMap();
    const before = transaction.docs[index]!;
    const after = transaction.docs[index + 1] ?? transaction.doc;
    let removed = false;
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (oldStart > at || oldEnd < at + 1) return;
      if (oldStart === at && oldEnd === at + 1 && newEnd - newStart === 1) {
        const previous = before.nodeAt(at);
        const next = after.nodeAt(newStart);
        if (previous && next && (!previous.isLeaf || sameBlock(previous, next))) return;
      }
      removed = true;
    });
    if (removed) return true;
    at = map.map(at, 1);
  }
  return false;
}

function sameBlock(previous: DocumentNode, next: DocumentNode): boolean {
  return (
    previous.type === next.type &&
    previous.attrs.sourceId != null &&
    previous.attrs.sourceId === next.attrs.sourceId
  );
}

/**
 * Visual is continuous paper. Pages exist only in the compiled PDF; these
 * markers show where its pages began, take no space, and never move text.
 */
function latexPageMarkers() {
  return new Plugin<PageMarkerState>({
    key: latexPageMarkersKey,
    state: {
      init: () => empty,
      apply(transaction, previous, _before, state) {
        const input = transaction.getMeta(latexPageMarkersKey) as
          | LatexPageMarkerInput
          | null
          | undefined;
        if (input === null) return empty;
        if (input !== undefined) {
          const size = state.doc.content.size;
          const anchors = input.anchors
            .filter((anchor) => anchor.position >= 0 && anchor.position <= size)
            .toSorted((a, b) => a.position - b.position || a.page - b.page);
          return {
            key: input.key,
            pageCount: input.pageCount,
            anchors,
            stale: false,
            decorations: decorate(state, anchors),
          };
        }
        if (!transaction.docChanged || previous.key === null) return previous;
        const anchors: LatexPageAnchor[] = [];
        let moved = false;
        for (const anchor of previous.anchors) {
          // A marker leaves with its block's opening (all of a one-token block
          // such as an equation); content inserted right before the block
          // leaves it at the block's start.
          if (removesOpening(transaction, anchor.position)) {
            moved = true;
            continue;
          }
          const position = transaction.mapping.map(anchor.position, 1);
          moved ||= position !== transaction.mapping.map(anchor.position, -1);
          anchors.push({ page: anchor.page, position });
        }
        return {
          ...previous,
          anchors,
          stale: true,
          // Widgets map toward the content before them; redraw when a marker
          // was dropped or kept to its block across an insertion.
          decorations: moved
            ? decorate(state, anchors)
            : previous.decorations.map(transaction.mapping, transaction.doc),
        };
      },
    },
    props: {
      decorations: (state) => latexPageMarkersKey.getState(state)?.decorations ?? null,
      attributes: (state): Record<string, string> =>
        latexPageMarkersKey.getState(state)?.stale ? { "data-latex-pages-stale": "true" } : {},
    },
  });
}

export const LatexPageMarkers = Extension.create({
  name: "latexPageMarkers",
  addProseMirrorPlugins: () => [latexPageMarkers()],
});

export function setLatexPageMarkers(view: EditorView, input: LatexPageMarkerInput | null) {
  view.dispatch(view.state.tr.setMeta(latexPageMarkersKey, input).setMeta("addToHistory", false));
}

/** The PDF page on which `position` was typeset in the last build, if known. */
/** The pages whose marker is the last at or before `position`: several when they share a block. */
export function latexPagesAt(state: EditorState, position: number): number[] {
  const anchors = latexPageMarkersKey.getState(state)?.anchors ?? [];
  let low = 0;
  let high = anchors.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (anchors[middle]!.position <= position) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return anchors.length ? [Math.max(1, anchors[0]!.page - 1)] : [];
  const at = anchors[found]!.position;
  let first = found;
  while (first > 0 && anchors[first - 1]!.position === at) first--;
  return anchors.slice(first, found + 1).map((anchor) => anchor.page);
}

/** The page where `position` lies: the first of the pages sharing its block. */
export function latexPageAt(state: EditorState, position: number): number | null {
  return latexPagesAt(state, position)[0] ?? null;
}

export function latexPageCount(state: EditorState): number {
  return latexPageMarkersKey.getState(state)?.pageCount ?? 0;
}
