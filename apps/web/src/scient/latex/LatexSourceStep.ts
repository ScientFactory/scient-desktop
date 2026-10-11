import { Slice, type Node } from "@tiptap/pm/model";
import { ReplaceStep, StepMap, type Mappable } from "@tiptap/pm/transform";
import {
  applyDocumentSourcePatches,
  validateDocumentSourcePatches,
} from "@scientfactory/scient-document";
import type { LatexSourceEdit, LatexOwnedSourcePatch } from "./latexSourceEditPlan";

/** Session-only source facts attached to the editor's existing document history. */
export interface LatexSourceHistory {
  edit: LatexSourceEdit | null;
  inverse: LatexSourceEdit | null;
}

/** Compose only the explicitly touched ranges, never a before/after string diff. */
function composePatches(
  source: string,
  operations: readonly { source: string; patches: readonly LatexOwnedSourcePatch[] }[],
): LatexOwnedSourcePatch[] | null {
  type TextPiece = {
    text: string;
    insertionAffinity?: "before" | "after";
    insertionOffset?: number;
  };
  type Piece = { start: number; end: number } | TextPiece;
  let pieces: Piece[] = [{ start: 0, end: source.length }];
  let current = source;
  for (const operation of operations) {
    if (operation.source !== current) return null;
    let patches: readonly LatexOwnedSourcePatch[];
    try {
      patches = validateDocumentSourcePatches(current, operation.patches);
    } catch {
      return null;
    }
    for (let index = patches.length - 1; index >= 0; index--) {
      const patch = patches[index]!;
      const insertedPiece: TextPiece = {
        text: patch.replacement,
        ...(patch.insertionAffinity ? { insertionAffinity: patch.insertionAffinity } : {}),
      };
      // Keep an insertion's native coordinate even when adjacent bytes disappear.
      // Its side must still reach the physical planner independently.
      if (patch.start === patch.end) {
        let offset = 0;
        let before: number | undefined;
        let after: number | undefined;
        let inside: number | undefined;
        let insertedAnchor: number | undefined;
        for (const piece of pieces) {
          const length = "text" in piece ? piece.text.length : piece.end - piece.start;
          const end = offset + length;
          if ("text" in piece) {
            if (offset <= patch.start && patch.start <= end)
              insertedAnchor ??= piece.insertionOffset;
          } else {
            if (offset < patch.start && patch.start < end)
              inside = piece.start + patch.start - offset;
            if (end === patch.start) before = piece.end;
            if (offset === patch.start) after ??= piece.start;
          }
          offset = end;
        }
        const boundary =
          patch.insertionAffinity === "after" ? (after ?? before) : (before ?? after);
        const anchor =
          inside ??
          (patch.insertionAffinity ? (boundary ?? insertedAnchor) : (insertedAnchor ?? boundary));
        if (
          !patch.insertionAffinity &&
          inside === undefined &&
          insertedAnchor === undefined &&
          before !== undefined &&
          after !== undefined &&
          before !== after
        )
          return null;
        if (patch.insertionAffinity && anchor === undefined) return null;
        if (anchor !== undefined) insertedPiece.insertionOffset = anchor;
      }
      const kept: Piece[] = [];
      let offset = 0;
      let inserted = false;
      for (const piece of pieces) {
        const length = "text" in piece ? piece.text.length : piece.end - piece.start;
        const end = offset + length;
        if (
          "text" in piece &&
          patch.start >= offset &&
          patch.end <= end &&
          !insertedPiece.insertionAffinity &&
          piece.insertionAffinity
        )
          insertedPiece.insertionAffinity = piece.insertionAffinity;
        if (
          "text" in piece &&
          patch.start >= offset &&
          patch.end <= end &&
          piece.insertionOffset !== undefined &&
          (!patch.insertionAffinity || patch.insertionAffinity === piece.insertionAffinity)
        )
          insertedPiece.insertionOffset = piece.insertionOffset;
        if (end <= patch.start || offset >= patch.end) {
          if (!inserted && offset >= patch.end) {
            kept.push(insertedPiece);
            inserted = true;
          }
          kept.push(piece);
        } else {
          const left = Math.max(0, patch.start - offset);
          const right = Math.max(0, end - patch.end);
          if (left)
            kept.push(
              "text" in piece
                ? { ...piece, text: piece.text.slice(0, left) }
                : { start: piece.start, end: piece.start + left },
            );
          if (!inserted) {
            kept.push(insertedPiece);
            inserted = true;
          }
          if (right)
            kept.push(
              "text" in piece
                ? { ...piece, text: piece.text.slice(length - right) }
                : { start: piece.end - right, end: piece.end },
            );
        }
        offset = end;
      }
      if (!inserted) kept.push(insertedPiece);
      pieces = kept;
      current = current.slice(0, patch.start) + patch.replacement + current.slice(patch.end);
    }
  }
  const patches: LatexOwnedSourcePatch[] = [];
  let start = 0;
  let inserted: TextPiece[] = [];
  for (const piece of [...pieces, { start: source.length, end: source.length }]) {
    if ("text" in piece) {
      if (!piece.text) continue;
      const previous = inserted.at(-1);
      if (
        previous &&
        previous.insertionAffinity === piece.insertionAffinity &&
        previous.insertionOffset === piece.insertionOffset
      )
        previous.text += piece.text;
      else inserted.push({ ...piece });
    } else {
      const replacement = inserted.filter((text) => text.insertionOffset === undefined);
      if (piece.start !== start) {
        patches.push({
          start,
          end: piece.start,
          expected: source.slice(start, piece.start),
          replacement: replacement.map((text) => text.text).join(""),
        });
      }
      for (const text of inserted) {
        if (piece.start !== start && text.insertionOffset === undefined) continue;
        const offset = text.insertionOffset ?? start;
        patches.push({
          start: offset,
          end: offset,
          expected: "",
          replacement: text.text,
          ...(text.insertionAffinity ? { insertionAffinity: text.insertionAffinity } : {}),
        });
      }
      start = piece.end;
      inserted = [];
    }
  }
  const result = patches.filter((patch) => patch.expected !== patch.replacement);
  try {
    // If an insertion now lies inside a removed native range, refuse rather than
    // silently folding its independent ownership into that replacement.
    return applyDocumentSourcePatches(source, result) === current ? result : null;
  } catch {
    return null;
  }
}

export function composeLatexSourceEdits(
  source: string,
  edits: readonly LatexSourceEdit[],
): LatexSourceEdit | null {
  if (!edits.length || edits[0]!.source !== source) return null;
  const physical = edits.flatMap((edit) => edit.physical ?? []);
  if (physical.length) {
    if (edits.some((edit) => edit.patches.length || edit.root?.patches.length)) return null;
    // Paths may change inside a chain; the one live document owner may not.
    const first = physical[0]!;
    if (physical.some((edit) => edit.documentId !== first.documentId)) return null;
    const patches = composePatches(first.source, physical);
    if (!patches) return null;
    return {
      source,
      patches: [],
      physical: [{ ...first, path: physical.at(-1)!.path, patches }],
    };
  }
  const patches = composePatches(source, edits);
  if (!patches) return null;
  const roots = edits.flatMap((edit) => (edit.root ? [edit.root] : []));
  const rootPatches = roots.length ? composePatches(roots[0]!.source, roots) : [];
  if (!rootPatches) return null;
  return {
    source,
    patches,
    ...(roots.length ? { root: { source: roots[0]!.source, patches: rootPatches } } : {}),
  };
}

/** A replacement, or a source-only annotation, whose inverse restores native bytes. */
export class LatexSourceStep extends ReplaceStep {
  constructor(
    from: number,
    to: number,
    slice: Slice,
    readonly history: LatexSourceHistory,
    readonly reversed = false,
  ) {
    super(from, to, slice);
  }
  get edit(): LatexSourceEdit | null {
    return this.reversed ? this.history.inverse : this.history.edit;
  }
  override getMap(): StepMap {
    return this.from === this.to && this.slice.size === 0 ? StepMap.empty : super.getMap();
  }
  override invert(doc: Node): LatexSourceStep {
    const inverse = super.invert(doc);
    return new LatexSourceStep(
      inverse.from,
      inverse.to,
      inverse.slice,
      this.history,
      !this.reversed,
    );
  }
  override map(mapping: Mappable): LatexSourceStep | null {
    if (this.from === this.to && this.slice.size === 0)
      return new LatexSourceStep(0, 0, Slice.empty, this.history, this.reversed);
    const mapped = super.map(mapping);
    return mapped
      ? new LatexSourceStep(mapped.from, mapped.to, mapped.slice, this.history, this.reversed)
      : null;
  }
  override merge(): null {
    return null;
  }
}
