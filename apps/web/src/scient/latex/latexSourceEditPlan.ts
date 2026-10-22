import {
  validateDocumentSourcePatches,
  type DocumentSourcePatch,
} from "@scientfactory/scient-document";

/** Boundary inserts name the side they own; synthetic project text has no owner. */
export interface LatexOwnedSourcePatch extends DocumentSourcePatch {
  readonly insertionAffinity?: "before" | "after";
}

/** Original-coordinate edits produced by the format adapter, before physical-file routing. */
export interface LatexSourceEdit {
  readonly source: string;
  readonly patches: readonly LatexOwnedSourcePatch[];
  readonly root?: {
    readonly source: string;
    readonly patches: readonly DocumentSourcePatch[];
  };
  /** Session-history inverses already know their physical owner; never remap by appearance. */
  readonly physical?: readonly {
    readonly path: string;
    readonly documentId: string;
    readonly source: string;
    readonly patches: readonly DocumentSourcePatch[];
  }[];
}

/** A disposable rendering snapshot, freshly bound to the mounted source owners. */
export interface LatexEditorSourceSnapshot {
  readonly id: string;
  readonly source: string;
  readonly setupSource: string;
  readonly rootSource?: string | null;
}

export interface LatexVisualEditRequest {
  readonly snapshot: LatexEditorSourceSnapshot;
  readonly edit: LatexSourceEdit;
}

export type LatexVisualEditOutcome =
  | {
      readonly accepted: true;
      readonly snapshot: LatexEditorSourceSnapshot;
      readonly inverseEdit: LatexSourceEdit;
    }
  | { readonly accepted: false; readonly reason: string };
let nextSnapshot = 0;

export function createLatexEditorSourceSnapshot(
  source: string,
  rootSource?: string | null,
  setupSource = rootSource ?? source,
): LatexEditorSourceSnapshot {
  return {
    id: `latex-source-${++nextSnapshot}`,
    source,
    setupSource,
    ...(rootSource === undefined ? {} : { rootSource }),
  };
}

function safeBoundary(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return true;
  const before = source.charCodeAt(offset - 1);
  const after = source.charCodeAt(offset);
  return !(
    (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) ||
    (before === 13 && after === 10)
  );
}

/** Minimize a replacement only inside a range the producer already owns. Never infer its file. */
export function latexOwnedSourcePatch(
  source: string,
  from: number,
  to: number,
  replacement: string,
  insertionAffinity?: LatexOwnedSourcePatch["insertionAffinity"],
): LatexOwnedSourcePatch | null {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > source.length
  )
    throw new RangeError("Invalid owned LaTeX source range");
  const original = source.slice(from, to);
  if (original === replacement) return null;
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < replacement.length &&
    original[prefix] === replacement[prefix]
  )
    prefix += 1;
  while (prefix > 0 && (!safeBoundary(original, prefix) || !safeBoundary(replacement, prefix)))
    prefix -= 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - suffix - 1] === replacement[replacement.length - suffix - 1]
  )
    suffix += 1;
  while (
    suffix > 0 &&
    (!safeBoundary(original, original.length - suffix) ||
      !safeBoundary(replacement, replacement.length - suffix))
  )
    suffix -= 1;
  const start = from + prefix;
  const end = to - suffix;
  const affinity =
    insertionAffinity ?? (from === to ? undefined : start === from ? "after" : "before");
  return {
    start,
    end,
    expected: original.slice(prefix, original.length - suffix),
    replacement: replacement.slice(prefix, replacement.length - suffix),
    ...(start === end && affinity ? { insertionAffinity: affinity } : {}),
  };
}

/** Exact native inverse in the post-edit coordinate space, including equal-offset insertions. */
export function invertLatexSourcePatches(
  source: string,
  patches: readonly DocumentSourcePatch[],
): readonly LatexOwnedSourcePatch[] {
  let delta = 0;
  return validateDocumentSourcePatches(source, patches).map((patch) => {
    const start = patch.start + delta;
    delta += patch.replacement.length - (patch.end - patch.start);
    return {
      start,
      end: start + patch.replacement.length,
      expected: patch.replacement,
      replacement: source.slice(patch.start, patch.end),
      ...(patch.replacement.length === 0
        ? { insertionAffinity: start === 0 ? ("after" as const) : ("before" as const) }
        : {}),
    };
  });
}
