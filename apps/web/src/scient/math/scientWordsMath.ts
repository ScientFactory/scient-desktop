import type { Element, ElementContent, Root, Text } from "hast";

/**
 * Scient's math on Words (markdown/wordsHast.ts): Words decides what is math, and each formula it
 * reads becomes the `language-math` code chat's components typeset with KaTeX, carrying the
 * formula's authored source for Find.
 */

const MATH_CODE_CLASS_NAME = "language-math";

/**
 * Recognizes Scient's math code. Sanitizing keeps only `language-*` classes, so inline versus
 * display is decided by the surrounding element.
 */
export function isScientMathCodeClassName(className: string | undefined): boolean {
  return className !== undefined && className.split(/\s+/).includes(MATH_CODE_CLASS_NAME);
}

/** TeX longer than this is not typeset; the literal source is shown instead. */
const MAX_SCIENT_TEX_LENGTH = 1000;

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

// Before a formula alone on its line: only container markers (quotes, list bullets, indentation).
const LINE_PREFIX = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*$/;
const LINE_SUFFIX = /^[ \t]*(?:\r?\n|\r|$)/;
// The next line, when it underlines a one-line formula into a setext heading.
const SETEXT_UNDERLINE = /^[ \t]*(?:\r?\n|\r)[ \t>]*(-+|=+)[ \t]*(?:\r?\n|\r|$)/;

// Shell variables and paths (`$PATH$`, `$HOME/$USER`) pair up as formulas; numeric subscripts
// (`$A_1$`) and up to three capitals (`$Q$`, `$NPV$`) are symbols.
const SHELL_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const SHELL_PATH = /^[A-Z][A-Z0-9_]*[/:.]/;
const SYMBOL_CAPITALS = /^(?:[A-Z]+_\d+|[A-Z][A-Z0-9]{0,2})$/;

/** A single-dollar formula's TeX that is a shell variable or path, which stays text. */
export function isScientShellVariableTex(content: string): boolean {
  return (
    (SHELL_VARIABLE.test(content) && !SYMBOL_CAPITALS.test(content)) || SHELL_PATH.test(content)
  );
}

interface Formula {
  /** Words drew it as a block, and it is not `$$…$$` beside other text on its line. */
  readonly display: boolean;
  /** Shown as its source: oversized TeX, or a shell variable between two dollars. */
  readonly literal: boolean;
  /** The line that made a display formula a setext heading: a rule or a paragraph after it. */
  readonly underline: string | undefined;
  readonly tex: string;
  /** The source Words read, so insight blocks can map the formula back to the message. */
  readonly origin: string;
}

const formulas = new WeakMap<Element, Formula>();

const text = (value: string): Text => ({ type: "text", value });

/** Whether `source[start, end)` stands alone on its line(s), past container markers. */
function aloneOnLine(source: string, start: number, end: number): boolean {
  const lineStart = Math.max(
    source.lastIndexOf("\n", start - 1),
    source.lastIndexOf("\r", start - 1),
  );
  return (
    LINE_PREFIX.test(source.slice(lineStart + 1, start)) && LINE_SUFFIX.test(source.slice(end))
  );
}

/**
 * Words' formula `svg`, read from `source`, as Scient's math code: it waits under wordsHast's
 * placeholder until `restoreScientWordsMath` places it. `$$…$$` beside other text on its line
 * shows inline, as Scient always showed it.
 */
export function scientWordsFormula(svg: Element, source: string): Element {
  const start = svg.position!.start.offset!;
  const end = svg.position!.end.offset!;
  const authored = source.slice(start, end);
  const tex = String(svg.properties.ariaLabel ?? "").replace(/^[\r\n]+|[\r\n]+$/g, "");
  const doubleDollar = authored.startsWith("$$");
  const ownLine = aloneOnLine(source, start, end);
  const display =
    /display:\s*block/.test(String(svg.properties.style ?? "")) && (!doubleDollar || ownLine);
  const formula: Element = {
    type: "element",
    tagName: "code",
    properties: { dataScientMathSource: authored },
    children: [text(tex)],
    position: svg.position,
  };
  formulas.set(formula, {
    display,
    literal:
      tex.length > MAX_SCIENT_TEX_LENGTH ||
      (!doubleDollar && authored.startsWith("$") && isScientShellVariableTex(tex)),
    underline:
      display && ownLine ? SETEXT_UNDERLINE.exec(source.slice(end, end + 1024))?.[1] : undefined,
    tex,
    origin: source,
  });
  return formula;
}

export interface ScientWordsMathRestore {
  /** A one-line preview, where every formula shows inline. */
  readonly preview: boolean;
  /** The message. */
  readonly text: string;
  /** The Markdown Words read, which differs from `text` when insight blocks were rewritten. */
  readonly source: string;
  /** The message offset for an offset in `source`, when they differ. */
  readonly toOriginal?: ((offset: number) => number) | undefined;
  /** Words' tree for Markdown read without math, for an image's alt text. */
  readonly withoutMath: (markdown: string) => Root;
}

/**
 * Scient's math elements in place of wordsHast's placeholders in a sanitized tree. A `math` fence
 * Words did not read as math stays code, and an image's alt text keeps a formula's source.
 */
export function restoreScientWordsMath(
  tree: Root,
  placed: ReadonlyMap<string, Element>,
  options: ScientWordsMathRestore,
) {
  const { source, toOriginal } = options;
  const altMayHoldMath = source.includes("![") && /[$\\]/.test(source);
  if (placed.size === 0 && !altMayHoldMath && !source.includes("math")) return;
  const displays = new WeakSet<Element>();
  /** What the message says at a position in `source`. */
  const written = (node: Element) =>
    toOriginal
      ? options.text.slice(
          toOriginal(node.position!.start.offset!),
          toOriginal(node.position!.end.offset!),
        )
      : source.slice(node.position!.start.offset, node.position!.end.offset);

  const mathElement = (code: Element, parentTag: string, mathAllowed: boolean): ElementContent => {
    const formula = formulas.get(code)!;
    // Words read an insight block's rewritten source; Find needs the message's own.
    const authored =
      toOriginal && formula.origin === source
        ? written(code)
        : String(code.properties.dataScientMathSource);
    if (!mathAllowed) return text(authored);
    if (formula.display && !options.preview && BLOCK_PARENTS.has(parentTag)) {
      const element: Element = {
        type: "element",
        tagName: "pre",
        properties: formula.literal ? {} : { dataScientMathSource: authored },
        children: [
          {
            type: "element",
            tagName: "code",
            properties: formula.literal
              ? {}
              : { className: [MATH_CODE_CLASS_NAME, "math-display"] },
            children: [text(formula.literal ? authored : formula.tex)],
          },
        ],
      };
      displays.add(element);
      return element;
    }
    if (formula.literal) return text(authored);
    return {
      type: "element",
      tagName: "code",
      properties: {
        className: [MATH_CODE_CLASS_NAME, "math-inline"],
        dataScientMathSource: authored,
        // A one-line preview keeps it as math (wordsHast's flattenPreview).
        ...(options.preview ? { dataMarkdownMath: "inline" } : {}),
      },
      children: [text(formula.tex)],
    };
  };

  // Words writes a formula in alt text as its TeX; read without math, it keeps its delimiters.
  const keepAltSource = (image: Element) => {
    if (!altMayHoldMath || !image.position || !image.properties.alt) return;
    const markdown = written(image);
    if (!/[$\\]/.test(markdown)) return;
    const alt = findImage(options.withoutMath(markdown))?.properties.alt;
    if (typeof alt === "string") image.properties.alt = alt;
  };

  /** A setext heading that is only an underlined display formula, with its underline. */
  const underlinedFormula = (heading: Element): [Element, string] | undefined => {
    const content = heading.children.filter((child) => !isBlank(child));
    const only = content.length === 1 ? content[0] : undefined;
    const id = only?.type === "element" ? only.properties.id : undefined;
    const code = typeof id === "string" ? placed.get(id.replace(/^user-content-/, "")) : undefined;
    const underline = code ? formulas.get(code)?.underline : undefined;
    return code && underline ? [code, underline] : undefined;
  };

  const visit = (node: Root | Element, mathAllowed: boolean) => {
    const parentTag = node.type === "root" ? "div" : node.tagName;
    const children = node.children as ElementContent[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type !== "element" || displays.has(child)) continue;
      const id = child.properties.id;
      const code =
        typeof id === "string" ? placed.get(id.replace(/^user-content-/, "")) : undefined;
      if (code) {
        children[index] = mathElement(code, parentTag, mathAllowed);
        continue;
      }
      const underlined = /^h[12]$/.test(child.tagName) ? underlinedFormula(child) : undefined;
      if (underlined && mathAllowed && !options.preview && BLOCK_PARENTS.has(parentTag)) {
        // A one-line display formula stays a block; its underline is a rule or a paragraph.
        const [code, underline] = underlined;
        const after: Element = underline.startsWith("-")
          ? { type: "element", tagName: "hr", properties: {}, children: [] }
          : { type: "element", tagName: "p", properties: {}, children: [text(underline)] };
        children.splice(index, 1, mathElement(code, "div", true), text("\n"), after);
        index += 2;
        continue;
      }
      if (child.tagName === "img") keepAltSource(child);
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
}

function findImage(node: Root | Element): Element | undefined {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const image = child.tagName === "img" ? child : findImage(child);
    if (image) return image;
  }
  return undefined;
}

/**
 * A `math` fence Words did not read as math, such as an unclosed one, stays code. Words wrote it
 * (it has a position); raw HTML that asks for math keeps it.
 */
function downgradeUnreadMathFence(node: Element) {
  if (node.tagName !== "pre" || !node.position) return;
  const code = node.children.find((child): child is Element => child.type === "element");
  const className = code?.properties.className;
  if (code && Array.isArray(className) && className.includes(MATH_CODE_CLASS_NAME)) {
    code.properties.className = className.filter((name) => name !== MATH_CODE_CLASS_NAME);
  }
}

const isBlank = (node: ElementContent | undefined) =>
  node !== undefined &&
  ((node.type === "text" && node.value.trim() === "") ||
    (node.type === "element" && node.tagName === "br"));

/** The paragraph's own prose around a display formula. */
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
