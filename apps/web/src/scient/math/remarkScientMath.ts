import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkMath from "remark-math";

/**
 * remark-math with single-dollar parsing off: `$...$` at the parser level
 * corrupts links, paths, shell identifiers, and prices, so only the
 * unambiguous `$$` forms are parsed there. Single-dollar math is recognized
 * afterwards by `remarkScientMathRefinements`, where code, links, and raw HTML
 * are already structurally excluded and stricter token rules can apply.
 */
export const remarkScientMath = [remarkMath, { singleDollarTextMath: false }] satisfies NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
>[number];

/** TeX longer than this is not typeset; the literal source is shown instead. */
export const MAX_SCIENT_TEX_LENGTH = 1000;

const MATH_CODE_CLASS_NAME = "language-math";

/**
 * Recognizes the `<code>` nodes remark-math produces. It also tags them
 * `math-inline`/`math-display`, but sanitization keeps only `language-*`
 * classes, so inline versus display is decided by the surrounding element.
 */
export function isScientMathCodeClassName(className: string | undefined): boolean {
  return className !== undefined && className.split(/\s+/).includes(MATH_CODE_CLASS_NAME);
}

interface MdastNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdastNode[];
  data?: unknown;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

/** The hast instructions mdast-util-math attaches to the inline math nodes it parses; synthesized nodes need the same shape to render. */
function inlineMathHastData(value: string) {
  return {
    hName: "code",
    hProperties: { className: ["language-math", "math-inline"] },
    hChildren: [{ type: "text", value }],
  };
}

/** The display shape: a pre wrapping a language-math code element. */
function displayMathHastData(value: string) {
  return {
    hName: "pre",
    hChildren: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-math", "math-display"] },
        children: [{ type: "text", value }],
      },
    ],
  };
}

interface VFileLike {
  toString(): string;
}

/** Subtrees whose text must never become math: literal regions and link machinery. */
const EXCLUDED_PARENT_TYPES = new Set([
  "code",
  "inlineCode",
  "html",
  "math",
  "inlineMath",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

const IDENTIFIER_CONTENT_PATTERN = /^[A-Z][A-Z0-9]+$/;
const MATH_SIGNAL_PATTERN = /[\\^_{}=+\-*/<>|]/;

/**
 * Whether a candidate `$...$` span reads as math. Shell/currency identifiers
 * like `$PATH$` or `$USD$` stay text; spaced prose like `5 and ` stays text
 * unless an operator or control sequence marks it as an expression. Compact
 * numeric spans — `$42$`, `$1/2$`, `$12-15$` — are math.
 */
function isPlausibleTexSpan(content: string): boolean {
  if (content.length === 0 || content.length > MAX_SCIENT_TEX_LENGTH) return false;
  if (IDENTIFIER_CONTENT_PATTERN.test(content)) return false;
  if (/\s/.test(content) && !MATH_SIGNAL_PATTERN.test(content)) return false;
  return true;
}

interface DollarSpan {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Scans one text value for `$...$` spans under the token rules: the opener is
 * not preceded by a word character, backslash, or dollar and not followed by
 * whitespace; the closer is not preceded by whitespace and not followed by a
 * digit (protecting `$5-$10`) or another dollar.
 */
function findDollarSpans(value: string): DollarSpan[] {
  const spans: DollarSpan[] = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const open = value.indexOf("$", searchFrom);
    if (open === -1) break;
    const before = value[open - 1];
    if (isWordCharacter(before) || before === "\\" || before === "$") {
      searchFrom = open + 1;
      continue;
    }
    const first = value[open + 1];
    if (first === undefined || /\s/.test(first) || first === "$") {
      searchFrom = open + 1;
      continue;
    }
    const close = value.indexOf("$", open + 1);
    if (close === -1) break;
    const content = value.slice(open + 1, close);
    const beforeClose = value[close - 1];
    const afterClose = value[close + 1];
    if (
      content.includes("\n") ||
      (beforeClose !== undefined && /\s/.test(beforeClose)) ||
      (afterClose !== undefined && (/\d/.test(afterClose) || afterClose === "$")) ||
      !isPlausibleTexSpan(content)
    ) {
      searchFrom = open + 1;
      continue;
    }
    spans.push({ start: open, end: close + 1, content });
    searchFrom = close + 1;
  }
  return spans;
}

function recognizeDollarSpans(node: MdastNode, source: string, insideExcluded: boolean): void {
  if (EXCLUDED_PARENT_TYPES.has(node.type)) {
    insideExcluded = true;
  }
  const children = node.children;
  if (!children) return;

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type !== "text" || insideExcluded) {
      recognizeDollarSpans(child, source, insideExcluded);
      continue;
    }
    const value = child.value ?? "";
    if (!value.includes("$")) continue;
    // Markdown escaping collapses `\$` into a plain dollar in the node value,
    // so an explicitly escaped dollar is only visible in the raw source; a
    // node that uses one opts its whole text run out of math recognition.
    const raw = rawSlice(source, child);
    if (raw !== null && raw.includes("\\$")) continue;
    const spans = findDollarSpans(value);
    if (spans.length === 0) continue;

    const replacements: MdastNode[] = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) {
        replacements.push({ type: "text", value: value.slice(cursor, span.start) });
      }
      replacements.push({
        type: "inlineMath",
        value: span.content,
        data: inlineMathHastData(span.content),
      });
      cursor = span.end;
    }
    if (cursor < value.length) {
      replacements.push({ type: "text", value: value.slice(cursor) });
    }
    children.splice(index, 1, ...replacements);
  }
}

/** A paragraph holding exactly one `$$...$$` span is a block equation: `\[...\]` and own-line `$$x$$` both land here. */
function promoteSoleInlineMathParagraphs(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type !== "paragraph") {
      promoteSoleInlineMathParagraphs(child);
      continue;
    }
    const meaningful = (child.children ?? []).filter(
      (grandchild) => !(grandchild.type === "text" && (grandchild.value ?? "").trim() === ""),
    );
    const only = meaningful[0];
    if (meaningful.length === 1 && only?.type === "inlineMath") {
      children[index] = {
        type: "math",
        value: only.value ?? "",
        data: displayMathHastData(only.value ?? ""),
        ...(child.position ? { position: child.position } : {}),
      };
    }
  }
}

function rawSlice(source: string, node: MdastNode): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return source.slice(start, end);
}

/** `$$\nx + y` with no closer parses as display math; while it streams (or if it never closes) it must stay literal. */
function isClosedDisplayMath(raw: string): boolean {
  const trimmed = raw.trimEnd();
  return trimmed.length > 2 && trimmed.endsWith("$$");
}

function isClosedMathFence(raw: string): boolean {
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!opener?.[1]) return true;
  const marker = opener[1][0] ?? "`";
  const closePattern = new RegExp(`\\n {0,3}\\${marker}{${opener[1].length},}[ \\t]*$`);
  return closePattern.test(raw.trimEnd());
}

function downgradeToLiteral(node: MdastNode, literal: string): void {
  node.type = "code";
  node.lang = null;
  node.value = literal;
  // The parsed math node carries hast instructions; they must go with it.
  delete node.data;
  delete node.children;
}

function guardMathNodes(node: MdastNode, source: string): void {
  for (const child of node.children ?? []) {
    guardMathNodes(child, source);
  }
  if (node.type === "math") {
    const raw = rawSlice(source, node);
    if (
      (node.value ?? "").length > MAX_SCIENT_TEX_LENGTH ||
      (raw !== null && !isClosedDisplayMath(raw))
    ) {
      downgradeToLiteral(node, raw ?? node.value ?? "");
    }
    return;
  }
  if (node.type === "inlineMath" && (node.value ?? "").length > MAX_SCIENT_TEX_LENGTH) {
    node.type = "text";
    node.value = `$$${node.value ?? ""}$$`;
    delete node.data;
    return;
  }
  if (node.type === "code" && node.lang === "math") {
    const raw = rawSlice(source, node);
    if (
      (node.value ?? "").length > MAX_SCIENT_TEX_LENGTH ||
      (raw !== null && !isClosedMathFence(raw))
    ) {
      node.lang = null;
    }
  }
}

/**
 * The Scient math pass over the parsed tree, in three steps: downgrade
 * unclosed or oversized math to its literal source, promote sole-`$$`
 * paragraphs to display math, then recognize validated single-dollar spans.
 * Operating on the tree keeps code, links, and raw HTML structurally excluded
 * and never rewrites the source string.
 */
export function remarkScientMathRefinements() {
  return (tree: MdastNode, file: VFileLike) => {
    const source = String(file);
    guardMathNodes(tree, source);
    promoteSoleInlineMathParagraphs(tree);
    recognizeDollarSpans(tree, source, false);
  };
}
