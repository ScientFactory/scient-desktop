import type { Element, ElementContent, Root, Text } from "hast";

import { scientMathNodes, type ScientMathNode } from "./scientMathRanges";

/**
 * Scient's math on Words (markdown/wordsHast.ts): Scient's grammar decides what is math, Words
 * sees each formula as a same-length placeholder, so offsets stay as authored, and the sanitized
 * tree gets back the `language-math` code that chat's components typeset with KaTeX.
 */

// Unicode noncharacters never appear in exchanged text; a message holding one renders no math.
const MARK = "\uFDD0";
const FILL = "\uFDD1";
const FIRST_INDEX = 0xe000;
const MAX_FORMULAS = 0xf8ff - FIRST_INDEX + 1;
const ENCODED_PLACEHOLDER = /%EF%B7%90((?:%[0-9A-F]{2}){3})(?:%EF%B7%91)*/gi;

// Formulas in these stay their authored source.
const MATH_FREE = new Set(["code", "pre", "script", "style", "textarea", "title"]);
// A display formula is a block in these; elsewhere it shows inline.
const BLOCK_PARENTS = new Set([
  "blockquote",
  "dd",
  "details",
  "div",
  "dt",
  "figure",
  "li",
  "p",
  "section",
  "td",
  "th",
]);

interface PlacedFormula {
  readonly node: ScientMathNode;
  readonly source: string;
}

export interface ScientWordsMath {
  /** `markdown` with each formula replaced by a placeholder of the same length. */
  readonly prepare: (markdown: string) => string;
  /**
   * Scient's math elements in place of the placeholders in a sanitized tree; a `math` fence the
   * grammar did not read stays code.
   */
  readonly restore: (tree: Root, options: { readonly preview: boolean }) => void;
}

const text = (value: string): Text => ({ type: "text", value });

/** One message's formulas; `prepare` also takes Markdown Words renders again inside it. */
export function scientWordsMath(): ScientWordsMath {
  const placed: PlacedFormula[] = [];
  let disabled: boolean | undefined;

  const prepare = (markdown: string): string => {
    disabled ??= markdown.includes(MARK);
    if (disabled) return markdown;
    let prepared = "";
    let from = 0;
    for (const node of scientMathNodes(markdown)) {
      const source = markdown.slice(node.start, node.end);
      if (placed.length >= MAX_FORMULAS || source.length < 2 || source.includes(MARK)) continue;
      prepared += `${markdown.slice(from, node.start)}${MARK}${String.fromCharCode(
        FIRST_INDEX + placed.length,
      )}${FILL.repeat(source.length - 2)}`;
      placed.push({ node, source });
      from = node.end;
    }
    return from === 0 ? markdown : prepared + markdown.slice(from);
  };

  const formulaAt = (value: string, at: number): PlacedFormula | undefined =>
    placed[value.charCodeAt(at + 1) - FIRST_INDEX];

  const authored = (value: string): string => {
    let result = "";
    let from = 0;
    for (let at = value.indexOf(MARK); at !== -1; at = value.indexOf(MARK, from)) {
      const formula = formulaAt(value, at);
      if (!formula) break;
      result += value.slice(from, at) + formula.source;
      from = at + formula.source.length;
    }
    return result + value.slice(from);
  };

  const authoredAttribute = (value: string): string =>
    authored(
      value.replace(ENCODED_PLACEHOLDER, (written, index: string) => {
        const formula = placed[decodeURIComponent(index).charCodeAt(0) - FIRST_INDEX];
        return formula ? encodeURI(formula.source) : written;
      }),
    );

  const restore = (tree: Root, options: { readonly preview: boolean }) => {
    const displays = new WeakSet<Element>();

    const mathElement = (formula: PlacedFormula, parentTag: string): ElementContent => {
      const { kind, tex } = formula.node;
      if (!options.preview && kind !== "inline" && BLOCK_PARENTS.has(parentTag)) {
        const block: Element = {
          type: "element",
          tagName: "pre",
          properties: kind === "display" ? { dataScientMathSource: formula.source } : {},
          children: [
            {
              type: "element",
              tagName: "code",
              properties:
                kind === "display" ? { className: ["language-math", "math-display"] } : {},
              children: [text(tex)],
            },
          ],
        };
        displays.add(block);
        return block;
      }
      if (kind === "literal") return text(formula.source);
      return {
        type: "element",
        tagName: "code",
        properties: {
          className: ["language-math", "math-inline"],
          dataScientMathSource: formula.source,
          // A one-line preview keeps it as math (wordsHast's flattenPreview).
          ...(options.preview ? { dataMarkdownMath: "inline" } : {}),
        },
        children: [text(tex)],
      };
    };

    const expand = (value: string, mathAllowed: boolean, parentTag: string): ElementContent[] => {
      const parts: ElementContent[] = [];
      let from = 0;
      for (let at = value.indexOf(MARK); at !== -1; at = value.indexOf(MARK, from)) {
        const formula = formulaAt(value, at);
        if (!formula) break;
        if (at > from) parts.push(text(value.slice(from, at)));
        parts.push(mathAllowed ? mathElement(formula, parentTag) : text(formula.source));
        from = at + formula.source.length;
      }
      if (from < value.length) parts.push(text(value.slice(from)));
      return parts;
    };

    const visit = (node: Root | Element, mathAllowed: boolean) => {
      const parentTag = node.type === "root" ? "p" : node.tagName;
      const children = node.children as ElementContent[];
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        if (child.type === "text") {
          if (placed.length === 0 || !child.value.includes(MARK)) continue;
          const parts = expand(child.value, mathAllowed, parentTag);
          children.splice(index, 1, ...parts);
          index += parts.length - 1;
          continue;
        }
        if (child.type !== "element" || displays.has(child)) continue;
        if (placed.length > 0) {
          for (const [key, value] of Object.entries(child.properties)) {
            if (typeof value === "string" && /\uFDD0|%EF%B7%90/i.test(value)) {
              child.properties[key] = authoredAttribute(value);
            }
          }
        }
        downgradeUnreadMathFence(child);
        visit(child, mathAllowed && !MATH_FREE.has(child.tagName));
        if (child.tagName === "p") {
          const blocks = splitAroundDisplays(child, displays);
          if (blocks) {
            children.splice(index, 1, ...blocks);
            index += blocks.length - 1;
          }
        }
      }
    };
    visit(tree, true);
  };

  return { prepare, restore };
}

/**
 * A `math` fence Scient's grammar did not read, unclosed or oversized, stays code. Words wrote it
 * (it has a position); raw HTML that asks for math keeps it.
 */
function downgradeUnreadMathFence(node: Element) {
  if (node.tagName !== "pre" || !node.position) return;
  const code = node.children.find((child): child is Element => child.type === "element");
  const className = code?.properties.className;
  if (code && Array.isArray(className) && className.includes("language-math")) {
    code.properties.className = className.filter((name) => name !== "language-math");
  }
}

const isBlank = (node: ElementContent | undefined) =>
  node !== undefined &&
  ((node.type === "text" && node.value.trim() === "") ||
    (node.type === "element" && node.tagName === "br"));

/** The paragraph's own prose around a display formula, as remarkScientMathRefinements splits it. */
function paragraphFromRun(paragraph: Element, run: ElementContent[]): Element | null {
  while (isBlank(run[0])) run.shift();
  while (isBlank(run.at(-1))) run.pop();
  const first = run[0];
  if (first?.type === "text") run[0] = text(first.value.replace(/^\s+/, ""));
  const last = run.at(-1);
  if (last?.type === "text") run[run.length - 1] = text(last.value.replace(/\s+$/, ""));
  if (run.length === 0) return null;
  return { ...paragraph, properties: { ...paragraph.properties }, children: run };
}

/** Display math breaks its paragraph, as TeX does. Null when the paragraph holds none. */
function splitAroundDisplays(paragraph: Element, displays: WeakSet<Element>) {
  if (!paragraph.children.some((child) => child.type === "element" && displays.has(child))) {
    return null;
  }
  const blocks: ElementContent[] = [];
  let run: ElementContent[] = [];
  for (const child of paragraph.children) {
    if (child.type === "element" && displays.has(child)) {
      const before = paragraphFromRun(paragraph, run);
      if (before) blocks.push(before, text("\n"));
      blocks.push(child, text("\n"));
      run = [];
    } else run.push(child);
  }
  const after = paragraphFromRun(paragraph, run);
  if (after) blocks.push(after);
  else blocks.pop();
  return blocks;
}

/** The source a math element was written as, so Find indexes what the user wrote. */
export function scientMathNodeSource(node: Element | undefined, tex: string): string {
  const source = node?.properties?.dataScientMathSource;
  return typeof source === "string" ? source : tex;
}
