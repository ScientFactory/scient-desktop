import type { MarkdownExternalUpdate } from "@scientfactory/scient-markdown";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";

import {
  createScientMarkdownProjection,
  projectScientMarkdownSource,
  type ScientMarkdownProjection,
} from "./projection";
import { withMarkdownSourceId } from "./schema";

function sameContent(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  const attrs = (node: ProseMirrorNode) =>
    Object.fromEntries(
      Object.entries(node.attrs).filter(([key]) => key !== "sourceId" && key !== "sourceCopyId"),
    );
  if (
    a.type !== b.type ||
    a.text !== b.text ||
    a.childCount !== b.childCount ||
    JSON.stringify(attrs(a)) !== JSON.stringify(attrs(b)) ||
    JSON.stringify(a.marks) !== JSON.stringify(b.marks)
  )
    return false;
  for (let i = 0; i < a.childCount; i++) if (!sameContent(a.child(i), b.child(i))) return false;
  return true;
}

/** Prepare before mutating any live state. Unchanged blocks keep their node views and identities. */
export function prepareScientExternalProjection(
  state: EditorState,
  ranges: readonly { readonly from: number; readonly to: number }[],
  update: MarkdownExternalUpdate,
): { state: EditorState; projection: ScientMarkdownProjection } | null {
  if (ranges.length !== state.doc.childCount) return null;
  const next = createScientMarkdownProjection(update.source);
  const patches = [...update.patches].sort((a, b) => a.start - b.start);
  const positions = [0];
  state.doc.forEach((node) => positions.push(positions[positions.length - 1]! + node.nodeSize));
  const indexAt = (offset: number) =>
    offset === update.previousSource.length
      ? ranges.length
      : ranges.findIndex((range) => range.from === offset);
  const nodes = Array.from({ length: next.document.childCount }, (_, index) =>
    next.document.child(index),
  );
  const ledgerBlocks = [...next.ledger.blocks];
  if (nodes.length !== ledgerBlocks.length) return null;
  const reused = new Map<number, number>();
  for (let oldIndex = 0; oldIndex < ranges.length; oldIndex++) {
    const range = ranges[oldIndex]!;
    if (patches.some((patch) => patch.start < range.to && patch.end > range.from)) continue;
    let shift = 0;
    for (const patch of patches)
      if (patch.end <= range.from) shift += patch.replacement.length - (patch.end - patch.start);
    const newIndex = ledgerBlocks.findIndex((block) => block.start === range.from + shift);
    if (newIndex < 0) return null;
    const block = ledgerBlocks[newIndex]!;
    const oldEnd = ranges[oldIndex + 1]?.from ?? update.previousSource.length;
    if (
      update.previousSource.slice(range.from, oldEnd) !==
      update.source.slice(block.start, block.end)
    )
      return null;
    // Exact unchanged source and unchanged document context establish ownership.
    // A fresh parse need not equal the live node: trailing spaces and incomplete
    // Markdown delimiters are legitimate in-progress typing, not external edits.
    reused.set(newIndex, oldIndex);
  }
  for (let index = 0; index < ledgerBlocks.length; index++) {
    const oldIndex = reused.get(index);
    const previous = oldIndex === undefined ? undefined : state.doc.child(oldIndex);
    const id =
      typeof previous?.attrs.sourceId === "string" && previous.attrs.sourceId.length > 0
        ? previous.attrs.sourceId
        : `external-${update.editVersion}-${index}`;
    nodes[index] = withMarkdownSourceId(previous ?? nodes[index]!, id);
    ledgerBlocks[index] = { ...ledgerBlocks[index]!, id };
  }
  const tr = closeHistory(state.tr).setMeta("addToHistory", false);
  const mapped = patches.map((patch, index) => {
    const start = indexAt(patch.start);
    const end = indexAt(patch.end);
    if (start < 0 || end < start) return null;
    const shift = patches
      .slice(0, index)
      .reduce((sum, prior) => sum + prior.replacement.length - (prior.end - prior.start), 0);
    const from = patch.start + shift;
    const to = from + patch.replacement.length;
    const inserted = nodes.filter(
      (_, i) => ledgerBlocks[i]!.start >= from && ledgerBlocks[i]!.end <= to,
    );
    return { start, end, inserted };
  });
  if (mapped.some((patch) => patch === null)) return null;
  for (const patch of mapped.toReversed()) {
    if (patch) tr.replaceWith(positions[patch.start]!, positions[patch.end]!, patch.inserted);
  }
  if (tr.doc.childCount !== nodes.length) return null;
  let position = 0;
  for (let index = 0; index < nodes.length; index++) {
    const actual = tr.doc.child(index);
    if (!sameContent(actual, nodes[index]!)) return null;
    if (actual.attrs.sourceId !== nodes[index]!.attrs.sourceId)
      tr.setNodeAttribute(position, "sourceId", nodes[index]!.attrs.sourceId);
    position += actual.nodeSize;
  }
  const applied = state.applyTransaction(tr).state;
  if (!applied.doc.eq(tr.doc)) return null;
  const projection = {
    ...next,
    ledger: { ...next.ledger, blocks: ledgerBlocks },
    baselineDocument: applied.doc,
    document: applied.doc,
  };
  if (projectScientMarkdownSource(projection, applied.doc).source !== update.source) return null;
  return { state: applied, projection };
}
