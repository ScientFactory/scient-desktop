import type { EditorView } from "@tiptap/pm/view";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { latexTypographyProperties } from "./latexTypography";

/** Text edits can retain passive math geometry when every formula is unchanged. */
export function hasUnchangedParagraphMath(before: DocumentNode, after: DocumentNode) {
  const objects = (node: DocumentNode) => node.content.content.filter((child) => !child.isText);
  const previous = objects(before);
  const next = objects(after);
  return (
    previous.length === next.length &&
    next.every((node, index) => node.type.name === "latexInlineMath" && node.eq(previous[index]!))
  );
}

function copyReadingMath(original: HTMLElement): HTMLElement {
  const copy = original.cloneNode(true) as HTMLElement;
  const shadows = (source: HTMLElement, target: HTMLElement) => {
    if (source.shadowRoot) {
      const root = target.shadowRoot ?? target.attachShadow({ mode: "open" });
      root.replaceChildren(
        ...[...source.shadowRoot.childNodes].map((node) => node.cloneNode(true)),
      );
      root.adoptedStyleSheets = source.shadowRoot.adoptedStyleSheets;
    }
    [...source.children].forEach((child, index) => {
      const clone = target.children[index];
      if (child instanceof HTMLElement && clone instanceof HTMLElement) shadows(child, clone);
    });
  };
  shadows(original, copy);
  copy.contentEditable = "false";
  copy.style.contentVisibility = "visible";
  return copy;
}

/** Text belonging to a paragraph, pruning atom views and pagination widgets. */
export function createLatexParagraphTextWalker(element: HTMLElement) {
  const excluded = '[contenteditable="false"], .scient-latex-pagination-gap';
  const excludedRoot = element.matches(excluded);
  return element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (excludedRoot) return NodeFilter.FILTER_REJECT;
        if (node instanceof Element)
          return node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
}

/** Source offsets of rendered text lines, using the browser's actual wrap geometry. */
export function measureLatexTextLines(text: globalThis.Node, range: Range) {
  const length = text.textContent?.length ?? 0;
  if (!length) return [];
  range.selectNodeContents(text);
  const rectangles = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  let start = 0;
  return rectangles.flatMap((rectangle) => {
    let low = start;
    let high = length;
    // Most text runs occupy one line. If their current start already lies on
    // the requested line, it is the lower bound; do not search that run again.
    if (low < high) {
      range.setStart(text, low);
      range.setEnd(text, low + 1);
      if (range.getBoundingClientRect().top >= rectangle.top - 0.5) high = low;
    }
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      range.setStart(text, middle);
      range.setEnd(text, Math.min(length, middle + 1));
      if (range.getBoundingClientRect().top < rectangle.top - 0.5) low = middle + 1;
      else high = middle;
    }
    start = low;
    return start < length ? [{ offset: start, top: rectangle.top, bottom: rectangle.bottom }] : [];
  });
}

const layoutProperties = [
  "display",
  "box-sizing",
  "width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  ...latexTypographyProperties,
  "letter-spacing",
  "word-spacing",
  "white-space",
  "text-align",
  "text-align-last",
  "text-indent",
  "text-transform",
  "text-wrap",
  "word-break",
  "overflow-wrap",
  "hyphens",
  "tab-size",
  "direction",
  "unicode-bidi",
  "line-break",
  "writing-mode",
  "vertical-align",
  "text-orientation",
] as const;

/** Measure one ordinary paragraph outside the editable DOM and its page gaps.
 * Resolved styles retain mark fonts and indentation without cloning any live
 * editor. Source positions come from the original text nodes, never the copy.
 */
export function measureLatexParagraph<T>(
  view: EditorView,
  original: HTMLElement,
  measure: (
    copy: HTMLElement,
    positionAtDOM: (text: globalThis.Node, offset: number) => number,
    nodeAtDOM: (position: number) => HTMLElement | null,
  ) => T,
): T {
  const owner = original.ownerDocument;
  const positions = new WeakMap<globalThis.Node, number>();
  const objects = new WeakMap<globalThis.Node, HTMLElement>();
  const copyNode = (node: globalThis.Node): globalThis.Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = owner.createTextNode(node.textContent ?? "");
      positions.set(text, view.posAtDOM(node, 0));
      return text;
    }
    if (!(node instanceof HTMLElement)) return null;
    if (node.matches(".scient-latex-pagination-gap")) return null;
    const readingMath = node.matches('[data-math-reading-view="true"]');
    if (!readingMath && node.matches('[contenteditable="false"]')) return null;
    const copy = readingMath ? copyReadingMath(node) : owner.createElement(node.tagName);
    if (readingMath) objects.set(node, copy);
    if (node.lang) copy.lang = node.lang;
    const style = getComputedStyle(node);
    for (const property of layoutProperties)
      copy.style.setProperty(property, style.getPropertyValue(property));
    for (const child of readingMath ? [] : node.childNodes) {
      const next = copyNode(child);
      if (next) copy.append(next);
    }
    return copy;
  };
  const copy = copyNode(original) as HTMLElement;
  const host = owner.createElement("div");
  host.className = "scient-latex-visual-document";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.lang = original.closest<HTMLElement>("[lang]")?.lang ?? owner.documentElement.lang;
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style paint;padding:0;margin:0;min-height:0;";
  copy.style.margin = "0";
  copy.style.contentVisibility = "visible";
  host.append(copy);
  owner.body.append(host);
  try {
    return measure(
      copy,
      (text, offset) => {
        const position = positions.get(text);
        if (position === undefined) throw new Error("Unmapped paragraph measurement text");
        return position + offset;
      },
      (position) => {
        const source = view.nodeDOM(position);
        return source ? (objects.get(source) ?? null) : null;
      },
    );
  } finally {
    host.remove();
  }
}
