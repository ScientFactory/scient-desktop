import type { JSONContent } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { isSupportedLatexInlineCommand, serializeLatexVisualBlock } from "./latexVisualDocument";

export function latexSelectionClipboard(content: Slice): string {
  const fallback = () => content.content.textBetween(0, content.content.size, "\n\n");
  let containsStructuredContent = false;
  content.content.forEach((node) => {
    if (node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
      containsStructuredContent = true;
    if (
      node.type.name === "latexInlineCommand" &&
      isSupportedLatexInlineCommand(String(node.attrs.name ?? ""))
    )
      containsStructuredContent = true;
    if (node.type.name === "latexRichPreview" && node.attrs.kind === "table")
      containsStructuredContent = true;
    node.descendants((child) => {
      if (child.type.name === "latexInlineMath" || child.type.name === "latexDisplayMath")
        containsStructuredContent = true;
      if (
        child.type.name === "latexInlineCommand" &&
        isSupportedLatexInlineCommand(String(child.attrs.name ?? ""))
      )
        containsStructuredContent = true;
      if (child.type.name === "latexRichPreview" && child.attrs.kind === "table")
        containsStructuredContent = true;
    });
  });
  if (!containsStructuredContent) return fallback();
  const blocks: string[] = [];
  let inline: JSONContent[] = [];
  const flushInline = () => {
    if (!inline.length) return true;
    const serialized = serializeLatexVisualBlock({ type: "paragraph", content: inline });
    inline = [];
    if (serialized === null) return false;
    blocks.push(serialized);
    return true;
  };
  let supported = true;
  content.content.forEach((node) => {
    if (!supported) return;
    if (node.isInline) {
      inline.push(node.toJSON());
      return;
    }
    if (!flushInline()) {
      supported = false;
      return;
    }
    const serialized = serializeLatexVisualBlock(node.toJSON());
    if (serialized === null) supported = false;
    else blocks.push(serialized);
  });
  if (!supported || !flushInline()) return fallback();
  return blocks.join("\n\n");
}
