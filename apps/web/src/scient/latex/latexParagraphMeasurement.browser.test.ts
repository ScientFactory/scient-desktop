import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createLatexParagraphTextWalker, measureLatexTextLines } from "./latexParagraphMeasurement";

let paragraph: HTMLParagraphElement;
beforeEach(() => {
  paragraph = document.createElement("p");
  paragraph.style.cssText = "font:20px/28px monospace;width:180px;white-space:pre-wrap;margin:0";
  document.body.append(paragraph);
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  paragraph.remove();
  vi.restoreAllMocks();
});

// Independent linear character scan establishes the source offset of each
// line from native geometry, including collapsed/empty leading text.
function nativeLineStarts(text: Text) {
  const range = document.createRange();
  range.selectNodeContents(text);
  const rectangles = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  const characters = Array.from({ length: text.length }, (_, offset) => {
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    return range.getBoundingClientRect().top;
  });
  let from = 0;
  return rectangles.flatMap((rectangle) => {
    const offset = characters.findIndex(
      (top, index) => index >= from && top >= rectangle.top - 0.5,
    );
    if (offset === -1) return [];
    from = offset;
    return [{ offset, top: rectangle.top, bottom: rectangle.bottom }];
  });
}

it("finds a long single-line run with one character-boundary read", () => {
  paragraph.style.width = "20000px";
  const text = document.createTextNode("Single line of source-preserving text. ".repeat(15));
  paragraph.append(text);
  const expected = nativeLineStarts(text);
  expect(expected).toHaveLength(1);
  const range = document.createRange();
  const bounds = vi.spyOn(range, "getBoundingClientRect");
  expect(measureLatexTextLines(text, range)).toEqual(expected);
  expect(bounds).toHaveBeenCalledTimes(1);
});

it.each([
  "A paragraph that wraps into several lines with words and spaces. ".repeat(8),
  "\n\n    \nAfter empty lines there is ordinary text that wraps. ".repeat(3),
  "  Prefix whitespace, a\nmanual break, and\n\nempty lines before more prose.",
  "Ligatures ffi, combining e\u0301, and mathematical text \u03b1+\u03b2 with several words. ".repeat(
    4,
  ),
])("keeps exact native line starts for wrapped and whitespace-sensitive text: %s", (value) => {
  const text = document.createTextNode(value);
  paragraph.append(text);
  const expected = nativeLineStarts(text);
  expect(expected.length).toBeGreaterThan(1);
  expect(measureLatexTextLines(text, document.createRange())).toEqual(expected);
});

it("does not change source text or the native selection and accepts hidden runs", () => {
  const text = document.createTextNode("A selected paragraph with source text that wraps.");
  paragraph.append(text);
  const selection = document.getSelection()!;
  selection.collapse(text, 5);
  const source = paragraph.innerHTML;
  measureLatexTextLines(text, document.createRange());
  expect(paragraph.innerHTML).toBe(source);
  expect(selection.anchorNode).toBe(text);
  expect(selection.anchorOffset).toBe(5);
  paragraph.style.display = "none";
  expect(measureLatexTextLines(text, document.createRange())).toEqual([]);
});

function paragraphTextNodes(element: HTMLElement) {
  const walker = createLatexParagraphTextWalker(element);
  const nodes: globalThis.Node[] = [];
  for (let node; (node = walker.nextNode());) nodes.push(node);
  return nodes;
}

it("prunes entire atom and page-gap subtrees while retaining marked prose", () => {
  const before = document.createTextNode("Before ");
  const strong = document.createElement("strong");
  const marked = document.createTextNode("marked prose ");
  strong.append(marked);
  const atom = document.createElement("span");
  atom.contentEditable = "false";
  const gap = document.createElement("span");
  gap.className = "scient-latex-pagination-gap";
  for (const excluded of [atom, gap]) {
    for (let index = 0; index < 1000; index++) {
      const glyph = document.createElement("span");
      glyph.textContent = "Rendered widget text";
      excluded.append(glyph);
    }
  }
  const after = document.createTextNode("after.");
  paragraph.append(before, strong, atom, gap, after);
  const selection = document.getSelection()!;
  selection.collapse(marked, 3);
  const source = paragraph.innerHTML;
  // Counting visits delegates to the actual native TreeWalker filter. Neither
  // glyph descendants nor their text should be walked just to reject them.
  const nativeWalker = document.createTreeWalker.bind(document);
  let visited = 0;
  vi.spyOn(document, "createTreeWalker").mockImplementation((root, show, filter) =>
    nativeWalker(root, show, {
      acceptNode(node) {
        visited++;
        return typeof filter === "function"
          ? filter(node)
          : (filter?.acceptNode(node) ?? NodeFilter.FILTER_ACCEPT);
      },
    }),
  );
  expect(paragraphTextNodes(paragraph)).toEqual([before, marked, after]);
  expect(visited).toBe(6);
  expect(paragraph.innerHTML).toBe(source);
  expect(selection.anchorNode).toBe(marked);
  expect(selection.anchorOffset).toBe(3);
});

it("excludes a noneditable paragraph root without excluding its outside ancestors", () => {
  const text = document.createTextNode("A paragraph's own text.");
  paragraph.append(text);
  paragraph.contentEditable = "false";
  expect(paragraphTextNodes(paragraph)).toEqual([]);
  paragraph.removeAttribute("contenteditable");
  const wrapper = document.createElement("div");
  wrapper.contentEditable = "false";
  paragraph.replaceWith(wrapper);
  wrapper.append(paragraph);
  try {
    expect(paragraphTextNodes(paragraph)).toEqual([text]);
  } finally {
    wrapper.replaceWith(paragraph);
  }
});

it("measures native line starts across marks around embedded noneditable content", () => {
  paragraph.innerHTML =
    'Prose before <em>words that wrap across several lines</em><span contenteditable="false"><strong>Atom text</strong></span> and after with more prose.';
  const nodes = paragraphTextNodes(paragraph);
  expect(nodes).toHaveLength(3);
  for (const node of nodes)
    expect(measureLatexTextLines(node, document.createRange())).toEqual(
      nativeLineStarts(node as Text),
    );
});
