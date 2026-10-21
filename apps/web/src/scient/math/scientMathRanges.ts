import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../markdown/scientMarkdownPipeline";
import { scientMathMarkdownText, scientMathRemarkPluginsForMessage } from "./scientMathText";

/** Composer shielding uses the renderer's guarded grammar and authored offsets. */
export function scientMathRanges(source: string) {
  const ranges: Array<{ start: number; end: number; source: string }> = [];
  if (!/\$|\\[([]|(?:`{3,}|~{3,})[ \t]*math\b/.test(source)) return ranges;
  const normalized = scientMathMarkdownText(source);
  const processor = unified()
    .use(remarkParse)
    .use(scientMathRemarkPluginsForMessage(CHAT_MARKDOWN_REMARK_PLUGINS, source));
  const tree = processor.parse(normalized);
  processor.runSync(tree, { value: normalized });
  const visit = (node: Root | Root["children"][number]) => {
    if (
      node.type === "inlineMath" ||
      node.type === "math" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        ranges.push({ start, end, source: source.slice(start, end) });
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return ranges;
}
