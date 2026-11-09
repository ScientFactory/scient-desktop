/**
 * Find in Office pages: the same matching where the engines count matches (in their workers) and
 * where the reader marks them on a page's text layer.
 */

/** Lower case that keeps every UTF-16 unit in place, so an index in the folded text is one in the original. */
function foldText(text: string): string {
  let folded = "";
  for (const unit of text) {
    const lower = unit.toLowerCase();
    folded += lower.length === unit.length ? lower : unit;
  }
  return folded;
}

/** Where `query` starts in `text`, case-insensitively and without overlaps. */
export function findOffsets(text: string, query: string): number[] {
  const needle = foldText(query);
  if (!needle.trim()) return [];
  const haystack = foldText(text);
  const offsets: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    offsets.push(at);
  return offsets;
}

/** A page's matches, as boxes in fractions of the page so they follow every zoom. */
export type FindBox = { left: number; top: number; width: number; height: number };

/** A match's boxes, and whether it sits in text the engine's find does not count. */
export type FindMatch = { readonly boxes: readonly FindBox[]; readonly aside: boolean };

/**
 * Marks `query` in the text layer under `page`. A line break reads as a space, as copied text
 * does, so a phrase that wraps onto the next line is still found.
 */
export function findBoxes(
  page: HTMLElement,
  query: string,
  skip: (node: Node) => boolean,
): FindMatch[] {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = page.ownerDocument.createTreeWalker(
    page,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    { acceptNode: (node) => (skip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) },
  );
  let aside: boolean | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLBRElement && text && !/\s$/.test(text)) text += " ";
    if (!(node instanceof Text)) continue;
    // No match runs from a header, footer or note into the body, or back.
    const inAside = node.parentElement?.closest("[data-office-aside]") != null;
    if (aside !== null && inAside !== aside) text += "\0";
    aside = inAside;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  if (nodes.length === 0) return [];
  const bounds = page.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return [];
  const at = (offset: number) => {
    let low = 0;
    for (let high = nodes.length - 1; low < high;) {
      const middle = (low + high + 1) >> 1;
      if (nodes[middle]!.start <= offset) low = middle;
      else high = middle - 1;
    }
    const entry = nodes[low]!;
    return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.data.length) };
  };
  return findOffsets(text, query).map((offset) => {
    const range = page.ownerDocument.createRange();
    const start = at(offset);
    const end = at(offset + query.length);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return {
      boxes: [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          left: (rect.left - bounds.left) / bounds.width,
          top: (rect.top - bounds.top) / bounds.height,
          width: rect.width / bounds.width,
          height: rect.height / bounds.height,
        })),
      aside: start.node.parentElement?.closest("[data-office-aside]") != null,
    };
  });
}
