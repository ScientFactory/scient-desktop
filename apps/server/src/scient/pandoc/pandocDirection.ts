/**
 * Text direction for Word export.
 *
 * Pandoc's Word writer derives right-to-left layout only from `dir`: a
 * document-level `dir: rtl` or a `dir` attribute on a div or span. `lang: he`
 * alone makes nothing right-to-left (Pandoc qualification, REPORT §6). Scient
 * renders each block in the direction of its first strong character, so
 * preparation marks direction the same way:
 *
 * - a right-to-left document gets `dir: rtl`, and its left-to-right blocks
 *   `dir=ltr`;
 * - any other document keeps left-to-right, and its right-to-left paragraphs,
 *   headings, list items, quotes, table cells, and footnotes get `dir=rtl`.
 *
 * Word tables keep left-to-right column order (no `bidiVisual`), while their
 * right-to-left cell text is marked. This expected mixed-direction layout is
 * not a conversion warning.
 */
import type { DocumentDirection } from "@t3tools/contracts";

import {
  attr,
  attrValue,
  childBlockLists,
  div,
  inlineText,
  inlinesOf,
  isPandocNode,
  span,
  str,
  type PandocDocument,
  type PandocNode,
} from "./pandocAst.ts";

const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const LETTER = /\p{L}/u;

export type StrongDirection = "ltr" | "rtl";

/** Direction of the first strong (letter) character, or null for none. */
export function firstStrongDirection(text: string): StrongDirection | null {
  for (const character of text) {
    if (RTL_LETTER.test(character)) return "rtl";
    if (LETTER.test(character)) return "ltr";
  }
  return null;
}

const TEXT_BLOCKS = new Set(["Para", "Plain", "Header", "LineBlock"]);

function blockDirection(block: PandocNode): StrongDirection | null {
  if (block.t === "LineBlock") return firstStrongDirection(inlineText(block.c));
  const inlines = inlinesOf(block);
  return inlines === null ? null : firstStrongDirection(inlineText(inlines));
}

function countDirections(
  blocks: ReadonlyArray<PandocNode>,
  counts: Record<StrongDirection, number>,
) {
  for (const block of blocks) {
    if (TEXT_BLOCKS.has(block.t)) {
      const direction = blockDirection(block);
      if (direction !== null) counts[direction] += 1;
    }
    for (const child of childBlockLists(block)) countDirections(child, counts);
  }
}

/** Footnote bodies called from these inlines, not counting notes inside notes. */
function notesIn(inlines: ReadonlyArray<PandocNode>): Array<Array<PandocNode>> {
  const notes: Array<Array<PandocNode>> = [];
  const visit = (list: ReadonlyArray<unknown>) => {
    for (const inline of list) {
      if (!isPandocNode(inline)) continue;
      const node = inline;
      if (node.t === "Note" && Array.isArray(node.c)) {
        notes.push(node.c as Array<PandocNode>);
      } else if (Array.isArray(node.c)) {
        visit(node.c.flatMap((part: unknown) => (Array.isArray(part) ? part : [part])));
      }
    }
  };
  visit(inlines);
  return notes;
}

export interface DirectionReport {
  readonly rtlDocument: boolean;
  readonly markedBlocks: number;
}

/**
 * Marks direction in place. `auto` makes the document right-to-left when most
 * of its text blocks start with a right-to-left letter.
 */
export function applyDirection(
  document: PandocDocument,
  direction: DocumentDirection,
): DirectionReport {
  let rtlDocument = direction === "rtl";
  if (direction === "auto") {
    const counts = { ltr: 0, rtl: 0 };
    countDirections(document.blocks, counts);
    rtlDocument = counts.rtl > counts.ltr;
  }
  let markedBlocks = 0;

  /**
   * Marks blocks whose own direction differs from the direction they sit in.
   * Inside a footnote a paragraph keeps its place as the note's first block,
   * where Pandoc puts the note number, so its text is marked with a span.
   */
  const wrap = (blocks: Array<PandocNode>, context: StrongDirection, inNote = false): void => {
    for (const [index, block] of blocks.entries()) {
      let inner = context;
      const explicit = block.t === "Div" ? attrValue(block, "dir") : null;
      const inlines = inlinesOf(block);
      if (inNote && (block.t === "Para" || block.t === "Plain") && inlines !== null) {
        const own = blockDirection(block);
        if (own !== null && own !== context) {
          // The closing mark keeps trailing punctuation with the text it ends.
          const mark = str(own === "ltr" ? "\u200E" : "\u200F");
          inlines.splice(0, inlines.length, span(attr([], [["dir", own]]), [...inlines, mark]));
          markedBlocks += 1;
        }
      } else if (TEXT_BLOCKS.has(block.t)) {
        const own = blockDirection(block);
        if (own !== null && own !== context) {
          blocks[index] = div(attr([], [["dir", own]]), [block]);
          markedBlocks += 1;
          inner = own;
        }
      } else if (explicit === "rtl" || explicit === "ltr") {
        for (const child of childBlockLists(block)) wrap(child, explicit, inNote);
      } else {
        for (const child of childBlockLists(block)) wrap(child, context, inNote);
      }
      // A footnote body sits in the direction of the paragraph that calls it.
      for (const note of notesIn(inlines ?? [])) wrap(note, inner, true);
    }
  };
  wrap(document.blocks, rtlDocument ? "rtl" : "ltr");

  if (rtlDocument) document.meta.dir = { t: "MetaString", c: "rtl" };
  return { rtlDocument, markedBlocks };
}
