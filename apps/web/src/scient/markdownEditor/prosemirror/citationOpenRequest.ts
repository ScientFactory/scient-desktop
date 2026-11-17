import type { Node as ProseMirrorNode } from "prosemirror-model";

import { scientMarkdownSchema } from "./schema";

/** A clicked citation, as the document's host opens it. */
export interface ScientMarkdownCitationOpenRequest {
  /** The text between the citation's brackets, e.g. `@a, p. 4; @b`. */
  readonly source: string;
  /** The quoted passage the citation closes, as "Quote in my document" writes it; else null. */
  readonly quote: string | null;
  readonly at: { readonly x: number; readonly y: number };
}

/**
 * The open request for the citation at `position`; null when no citation is there. A citation
 * closing a paragraph of a block quote closes that quote: its text before the citation is the
 * passage.
 */
export function citationOpenRequest(
  doc: ProseMirrorNode,
  position: number,
  at: ScientMarkdownCitationOpenRequest["at"],
): ScientMarkdownCitationOpenRequest | null {
  const node = doc.nodeAt(position);
  if (!node || node.type !== scientMarkdownSchema.nodes.citation) return null;
  const $position = doc.resolve(position);
  const end = position + node.nodeSize;
  const closes =
    $position.parent.type === scientMarkdownSchema.nodes.paragraph &&
    $position.depth > 0 &&
    $position.node($position.depth - 1).type === scientMarkdownSchema.nodes.blockquote &&
    doc.textBetween(end, $position.end(), " ", "\uFFFC").trim() === "";
  const quote = closes ? doc.textBetween($position.start(), position, " ", " ").trim() : "";
  return { source: String(node.attrs.source), quote: quote === "" ? null : quote, at };
}
