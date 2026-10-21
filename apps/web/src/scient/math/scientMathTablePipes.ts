import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  remarkScientMath,
  remarkScientMathRefinements,
  SCIENT_MATH_TABLE_PIPE,
} from "./remarkScientMath";
import { remarkScientSingleDollarMath } from "./scientSingleDollarMath";

/**
 * GFM splits rows before inline tokenization. Shield paired TeX bars with one
 * character each, then let the refinement restore them from authored offsets.
 * The preliminary parse uses the same guarded grammar, without GFM's row split.
 */
export function protectScientMathTablePipes(source: string, authored: string): string {
  if (!source.includes("|") || !source.includes("$") || source.includes(SCIENT_MATH_TABLE_PIPE)) {
    return source;
  }
  const processor = unified()
    .use(remarkParse)
    .use([remarkScientMath])
    .use(remarkScientSingleDollarMath)
    .use([[remarkScientMathRefinements, { sourceText: authored }]]);
  const tree = processor.parse(source);
  processor.runSync(tree, { value: source });
  const positions: number[] = [];
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "math" || node.type === "inlineMath") {
      // Spaced cell separators are not paired TeX bars.
      if (!/^\|[^|\n]+\|$/.test(node.value) && !/\|[^\s|](?:[^|\n]*[^\s|])?\|/.test(node.value))
        return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (let index = start; index < end; index++) {
        if (source[index] === "|") positions.push(index);
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  if (positions.length === 0) return source;
  const characters = source.split("");
  for (const position of positions) characters[position] = SCIENT_MATH_TABLE_PIPE;
  return characters.join("");
}
