import type { Options as ReactMarkdownOptions } from "react-markdown";
import remarkMath from "remark-math";

/**
 * Parser-level single-dollar math corrupts links, paths, and prices irreparably. Recognize guarded
 * spans during raw-source tokenization, before emphasis splits them, so rejection can unwind
 * without changing surrounding structure.
 */
export const remarkScientMath = [remarkMath, { singleDollarTextMath: false }] satisfies NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
>[number];

/** TeX longer than this is not typeset; the literal source is shown instead. */
const MAX_SCIENT_TEX_LENGTH = 1000;

const MATH_CODE_CLASS_NAME = "language-math";
export const SCIENT_MATH_TABLE_PIPE = "\uE000";

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

/** The display shape synthesized display nodes need to render: a pre wrapping a language-math code element. */
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

function inlineMathHastData(value: string) {
  return {
    hName: "code",
    hProperties: { className: ["language-math", "math-inline"] },
    hChildren: [{ type: "text", value }],
  };
}

interface VFileLike {
  toString(): string;
}

export interface ScientMathRefinementOptions {
  /**
   * Normalization preserves length but erases inline/display delimiter intent. Use original text at
   * node offsets to distinguish authored backslash delimiters.
   */
  sourceText?: string;
}

type AuthoredIntent = "inline" | "display";

function authoredIntentAt(sourceText: string | undefined, node: MdastNode): AuthoredIntent | null {
  if (sourceText === undefined) return null;
  const start = node.position?.start.offset;
  if (typeof start !== "number") return null;
  const opener = sourceText.slice(start, start + 2);
  if (opener === "\\(") return "inline";
  if (opener === "\\[") return "display";
  return null;
}

function displayMathNode(value: string, position: MdastNode["position"]): MdastNode {
  return {
    type: "math",
    value,
    data: displayMathHastData(value),
    ...(position ? { position } : {}),
  };
}

/**
 * Trims break nodes and edge whitespace from the run; a run with no prose
 * left contributes no paragraph. Edge newlines must go because remark-breaks
 * runs after this pass on the hard-break surface and would otherwise turn
 * them into stray `<br>`s at the split paragraphs' edges.
 */
function paragraphFromRun(run: MdastNode[]): MdastNode | null {
  while (run.length > 0 && run[0]?.type === "break") run.shift();
  while (run.length > 0 && run[run.length - 1]?.type === "break") run.pop();
  const first = run[0];
  if (first?.type === "text" && first.value !== undefined) {
    first.value = first.value.replace(/^\s+/, "");
  }
  const last = run[run.length - 1];
  if (last?.type === "text" && last.value !== undefined) {
    last.value = last.value.replace(/\s+$/, "");
  }
  const meaningful = run.some((node) => !(node.type === "text" && (node.value ?? "") === ""));
  return meaningful ? { type: "paragraph", children: run } : null;
}

/**
 * Display math authored as `\[...\]` breaks its paragraph, exactly as TeX
 * itself treats display math: the paragraph splits into the prose before, the
 * block equation, and the prose after. Only direct paragraph children are
 * extracted; a pair nested inside emphasis or a link stays inline.
 */
function extractAuthoredDisplayMath(node: MdastNode, sourceText: string | undefined): void {
  const children = node.children;
  if (!children) return;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type !== "paragraph") {
      extractAuthoredDisplayMath(child, sourceText);
      continue;
    }
    const inner = child.children ?? [];
    const hasDisplayIntent = inner.some(
      (grandchild) =>
        grandchild.type === "inlineMath" && authoredIntentAt(sourceText, grandchild) === "display",
    );
    if (!hasDisplayIntent) continue;

    const segments: MdastNode[] = [];
    let run: MdastNode[] = [];
    for (const grandchild of inner) {
      if (
        grandchild.type === "inlineMath" &&
        authoredIntentAt(sourceText, grandchild) === "display"
      ) {
        const paragraph = paragraphFromRun(run);
        if (paragraph) segments.push(paragraph);
        run = [];
        segments.push(displayMathNode(grandchild.value ?? "", grandchild.position));
      } else {
        run.push(grandchild);
      }
    }
    const trailing = paragraphFromRun(run);
    if (trailing) segments.push(trailing);
    children.splice(index, 1, ...segments);
  }
}

/** Whether the span at this node's offset was written with a lone `$` in the (normalized) source — explicit inline intent. */
function isSingleDollarSpan(source: string, node: MdastNode): boolean {
  const start = node.position?.start.offset;
  if (typeof start !== "number") return false;
  return source[start] === "$" && source[start + 1] !== "$";
}

/**
 * A paragraph holding exactly one `$$...$$` span is a block equation: own-line
 * `$$x$$` lands here. Spans the author wrote as `\(...\)` or single-dollar
 * `$...$` keep their inline intent instead; authored `\[...\]` was already
 * extracted as display math.
 */
function promoteSoleInlineMathParagraphs(
  node: MdastNode,
  sourceText: string | undefined,
  source: string,
): void {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type !== "paragraph") {
      promoteSoleInlineMathParagraphs(child, sourceText, source);
      continue;
    }
    const meaningful = (child.children ?? []).filter(
      (grandchild) => !(grandchild.type === "text" && (grandchild.value ?? "").trim() === ""),
    );
    const only = meaningful[0];
    if (meaningful.length === 1 && only?.type === "inlineMath") {
      if (isSingleDollarSpan(source, only)) continue;
      if (authoredIntentAt(sourceText, only) === "inline") continue;
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

/**
 * The upstream tokenizer also recognizes native backslash math and own-line
 * `$$x$$` as flow math. Recover Scient's authored inline intent, and reject
 * formulas it tokenized inside raw HTML literal regions before rehype sees them.
 */
function recoverMathContext(tree: MdastNode, source: string, authored: string): void {
  const literalElements: string[] = [];
  const visit = (node: MdastNode) => {
    if (node.type === "html") {
      // Consume complete tags and comments so an attribute containing "<code>"
      // cannot change the literal-region state.
      const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][\w:-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      for (const match of (node.value ?? "").matchAll(tags)) {
        const name = match[1]?.toLowerCase();
        if (name !== "code" && name !== "pre") continue;
        if (match[0].startsWith("</")) {
          const index = literalElements.lastIndexOf(name);
          if (index !== -1) literalElements.splice(index);
        } else literalElements.push(name);
      }
      return;
    }
    if (node.type === "math" || node.type === "inlineMath") {
      const original = rawSlice(authored, node);
      if (
        node.value?.includes(SCIENT_MATH_TABLE_PIPE) &&
        original?.includes("|") &&
        !original.includes(SCIENT_MATH_TABLE_PIPE)
      ) {
        node.value = node.value.replaceAll(SCIENT_MATH_TABLE_PIPE, "|");
        node.data =
          node.type === "math" ? displayMathHastData(node.value) : inlineMathHastData(node.value);
      }
      if (literalElements.length > 0) {
        node.type = "text";
        node.value = (
          rawSlice(authored, node) ??
          rawSlice(source, node) ??
          node.value ??
          ""
        ).replace(/\\([!-/:-@[-`{-~])/g, "$1");
        delete node.data;
        return;
      }
      if (node.type === "math" && authoredIntentAt(authored, node) === "inline") {
        const value = node.value ?? "";
        node.type = "paragraph";
        node.children = [
          {
            type: "inlineMath",
            value,
            ...(node.position ? { position: node.position } : {}),
            data: inlineMathHastData(value),
          },
        ];
        delete node.value;
        delete node.data;
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
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
 * Operate on parsed nodes so code, links, and raw HTML remain excluded; preserve literal source for
 * unclosed or oversized math and retain authored inline/display intent.
 */
export function remarkScientMathRefinements(options?: ScientMathRefinementOptions) {
  const sourceText = options?.sourceText;
  return (tree: MdastNode, file: VFileLike) => {
    const source = String(file);
    recoverMathContext(tree, source, sourceText ?? source);
    guardMathNodes(tree, source);
    extractAuthoredDisplayMath(tree, sourceText);
    promoteSoleInlineMathParagraphs(tree, sourceText, source);
  };
}
