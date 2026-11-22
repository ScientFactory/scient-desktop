import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { type PluggableList, type Processor, unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../markdown/scientMarkdownPipeline";
import { scientMathMarkdownText, scientMathRemarkPluginsForMessage } from "./scientMathText";

/** How chat shows a formula Scient's grammar found. */
export type ScientMathKind =
  /** Inline math: `$x$`, `$$x$$` beside prose, `\(x\)`. */
  | "inline"
  /** Display math: own-line `$$`, authored `\[x\]`, a closed `math` fence. */
  | "display"
  /** An unclosed or oversized `$$` block, shown as its literal source in a code block. */
  | "literal";

export interface ScientMathNode {
  readonly kind: ScientMathKind;
  /** The TeX to typeset, or the literal source of a `literal` block. */
  readonly tex: string;
  /** UTF-16 offsets of the whole formula, delimiters included, in the authored source. */
  readonly start: number;
  readonly end: number;
}

const MAY_HOLD_MATH = /\$|\\[([]|(?:`{3,}|~{3,})[ \t]*math\b/;

const processors = new WeakMap<PluggableList, Processor<Root>>();

function processorFor(plugins: PluggableList): Processor<Root> {
  let processor = processors.get(plugins);
  if (!processor) {
    processor = unified().use(remarkParse).use(plugins).freeze() as unknown as Processor<Root>;
    processors.set(plugins, processor);
  }
  return processor;
}

const FENCE_START = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * Whether the parsed node's offsets point at its own source. Blocks a plugin re-parses, such as an
 * over-indented list item's content, carry offsets into that re-parsed text instead.
 */
function locatedAt(
  kind: ScientMathKind,
  tex: string,
  normalized: string,
  source: string,
  start: number,
  end: number,
): boolean {
  if (start < 0 || end > source.length || end <= start) return false;
  const written = normalized.slice(start, end).trim();
  if (kind === "literal") return written.startsWith("$$");
  if (!(written.startsWith("$") && written.endsWith("$")) && !FENCE_START.test(written)) {
    return false;
  }
  const firstLine = tex.trim().split("\n", 1)[0] ?? "";
  return source.slice(start, end).includes(firstLine);
}

/**
 * The formulas chat renders in `source`, as Scient's guarded grammar reads them: single-dollar
 * heuristics, authored `\(…\)`/`\[…\]` intent, table pipes, and unclosed or oversized blocks.
 */
export function scientMathNodes(source: string): ReadonlyArray<ScientMathNode> {
  if (!MAY_HOLD_MATH.test(source)) return [];
  const normalized = scientMathMarkdownText(source);
  const processor = processorFor(
    scientMathRemarkPluginsForMessage(CHAT_MARKDOWN_REMARK_PLUGINS, source),
  );
  const tree = processor.parse(normalized);
  processor.runSync(tree, { value: normalized });
  const nodes: ScientMathNode[] = [];
  const add = (kind: ScientMathKind, tex: string, node: Root["children"][number]) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (!locatedAt(kind, tex, normalized, source, start, end)) return;
    nodes.push({ kind, tex, start, end });
  };
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "inlineMath") add("inline", node.value, node);
    else if (node.type === "math") add("display", node.value, node);
    else if (node.type === "code" && node.lang === "math") add("display", node.value, node);
    else if (node.type === "code" && !node.lang && /^\s*\$\$/.test(node.value)) {
      // remarkScientMathRefinements keeps an unclosed or oversized `$$` block as literal code.
      add("literal", node.value, node);
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  nodes.sort((left, right) => left.start - right.start);
  // Offsets a re-parse produced can overlap real ones; the first formula keeps its place.
  const separate: ScientMathNode[] = [];
  for (const node of nodes) {
    if (node.start >= (separate.at(-1)?.end ?? 0)) separate.push(node);
  }
  return separate;
}

/** Composer shielding uses the renderer's guarded grammar and authored offsets. */
export function scientMathRanges(source: string) {
  return scientMathNodes(source)
    .filter((node) => node.kind !== "literal")
    .map(({ start, end }) => ({ start, end, source: source.slice(start, end) }));
}
