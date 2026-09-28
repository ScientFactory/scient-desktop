import { MARKDOWN_FRONT_MATTER_EXTENSIONS } from "@scientfactory/scient-markdown";

interface UnifiedProcessorLike {
  data(): unknown;
}

interface MarkdownTree {
  children: Array<{ readonly type: string }>;
}

/**
 * Parses a leading YAML (`---`) or TOML (`+++`) block as front matter, the
 * way the rich editor and the export's server-side inspection do, and drops
 * it from the tree so it never prints. Its `title`, if any, already titles
 * the capture. Must come before the shared grammar plugins.
 */
export function remarkDocumentFrontMatter(this: UnifiedProcessorLike) {
  // remark-parse reads these lists from the processor's data; the unified
  // `Data` shape is module-augmented, so it is widened here.
  // oxlint-disable-next-line oxc/no-this-in-exported-function -- unified invokes plugins with the processor bound as `this`; that is the plugin contract.
  const data = this.data() as {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
  (data.micromarkExtensions ??= []).push(MARKDOWN_FRONT_MATTER_EXTENSIONS.syntax);
  (data.fromMarkdownExtensions ??= []).push(MARKDOWN_FRONT_MATTER_EXTENSIONS.fromMarkdown);
  return (tree: MarkdownTree) => {
    tree.children = tree.children.filter((node) => node.type !== "yaml" && node.type !== "toml");
  };
}
