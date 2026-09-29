/**
 * Direction marks for the `text/html` clipboard flavour of copied chat content.
 *
 * Word, Google Docs, and Pages do not see Scient's stylesheet, so a Hebrew or
 * Arabic paragraph pasted without explicit direction lands left-to-right and
 * its punctuation moves to the wrong end. Copies that contain right-to-left
 * text therefore carry each block's direction as both `dir` and inline CSS,
 * and left-to-right islands inside right-to-left blocks (inline code, math
 * source, link text, file paths, URLs) are wrapped as `<span dir="ltr">`.
 *
 * Everything here runs on a detached copy. The displayed message, its
 * direction resolution, and the `text/plain` flavour are never touched, and
 * no invisible bidi control characters are added.
 */
import {
  countStrongScripts,
  resolveProseBlockDirection,
  type FixedContentDirection,
} from "../bidi/contentDirection";

/** Paragraph-level blocks: pasted apps align these, so they also get `text-align`. */
const TEXT_BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "LI",
  "TD",
  "TH",
  "PRE",
]);
/** Containers whose direction orders their children (list markers, table columns). */
const CONTAINER_TAGS = new Set(["UL", "OL", "TABLE"]);
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, blockquote, li, td, th, pre, ul, ol, table";
/** Elements that are never wrapped into an inline run at the top of a fragment. */
const STRUCTURAL_TAGS = new Set([
  ...TEXT_BLOCK_TAGS,
  ...CONTAINER_TAGS,
  "ARTICLE",
  "DETAILS",
  "DIV",
  "FIGURE",
  "HR",
  "SECTION",
  "SUMMARY",
  "TBODY",
  "THEAD",
  "TFOOT",
  "TR",
]);
const FILE_LINK_CLASS_NAME = "chat-markdown-file-link";
const ELEMENT_ISLAND_SELECTOR = `code, a, .${FILE_LINK_CLASS_NAME}, span[dir="ltr"]`;
/**
 * Word marks its own direction runs with `<span dir>`. The macOS HTML importer
 * (Pages, TextEdit) maps `unicode-bidi: embed` to a writing direction, while a
 * bare `dir` computes to `isolate`, so islands state both.
 */
const LTR_ISLAND_STYLE = "direction:ltr;unicode-bidi:embed";
/**
 * URLs, absolute and relative file paths, and Windows paths written as prose.
 * Only ASCII characters can belong to a token, so adjacent Hebrew or Arabic
 * text is never swallowed into a left-to-right island.
 */
const LTR_TECHNICAL_TOKEN =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>"'`\u{80}-\u{10FFFF}]+|(?:~|\.{1,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)*|[\w.@~+-]+(?:\/[\w.@~+-]*)+|[A-Za-z]:\\[^\s<>"'`\u{80}-\u{10FFFF}]+/gu;
/** Sentence punctuation after a token belongs to the surrounding prose. */
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?'"]+$/u;

export function hasStrongRtl(text: string): boolean {
  return countStrongScripts(text).rtl > 0;
}

/** The browser's `dir="auto"` rule: the first strong character decides. */
function firstStrongDirection(text: string): FixedContentDirection | null {
  for (const character of text) {
    const counts = countStrongScripts(character);
    if (counts.rtl > 0) return "rtl";
    if (counts.ltr > 0) return "ltr";
  }
  return null;
}

function fixedDirection(value: string | null): FixedContentDirection | null {
  return value === "rtl" || value === "ltr" ? value : null;
}

/**
 * The direction a copied fragment was displayed in: the nearest resolved
 * `dir` around it in the rendered message, or its own first strong character.
 */
export function clipboardSourceDirection(
  element: Element | null,
  fallbackText: string,
): FixedContentDirection {
  for (let current = element; current; current = current.parentElement) {
    const dir = current.getAttribute("dir");
    const fixed = fixedDirection(dir);
    if (fixed) return fixed;
    if (dir === "auto") {
      const automatic = firstStrongDirection(current.textContent ?? "");
      if (automatic) return automatic;
    }
  }
  return firstStrongDirection(fallbackText) ?? "ltr";
}

function appendStyle(element: Element, declarations: string): void {
  const existing = element.getAttribute("style")?.trim() ?? "";
  element.setAttribute(
    "style",
    existing ? `${existing.replace(/;?$/u, ";")}${declarations}` : declarations,
  );
}

function hasAuthoredAlignment(element: Element): boolean {
  return (
    element.hasAttribute("align") ||
    /(?:^|;)\s*text-align\s*:/iu.test(element.getAttribute("style") ?? "")
  );
}

/** Prose the chat renderer counts for direction: code and math sources are excluded. */
function proseText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.tagName === "CODE" || element.tagName === "PRE") return "";
  if (element.tagName === "SPAN" && element.getAttribute("dir") === "ltr") return "";
  let text = "";
  for (const child of element.childNodes) text += proseText(child);
  return text;
}

/**
 * Source code stays left-to-right. A plain-text copy box keeps the direction
 * it was displayed in, which its wrapper records.
 */
function codeBlockDirection(pre: Element): FixedContentDirection {
  const declared = pre
    .closest("[data-copy-text-direction]")
    ?.getAttribute("data-copy-text-direction");
  if (declared === "rtl") return "rtl";
  if (declared === "auto") return firstStrongDirection(pre.textContent ?? "") ?? "ltr";
  return "ltr";
}

class ClipboardDirectionMarker {
  /** Blocks and inline wrappers whose direction encloses the text inside them. */
  private readonly directed = new WeakSet<Element>();
  private readonly islands = new WeakSet<Element>();

  constructor(
    private readonly container: Element,
    private readonly sourceDirection: FixedContentDirection,
  ) {}

  mark(): void {
    this.wrapTopLevelInlineRuns();
    for (const block of this.container.querySelectorAll(BLOCK_SELECTOR)) {
      this.markBlock(block, this.blockDirection(block));
    }
    this.isolateElementIslands();
    this.isolateTextIslands();
  }

  /** Direction of the nearest directed ancestor, or the fragment's source. */
  private enclosingDirection(node: Node): FixedContentDirection {
    for (
      let current = node.parentElement;
      current && current !== this.container;
      current = current.parentElement
    ) {
      if (this.directed.has(current)) {
        return fixedDirection(current.getAttribute("dir")) ?? this.sourceDirection;
      }
    }
    return this.sourceDirection;
  }

  /**
   * The direction the chat displayed for this block. Rendered blocks carry
   * it already; list items inherit their list, as in chat; anything else is
   * resolved from its own prose with the chat's paragraph rule.
   */
  private blockDirection(block: Element): FixedContentDirection {
    if (block.tagName === "PRE") return codeBlockDirection(block);
    const own = fixedDirection(block.getAttribute("dir"));
    if (own) return own;
    const inherited = this.enclosingDirection(block);
    if (block.tagName === "LI") return inherited;
    return resolveProseBlockDirection(proseText(block), inherited);
  }

  private markBlock(block: Element, direction: FixedContentDirection): void {
    const declarations = [`direction:${direction}`];
    if (TEXT_BLOCK_TAGS.has(block.tagName) && !hasAuthoredAlignment(block)) {
      // Table cells share their column's alignment, exactly as displayed.
      const alignment =
        fixedDirection(block.getAttribute("data-scient-table-column-direction")) ?? direction;
      declarations.push(`text-align:${alignment === "rtl" ? "right" : "left"}`);
    }
    block.setAttribute("dir", direction);
    appendStyle(block, declarations.join(";"));
    this.directed.add(block);
  }

  private isStructural(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as Element;
    return STRUCTURAL_TAGS.has(element.tagName) || element.querySelector(BLOCK_SELECTOR) !== null;
  }

  /**
   * A selection inside one paragraph copies only inline content, and a
   * selection that starts inside a list item copies that item's text beside
   * its nested list. Each such run gets the direction of the block it came
   * from as an inline wrapper, so pasting into an existing line stays inline.
   */
  private wrapTopLevelInlineRuns(): void {
    let run: ChildNode[] = [];
    const flush = () => {
      if (run.some((node) => (node.textContent ?? "").trim().length > 0)) {
        const wrapper = this.container.ownerDocument.createElement("span");
        wrapper.setAttribute("dir", this.sourceDirection);
        wrapper.setAttribute("style", `direction:${this.sourceDirection};unicode-bidi:embed`);
        run[0]!.before(wrapper);
        wrapper.append(...run);
        this.directed.add(wrapper);
      }
      run = [];
    };
    // Wrapping moves nodes, so iterate over a snapshot of the live child list.
    for (const child of Array.from(this.container.childNodes)) {
      if (this.isStructural(child)) flush();
      else run.push(child);
    }
    flush();
  }

  private isInsideIsland(node: Node): boolean {
    for (
      let current = node.parentElement;
      current && current !== this.container;
      current = current.parentElement
    ) {
      if (this.islands.has(current)) return true;
    }
    return false;
  }

  private isolate(element: Element): void {
    if (element.tagName === "SPAN") {
      element.setAttribute("dir", "ltr");
      appendStyle(element, LTR_ISLAND_STYLE);
      this.islands.add(element);
      return;
    }
    const wrapper = element.ownerDocument.createElement("span");
    wrapper.setAttribute("dir", "ltr");
    wrapper.setAttribute("style", LTR_ISLAND_STYLE);
    element.replaceWith(wrapper);
    wrapper.append(element);
    this.islands.add(wrapper);
  }

  private isolateElementIslands(): void {
    for (const element of this.container.querySelectorAll(ELEMENT_ISLAND_SELECTOR)) {
      if (element.closest("pre") || this.isInsideIsland(element)) continue;
      if (this.enclosingDirection(element) !== "rtl") continue;
      const isLinkText =
        element.tagName === "A" || element.classList.contains(FILE_LINK_CLASS_NAME);
      const text = element.textContent ?? "";
      // Link text in the surrounding right-to-left script is ordinary prose.
      if (isLinkText && (text.trim().length === 0 || hasStrongRtl(text))) continue;
      this.isolate(element);
    }
  }

  private isTechnicalTextContainer(node: Node): boolean {
    for (
      let current = node.parentElement;
      current && current !== this.container;
      current = current.parentElement
    ) {
      if (this.islands.has(current)) return true;
      if (current.tagName === "A" || current.tagName === "CODE" || current.tagName === "PRE") {
        return true;
      }
      if (current.classList.contains(FILE_LINK_CLASS_NAME)) return true;
    }
    return false;
  }

  private isolateTextIslands(): void {
    const document = this.container.ownerDocument;
    const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textNodes.push(node as Text);
    }
    for (const textNode of textNodes) {
      if (this.isTechnicalTextContainer(textNode)) continue;
      if (this.enclosingDirection(textNode) !== "rtl") continue;
      const text = textNode.data;
      const pieces: Node[] = [];
      let lastIndex = 0;
      for (const match of text.matchAll(LTR_TECHNICAL_TOKEN)) {
        const token = trimTechnicalToken(match[0]);
        // Dates, fractions, and ratios contain no letters and read correctly as numbers.
        if (!/[A-Za-z]/u.test(token)) continue;
        const start = match.index;
        if (start > lastIndex) pieces.push(document.createTextNode(text.slice(lastIndex, start)));
        const island = document.createElement("span");
        island.setAttribute("dir", "ltr");
        island.setAttribute("style", LTR_ISLAND_STYLE);
        island.textContent = token;
        this.islands.add(island);
        pieces.push(island);
        lastIndex = start + token.length;
      }
      if (pieces.length === 0) continue;
      if (lastIndex < text.length) pieces.push(document.createTextNode(text.slice(lastIndex)));
      textNode.replaceWith(...pieces);
    }
  }
}

/** Drops sentence punctuation and an unbalanced closing bracket from a token's end. */
function trimTechnicalToken(token: string): string {
  let trimmed = token.replace(TRAILING_SENTENCE_PUNCTUATION, "");
  while (/[)\]]$/u.test(trimmed)) {
    const closing = trimmed.endsWith(")") ? ")" : "]";
    const opening = closing === ")" ? "(" : "[";
    if (trimmed.split(opening).length >= trimmed.split(closing).length) break;
    trimmed = trimmed.slice(0, -1).replace(TRAILING_SENTENCE_PUNCTUATION, "");
  }
  return trimmed;
}

/**
 * Marks direction on a detached clipboard fragment in place. `sourceDirection`
 * is the direction of the block the fragment was copied from; it applies to
 * inline content that is not inside a copied block.
 */
export function markClipboardDirection(
  container: Element,
  sourceDirection: FixedContentDirection,
): void {
  new ClipboardDirectionMarker(container, sourceDirection).mark();
}
