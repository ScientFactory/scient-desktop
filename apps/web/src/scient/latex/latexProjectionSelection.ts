import type { Node } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { latexVisualNodeSignature } from "./latexVisualDocument";

function blocks(doc: Node) {
  const result: { node: Node; from: number; signature: string }[] = [];
  doc.forEach((node, from) =>
    result.push({ node, from, signature: latexVisualNodeSignature(node.toJSON()) }),
  );
  return result;
}

/** Reprojection changes source IDs too; anchor selection to actual content. */
export function latexProjectionSelection(
  before: Node,
  after: Node,
  selection: Selection,
): Selection {
  const oldBlocks = blocks(before);
  const newBlocks = blocks(after);
  const mapping = new Mapping();
  let oldIndex = 0;
  let newIndex = 0;
  let shift = 0;
  const patch = (from: number, oldSize: number, newSize: number) => {
    if (!oldSize && !newSize) return;
    mapping.appendMap(new StepMap([from + shift, oldSize, newSize]));
    shift += newSize - oldSize;
  };
  const replaceUntil = (oldEnd: number, newEnd: number) => {
    const from = oldBlocks[oldIndex]?.from ?? before.content.size;
    const to = oldBlocks[oldEnd]?.from ?? before.content.size;
    const newFrom = newBlocks[newIndex]?.from ?? after.content.size;
    const newTo = newBlocks[newEnd]?.from ?? after.content.size;
    if (oldEnd - oldIndex === 1 && newEnd - newIndex === 1) {
      const oldNode = oldBlocks[oldIndex]!.node;
      const newNode = newBlocks[newIndex]!.node;
      if (oldNode.type === newNode.type && oldNode.isLeaf && oldNode.nodeSize === newNode.nodeSize)
        return;
      if (oldNode.type === newNode.type && !oldNode.isLeaf) {
        const start = oldNode.content.findDiffStart(newNode.content);
        const end = oldNode.content.findDiffEnd(newNode.content);
        if (start !== null && end) {
          const overlap = start - Math.min(end.a, end.b);
          patch(
            from + 1 + start,
            end.a + Math.max(0, overlap) - start,
            end.b + Math.max(0, overlap) - start,
          );
        }
        return;
      }
    }
    patch(from, to - from, newTo - newFrom);
  };
  // Ordered content anchors retain unchanged blocks even when several other
  // blocks changed. Duplicate paragraphs are matched in document order.
  const locations = new Map<string, number[]>();
  newBlocks.forEach((block, index) => {
    const positions = locations.get(block.signature) ?? [];
    positions.push(index);
    locations.set(block.signature, positions);
  });
  // Reserve equal ends first: editing the first of two identical paragraphs
  // must not make it take the second paragraph's selection anchor.
  while (
    oldIndex < oldBlocks.length &&
    newIndex < newBlocks.length &&
    oldBlocks[oldIndex]!.signature === newBlocks[newIndex]!.signature
  ) {
    oldIndex++;
    newIndex++;
  }
  let oldEnd = oldBlocks.length;
  let newEnd = newBlocks.length;
  while (
    oldEnd > oldIndex &&
    newEnd > newIndex &&
    oldBlocks[oldEnd - 1]!.signature === newBlocks[newEnd - 1]!.signature
  ) {
    oldEnd--;
    newEnd--;
  }
  for (let index = oldIndex; index < oldEnd; index++) {
    const match = locations
      .get(oldBlocks[index]!.signature)
      ?.find((at) => at >= newIndex && at < newEnd);
    if (match === undefined) continue;
    replaceUntil(index, match);
    oldIndex = index + 1;
    newIndex = match + 1;
  }
  replaceUntil(oldEnd, newEnd);
  try {
    return selection.map(after, mapping);
  } catch {
    // A removed node/cell selection needs a nearby text caret instead.
    return TextSelection.between(
      after.resolve(Math.max(0, Math.min(mapping.map(selection.anchor), after.content.size))),
      after.resolve(Math.max(0, Math.min(mapping.map(selection.head), after.content.size))),
    );
  }
}
