import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { LatexVisualDocument } from "./latexVisualDocument";
import "./latexGuidance.css";

/** The text of comment lines, joined; null if the source holds anything else. */
export function guidanceText(source: string): string | null {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || !lines.every((line) => line.startsWith("%"))) return null;
  const text = lines
    .map((line) => line.replace(/^%+\s?/u, "").trim())
    .filter(Boolean)
    .join(" ");
  return text || null;
}

/**
 * The guidance a template leaves for an empty place, by block: comment lines
 * directly above an empty paragraph (`\par`), or alone inside an environment
 * such as the abstract or a problem. Visual shows it faintly until the place is
 * written in; it is a comment, so it is never printed.
 */
export function latexGuidance(
  projection: Pick<LatexVisualDocument, "source" | "blocks">,
): ReadonlyMap<string, string> {
  const { source, blocks } = projection;
  const opening = /\\begin\s*\{document\}/u.exec(source);
  const bodyStart = opening ? opening.index + opening[0].length : 0;
  const guidance = new Map<string, string>();
  blocks.forEach((block, index) => {
    const text = source.slice(block.from, block.to).trim();
    if (block.node.type === "paragraph" && text === "\\par") {
      const gapFrom = Math.max(index > 0 ? blocks[index - 1]!.to : bodyStart, bodyStart);
      const found = guidanceText(source.slice(gapFrom, block.from));
      if (found) guidance.set(block.id, found);
      return;
    }
    const environment =
      /^\\begin\s*\{([A-Za-z]+\*?)\}(?:\[[^\]]*\])?([\s\S]*)\\end\s*\{\1\}$/u.exec(text);
    const found = environment ? guidanceText(environment[2]!) : null;
    if (found) guidance.set(block.id, found);
  });
  return guidance;
}

/** The empty paragraph a block offers for writing: itself, or an environment's only paragraph. */
function emptyParagraph(
  node: ProseMirrorNode,
  position: number,
): { readonly node: ProseMirrorNode; readonly position: number } | null {
  if (node.type.name === "paragraph") return node.childCount === 0 ? { node, position } : null;
  const only = node.childCount === 1 ? node.firstChild : null;
  return only?.type.name === "paragraph" && only.childCount === 0
    ? { node: only, position: position + 1 }
    : null;
}

const key = new PluginKey("scientLatexGuidance");

/** Shows a template's guidance in the empty places it was left for. Draws only. */
export function latexGuidancePlaceholders(projection: () => LatexVisualDocument | null) {
  let read: { projection: LatexVisualDocument; guidance: ReadonlyMap<string, string> } | null =
    null;
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const current = projection();
        if (!current) return null;
        if (read?.projection !== current)
          read = { projection: current, guidance: latexGuidance(current) };
        const { guidance } = read;
        if (guidance.size === 0) return null;
        const decorations: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          const sourceId: unknown = node.attrs.sourceId;
          const text = typeof sourceId === "string" ? guidance.get(sourceId) : undefined;
          const place = text === undefined ? null : emptyParagraph(node, offset);
          if (place && text !== undefined)
            decorations.push(
              Decoration.node(place.position, place.position + place.node.nodeSize, {
                class: "scient-latex-guidance",
                "data-guidance": text,
              }),
            );
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
