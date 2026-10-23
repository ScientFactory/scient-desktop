import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../markdown/scientMarkdownPipeline";
import { SCIENT_MATH_TABLE_PIPE } from "./remarkScientMath";
import { scientMathMarkdownText, scientMathRemarkPluginsForMessage } from "./scientMathText";

function parse(source: string) {
  const normalized = scientMathMarkdownText(source);
  const processor = unified()
    .use(remarkParse)
    .use(scientMathRemarkPluginsForMessage(CHAT_MARKDOWN_REMARK_PLUGINS, source));
  const tree = processor.parse(normalized);
  processor.runSync(tree, { value: normalized });
  return tree;
}

function formulas(tree: Root) {
  const found: Array<{ value: string; start: number; end: number }> = [];
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "math" || node.type === "inlineMath") {
      found.push({
        value: node.value,
        start: node.position!.start.offset!,
        end: node.position!.end.offset!,
      });
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("Scient math before GFM row splitting", () => {
  it("retains norm bars, exact authored TeX, table columns and UTF-16 offsets", () => {
    const source = [
      "🎉",
      "",
      "| Name | Formula |",
      "| --- | --- |",
      "| Norm | $|x|$ and \\(\\|y\\|\\) |",
      "| Price | $5 and $10 |",
      "",
      "- [ ] Follow-up",
    ].join("\n");
    const normalized = scientMathMarkdownText(source);
    expect(normalized).toHaveLength(source.length);
    expect(normalized.indexOf("[ ]")).toBe(source.indexOf("[ ]"));
    const tree = parse(source);
    const table = tree.children.find((node) => node.type === "table")!;
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2, 2]);
    const math = formulas(tree);
    expect(math.map((node) => node.value)).toEqual(["|x|", "\\|y\\|"]);
    expect(math.map((node) => source.slice(node.start, node.end))).toEqual([
      "$|x|$",
      "\\(\\|y\\|\\)",
    ]);
    expect(JSON.stringify(tree)).not.toContain(SCIENT_MATH_TABLE_PIPE);
  });

  it.each([
    "| a | b |\n| - | - |\n| $5 | $6 |",
    "| a | b |\n| - | - |\n| $x^2 | y$ |",
    "| a | b | c |\n| - | - | - |\n| $x^2 | a | y$ |",
    "| a | b |\n| - | - |\n| \\$literal | $HOME/$USER |",
  ])("does not combine separate cells in %s", (source) => {
    expect(scientMathMarkdownText(source)).toBe(source);
    expect(formulas(parse(source))).toEqual([]);
  });

  it.each([
    "`$|x|$`",
    "```\n$|x|$\n```",
    "before <code>\\(|x|\\)</code> after",
    "before <pre>\\(|x|\\)</pre> after",
    "<!-- \\(|x|\\) -->",
    "<!-- \\(|x|\\)",
    "\\$|x|$",
    "$|unfinished|",
  ])("leaves literal and incomplete input unchanged: %s", (source) => {
    expect(scientMathMarkdownText(source)).toBe(source);
    expect(formulas(parse(source))).toEqual([]);
  });

  it.each([
    '<span title="<code>">\\(x\\)</span>',
    "text <!-- <code> -->\\(x\\)",
    "<code>\\(literal\\)</code> then \\(x\\)",
    '<code title="</code>">\\(literal\\)</code> then \\(x\\)',
  ])("does not let comments or quoted tags change literal ownership: %s", (source) => {
    expect(formulas(parse(source)).map((node) => node.value)).toEqual(["x"]);
  });

  it("keeps unclosed literal regions and over-limit formulas literal", () => {
    expect(formulas(parse("before <code>\\(x\\)"))).toEqual([]);
    expect(formulas(parse(`$|${"x".repeat(301)}|$`))).toEqual([]);
    expect(formulas(parse(`$$|${"x".repeat(1001)}|$$`))).toEqual([]);
  });

  it("does not reinterpret an authored private-use character as a pipe", () => {
    const source = `$x${SCIENT_MATH_TABLE_PIPE}y$ and | text |`;
    expect(scientMathMarkdownText(source)).toBe(source);
    expect(formulas(parse(source))[0]?.value).toBe(`x${SCIENT_MATH_TABLE_PIPE}y`);
  });
});
