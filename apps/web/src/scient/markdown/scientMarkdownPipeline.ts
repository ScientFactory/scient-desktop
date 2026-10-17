import rehypeSanitize from "rehype-sanitize";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS as SHARED_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS as SHARED_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS as SHARED_REHYPE_PLUGINS,
  CHAT_MARKDOWN_SANITIZE_SCHEMA,
  rehypePreserveImageSourceMeta,
} from "@t3tools/shared/markdownPipeline";
import { remarkScientMath, remarkScientMathRefinements } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

/**
 * Marks a standalone figure for Scient's image card. Runs after the shared
 * `rehypePreserveImageSourceMeta`, which already carries the authored source
 * and title through the sanitizer.
 */
function rehypeScientImageMetadata() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (
      node: MarkdownImageHastNode,
      parent?: MarkdownImageHastNode,
      inTableCell = false,
    ) => {
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          // Keep Scient's actions for standalone figures, not authored inline layouts.
          dataScientImageCard:
            !inTableCell &&
            parent?.tagName === "p" &&
            !parent.properties?.align &&
            !node.properties?.width &&
            !node.properties?.height &&
            parent.children?.every(
              (child) => child === node || (child.type === "text" && !child.value?.trim()),
            ),
        };
      }
      node.children?.forEach((child) =>
        visit(child, node, inTableCell || node.tagName === "td" || node.tagName === "th"),
      );
    };

    visit(tree);
  };
}

const SCIENT_SANITIZE_SCHEMA = {
  ...CHAT_MARKDOWN_SANITIZE_SCHEMA,
  attributes: {
    ...CHAT_MARKDOWN_SANITIZE_SCHEMA.attributes,
    img: [...CHAT_MARKDOWN_SANITIZE_SCHEMA.attributes.img, "dataScientImageCard"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

function withScientMath(plugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>) {
  return [
    ...plugins.slice(0, 1),
    remarkScientMath,
    remarkScientSingleDollarMath,
    remarkScientMathRefinements,
    ...plugins.slice(1),
  ];
}

export const CHAT_MARKDOWN_REMARK_PLUGINS = withScientMath(SHARED_REMARK_PLUGINS);
export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = withScientMath(
  SHARED_REMARK_PLUGINS_WITH_BREAKS,
);
// Scient's sanitizer replaces the shared one in place, found by its schema rather than by position,
// so a plugin upstream adds after sanitization stays after it.
export const CHAT_MARKDOWN_REHYPE_PLUGINS = SHARED_REHYPE_PLUGINS.flatMap((plugin) =>
  Array.isArray(plugin) && plugin[1] === CHAT_MARKDOWN_SANITIZE_SCHEMA
    ? [rehypeScientImageMetadata, [rehypeSanitize, SCIENT_SANITIZE_SCHEMA]]
    : [plugin],
) satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
export const CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW = [
  rehypePreserveImageSourceMeta,
  rehypeScientImageMetadata,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
