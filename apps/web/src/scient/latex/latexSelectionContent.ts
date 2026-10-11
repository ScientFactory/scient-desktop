import type { Node } from "@tiptap/pm/model";
import { serializeLatexVisualBlock, latexVisualMathSource } from "./latexVisualDocument";

/** Read the model, never the painted DOM: math, images and raw atoms stay meaningful. */
export function latexSelectedDocumentText(doc: Node, from: number, to: number): string {
  return doc.textBetween(from, to, "\n", (node) => {
    if (node.type.name === "hardBreak") return "\n";
    if (node.type.name === "latexInlineMath")
      return latexVisualMathSource({ ...node.attrs, tex: String(node.attrs.tex ?? "") }, false);
    return (
      serializeLatexVisualBlock(node.toJSON()) ?? String(node.attrs.raw ?? node.attrs.source ?? "")
    );
  });
}
