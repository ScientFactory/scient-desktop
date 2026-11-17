import type { EditorState, Transaction } from "prosemirror-state";

import { scientMarkdownSchema } from "./schema";

export interface LibraryCitationQuery {
  /** Where `[@` starts. */
  readonly from: number;
  /** The caret, plus a `]` right after it that the citation replaces. */
  readonly to: number;
  readonly query: string;
}

const OPEN_CITATION = /\[@([\p{L}\p{N}_:.#-]*)$/u;

/** What the writer typed after `[@`, when the caret is still inside it. */
export function libraryCitationQuery(state: EditorState): LibraryCitationQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.spec.code)) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\0", "\0");
  const match = OPEN_CITATION.exec(before);
  if (!match) return null;
  const after = $from.parent.textBetween(
    $from.parentOffset,
    Math.min($from.parent.content.size, $from.parentOffset + 1),
    "\0",
    "\0",
  );
  return {
    from: $from.pos - match[0].length,
    to: $from.pos + (after === "]" ? 1 : 0),
    query: match[1] ?? "",
  };
}

/** Replaces the typed `[@query` with one citation node for `key`. */
export function insertLibraryCitation(
  state: EditorState,
  query: LibraryCitationQuery,
  key: string,
): Transaction | null {
  const citation = scientMarkdownSchema.nodes.citation;
  if (!citation) return null;
  return state.tr.replaceWith(query.from, query.to, citation.create({ source: `@${key}` }));
}
