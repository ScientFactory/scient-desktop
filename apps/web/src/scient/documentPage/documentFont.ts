import {
  MARKDOWN_FONT_SIZES,
  markdownFontSpanStyle,
  parseMarkdownFontSpanStyle,
} from "@scientfactory/scient-markdown";
import { readMarkdownDocumentFont } from "../markdownEditor/documentFont";
import { isFontFamilyName } from "../writing/fontChoices";

/**
 * Font styles of an exported Markdown document: the local `<span style>` forms
 * Scient writes, and the whole-document front matter keys. Only the exact
 * listed values get through the sanitizer; any other CSS is still removed.
 */

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export const DOCUMENT_FONT_SANITIZE_ATTRIBUTES = {
  span: ["dataScientFontSize", "dataScientFontFamily"],
} as const;

function visitSpans(node: HastNode, visit: (properties: Record<string, unknown>) => void) {
  if (node.type === "element" && node.tagName === "span") visit((node.properties ??= {}));
  node.children?.forEach((child) => visitSpans(child, visit));
}

/** Before the sanitizer: move a recognised style into data attributes it allows. */
export function rehypeMarkFontSpans() {
  return (tree: HastNode) =>
    visitSpans(tree, (properties) => {
      // Only the style may ask for a font; the document's own attributes are not trusted.
      delete properties.dataScientFontSize;
      delete properties.dataScientFontFamily;
      const style = typeof properties.style === "string" ? properties.style.trim() : "";
      const span = parseMarkdownFontSpanStyle(style);
      if (span === null) return;
      if ("size" in span) properties.dataScientFontSize = span.size;
      else properties.dataScientFontFamily = span.family;
    });
}

/** After the sanitizer: turn the surviving data attributes back into the style they stand for. */
export function rehypeApplyFontSpans() {
  return (tree: HastNode) =>
    visitSpans(tree, (properties) => {
      const size = properties.dataScientFontSize;
      const family = properties.dataScientFontFamily;
      delete properties.dataScientFontSize;
      delete properties.dataScientFontFamily;
      const sizeName = MARKDOWN_FONT_SIZES.find(({ name }) => name === size)?.name;
      if (sizeName !== undefined) {
        properties.style = markdownFontSpanStyle({ size: sizeName });
      } else if (typeof family === "string" && isFontFamilyName(family)) {
        properties.style = `font-family:${family}, "Noto Sans Hebrew", "Arial Hebrew", "Noto Sans Arabic"`;
      }
    });
}

/** The leading `---` block of the document, if it starts with one. */
export function documentFontOfMarkdown(markdown: string) {
  const front = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(markdown);
  return readMarkdownDocumentFont(front?.[0] ?? null);
}
