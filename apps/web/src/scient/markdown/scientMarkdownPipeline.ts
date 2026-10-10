import rehypeSanitize from "rehype-sanitize";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS as SHARED_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS as SHARED_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS as SHARED_REHYPE_PLUGINS,
  CHAT_MARKDOWN_SANITIZE_SCHEMA,
  rehypePreserveImageSourceMeta,
} from "@t3tools/shared/markdownPipeline";
import { isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";
import { remarkScientMath, remarkScientMathRefinements } from "../math/remarkScientMath";
import { remarkScientSingleDollarMath } from "../math/scientSingleDollarMath";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

/** Carries authored image source metadata through the sanitizer to the image renderer. */
function rehypeScientImageMetadata() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (
      node: MarkdownImageHastNode,
      parent?: MarkdownImageHastNode,
      inTableCell = false,
    ) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
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
export const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  ...SHARED_REHYPE_PLUGINS.slice(0, -1),
  rehypeScientImageMetadata,
  [rehypeSanitize, SCIENT_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
export const CHAT_MARKDOWN_REHYPE_PLUGINS_WITHOUT_RAW = [
  rehypePreserveImageSourceMeta,
  rehypeScientImageMetadata,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
