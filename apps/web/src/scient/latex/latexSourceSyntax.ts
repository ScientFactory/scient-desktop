import {
  applyDocumentSourcePatches,
  DocumentSourcePatchError,
  type DocumentSourcePatch,
} from "@scientfactory/scient-document";

import type { LatexSourceRange } from "@scientfactory/scient-document/latex";
export {
  latexSourceArgument,
  latexSourceCommands,
  latexCommentRanges,
  maskLatexSource,
  latexWithoutComments,
  latexCommands,
  latexDocumentBoundary,
  latexPreambleEnd,
  type LatexSourceRange,
  type LatexSourceArgument,
} from "@scientfactory/scient-document/latex";

export function latexSourcePatches(
  source: string,
  patches: readonly (LatexSourceRange & { value: string })[],
): DocumentSourcePatch[] {
  return patches.map(({ from, to, value }) => ({
    start: from,
    end: to,
    replacement: value,
    expected: source.slice(from, to),
  }));
}

export function patchLatexSource(
  source: string,
  patches: readonly (LatexSourceRange & { value: string })[],
): string | null {
  try {
    return applyDocumentSourcePatches(source, latexSourcePatches(source, patches));
  } catch (error) {
    if (error instanceof DocumentSourcePatchError) return null;
    throw error;
  }
}

/** Compose explicit ranges, retaining original coordinates without diffing the combined document. */
export function composeLatexSourcePatches(
  source: string,
  stages: readonly (readonly DocumentSourcePatch[])[],
): DocumentSourcePatch[] {
  type Piece = { text: string; from: number | null };
  let pieces: Piece[] = [{ text: source, from: 0 }];
  let current = source;
  for (const patches of stages) {
    const next = applyDocumentSourcePatches(current, patches);
    for (const patch of patches
      .toSorted((a, b) => a.start - b.start || a.end - b.end)
      .toReversed()) {
      const before: Piece[] = [],
        after: Piece[] = [];
      let offset = 0;
      for (const piece of pieces) {
        const end = offset + piece.text.length;
        if (offset < patch.start) {
          const length = Math.min(piece.text.length, patch.start - offset);
          if (length) before.push({ text: piece.text.slice(0, length), from: piece.from });
        }
        if (end > patch.end) {
          const start = Math.max(0, patch.end - offset);
          after.push({
            text: piece.text.slice(start),
            from: piece.from === null ? null : piece.from + start,
          });
        }
        offset = end;
      }
      pieces = [
        ...before,
        ...(patch.replacement ? [{ text: patch.replacement, from: null }] : []),
        ...after,
      ];
    }
    current = next;
  }
  const result: DocumentSourcePatch[] = [];
  let from = 0,
    replacement = "";
  for (const piece of pieces) {
    if (piece.from === null) replacement += piece.text;
    else {
      if (from !== piece.from || replacement)
        result.push({
          start: from,
          end: piece.from,
          replacement,
          expected: source.slice(from, piece.from),
        });
      replacement = "";
      from = piece.from + piece.text.length;
    }
  }
  if (from !== source.length || replacement)
    result.push({ start: from, end: source.length, replacement, expected: source.slice(from) });
  return result;
}
