import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { GUIDED_ENVIRONMENT, guidanceText } from "./latexGuidanceText";
import type { LatexVisualDocument } from "./latexVisualDocument";
import "./latexGuidance.css";

export { guidanceText } from "./latexGuidanceText";

/**
 * The guidance a template leaves for each empty place, by block index: a
 * `% Guide:` comment directly above an empty paragraph (`\par`), or alone
 * inside an environment such as the abstract or a problem. Visual shows it
 * faintly until the place is written in; as a comment, it is never printed.
 */
export function latexGuidance(
  projection: Pick<LatexVisualDocument, "source" | "blocks">,
): ReadonlyMap<number, string> {
  const { source, blocks } = projection;
  const opening = /\\begin\s*\{document\}/u.exec(source);
  const bodyStart = opening ? opening.index + opening[0].length : 0;
  const guidance = new Map<number, string>();
  blocks.forEach((block, index) => {
    const text = source.slice(block.from, block.to).trim();
    if (block.node.type === "paragraph" && text === "\\par") {
      const gapFrom = Math.max(index > 0 ? blocks[index - 1]!.to : bodyStart, bodyStart);
      const found = guidanceText(source.slice(gapFrom, block.from));
      if (found) guidance.set(index, found);
      return;
    }
    const environment = GUIDED_ENVIRONMENT.exec(text);
    const found = environment ? guidanceText(environment[2]!) : null;
    if (found) guidance.set(index, found);
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

const latexGuidanceKey = new PluginKey("scientLatexGuidance");

/** Whether an editor already runs this version of the guidance plugin. */
export function hasLatexGuidance(state: EditorState): boolean {
  return state.plugins.some((plugin) => plugin.spec.key === latexGuidanceKey);
}

/**
 * Shows a template's guidance in the empty places it was left for. Draws only.
 * Places are matched by position, block for block: the editor keeps a node's
 * first identity across edits, so identities cannot be relied on. While the
 * page and its source disagree on their blocks (a structural edit not yet
 * applied), nothing is drawn.
 */
export function latexGuidancePlaceholders(projection: () => LatexVisualDocument | null) {
  let drawn: {
    readonly doc: ProseMirrorNode;
    readonly projection: LatexVisualDocument;
    readonly decorations: DecorationSet | null;
  } | null = null;
  return new Plugin({
    key: latexGuidanceKey,
    props: {
      decorations(state) {
        const current = projection();
        if (!current) return null;
        if (drawn?.doc === state.doc && drawn.projection === current) return drawn.decorations;
        const guidance = latexGuidance(current);
        const decorations: Decoration[] = [];
        if (guidance.size > 0 && state.doc.childCount === current.blocks.length)
          state.doc.forEach((node, offset, index) => {
            const text = guidance.get(index);
            if (text === undefined || node.type.name !== current.blocks[index]!.node.type) return;
            const place = emptyParagraph(node, offset);
            if (place)
              decorations.push(
                Decoration.node(place.position, place.position + place.node.nodeSize, {
                  class: "scient-latex-guidance",
                  "data-guidance": text,
                }),
              );
          });
        const set = decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
        drawn = { doc: state.doc, projection: current, decorations: set };
        return set;
      },
    },
  });
}
