/** One exact replacement of a range of a document's source. */
export interface DocumentSourcePatch {
  /** Inclusive UTF-16 source offset, as used by String#slice. Never a byte offset. */
  readonly start: number;
  /** Exclusive UTF-16 source offset. Equal to `start` for an insertion. */
  readonly end: number;
  readonly replacement: string;
  /**
   * The text the planner saw in `[start, end)`. When given, the patch applies
   * only if the source still holds exactly that text there. This guards the
   * contents of the range; it cannot tell that the text around an insertion
   * moved. Whether the whole source is still the one the plan was made on is
   * the edit's `basedOnVersion`.
   */
  readonly expected?: string;
}

/** Why a set of patches was refused. The source is never partly patched. */
export type DocumentSourcePatchProblem =
  | "offset"
  | "bounds"
  | "overlap"
  | "surrogate"
  | "crlf"
  | "stale";

export class DocumentSourcePatchError extends Error {
  readonly problem: DocumentSourcePatchProblem;
  constructor(problem: DocumentSourcePatchProblem, message: string) {
    super(message);
    this.name = "DocumentSourcePatchError";
    this.problem = problem;
  }
}

function assertSafeBoundary(source: string, offset: number): void {
  if (offset <= 0 || offset >= source.length) return;
  const previous = source.charCodeAt(offset - 1);
  const current = source.charCodeAt(offset);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  if (splitsSurrogatePair) {
    throw new DocumentSourcePatchError(
      "surrogate",
      `Source patch boundary ${offset} splits a Unicode surrogate pair.`,
    );
  }
  if (source[offset - 1] === "\r" && source[offset] === "\n") {
    throw new DocumentSourcePatchError(
      "crlf",
      `Source patch boundary ${offset} splits a CRLF line ending.`,
    );
  }
}

/** Validate and order a plan without allocating a replacement document. */
export function validateDocumentSourcePatches(
  source: string,
  patches: ReadonlyArray<DocumentSourcePatch>,
): ReadonlyArray<DocumentSourcePatch> {
  const ordered = patches.toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let previousEnd = 0;
  for (const [index, patch] of ordered.entries()) {
    if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end)) {
      throw new DocumentSourcePatchError("offset", "Source patch offsets must be integers.");
    }
    if (patch.start < 0 || patch.end < patch.start || patch.end > source.length) {
      throw new DocumentSourcePatchError(
        "bounds",
        `Source patch [${patch.start}, ${patch.end}) is outside the source.`,
      );
    }
    if (index > 0 && patch.start < previousEnd) {
      throw new DocumentSourcePatchError("overlap", "Source patches overlap.");
    }
    assertSafeBoundary(source, patch.start);
    assertSafeBoundary(source, patch.end);
    if (patch.expected !== undefined && source.slice(patch.start, patch.end) !== patch.expected) {
      throw new DocumentSourcePatchError(
        "stale",
        `Source patch [${patch.start}, ${patch.end}) was planned against different text.`,
      );
    }
    previousEnd = patch.end;
  }
  return ordered;
}

/**
 * Apply exact source patches, all or none. Callers first constrain the ranges
 * to their source ownership. Equal-offset insertions keep their input order
 * and precede a replacement starting at the same offset.
 */
export function applyDocumentSourcePatches(
  source: string,
  patches: ReadonlyArray<DocumentSourcePatch>,
): string {
  const ordered = validateDocumentSourcePatches(source, patches);

  let cursor = 0;
  let output = "";
  for (const patch of ordered) {
    output += source.slice(cursor, patch.start);
    output += patch.replacement;
    cursor = patch.end;
  }
  return output + source.slice(cursor);
}

/**
 * One planned change to one file, handed from a format's planner to the
 * document's persistence owner. The planner decides which ranges the edit
 * owns; the owner decides whether the plan still fits the working source.
 */
export interface DocumentSourceEdit {
  /**
   * `editVersion` of the working source the patches were planned against. It
   * advances on every local edit and on every adopted or merged outside change,
   * and is meaningful only for the lifetime of the owner that issued it.
   */
  readonly basedOnVersion: number;
  readonly patches: ReadonlyArray<DocumentSourcePatch>;
}

export type DocumentSourceEditOutcome =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      /**
       * `version`: the working source moved since the plan was made.
       * `unavailable`: the owner cannot take edits now (disposed, or held for a rename).
       * Otherwise the patch problem. In every case the working source is unchanged.
       */
      readonly reason: "version" | "unavailable" | DocumentSourcePatchProblem;
    };
