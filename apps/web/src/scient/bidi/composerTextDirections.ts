import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  countStrongScripts,
  resolveProseBlockDirectionFromCounts,
  resolveStructuredDirectionFromCounts,
  type ContentDirection,
  type FixedContentDirection,
  type StrongScriptCounts,
} from "./contentDirection";

interface ComposerTextDirections {
  readonly blocks: ReadonlyArray<FixedContentDirection | null>;
  readonly decorations: DecorationSet;
}

// Immutable shared blocks need recounting only when their own content changes.
const blockCounts = new WeakMap<ProseMirrorNode, StrongScriptCounts>();
const docDirections = new WeakMap<ProseMirrorNode, Map<ContentDirection, ComposerTextDirections>>();

function proseText(block: ProseMirrorNode): string {
  let text = "";
  block.descendants((node) => {
    if (node.isText) {
      text += node.marks.some((mark) => mark.type.spec.code) ? " " : node.text;
    } else if (node.isAtom || node.type.spec.code) {
      text += " ";
      return false;
    } else if (node.isBlock) {
      text += " ";
    }
  });
  return text;
}

function proseCounts(block: ProseMirrorNode): StrongScriptCounts {
  let counts = blockCounts.get(block);
  if (counts === undefined) {
    counts = block.type.spec.code ? { ltr: 0, rtl: 0 } : countStrongScripts(proseText(block));
    blockCounts.set(block, counts);
  }
  return counts;
}

/** Lists and quotes share direction; empty blocks inherit, and code stays left to right. */
export function composerTextDirections(
  doc: ProseMirrorNode,
  requested: ContentDirection = "auto",
): ComposerTextDirections {
  const cached = docDirections.get(doc)?.get(requested);
  if (cached) return cached;
  const blocks: Array<FixedContentDirection | null> = [];
  const decorations: Decoration[] = [];
  const counts: StrongScriptCounts[] = [];
  doc.forEach((block) => counts.push(proseCounts(block)));
  const aggregate = counts.reduce(
    (sum, value) => ({ ltr: sum.ltr + value.ltr, rtl: sum.rtl + value.rtl }),
    { ltr: 0, rtl: 0 },
  );
  const base =
    requested === "auto"
      ? resolveStructuredDirectionFromCounts(counts, aggregate, "ltr")
      : requested;
  let previous: FixedContentDirection = base;
  doc.forEach((block, offset) => {
    if (block.type.spec.code) {
      blocks.push("ltr");
      decorations.push(Decoration.node(offset, offset + block.nodeSize, { dir: "ltr" }));
      return;
    }
    const evidence = proseCounts(block);
    const dir =
      requested !== "auto"
        ? requested
        : evidence.ltr + evidence.rtl === 0
          ? previous
          : resolveProseBlockDirectionFromCounts(evidence, base);
    blocks.push(dir);
    if (dir) decorations.push(Decoration.node(offset, offset + block.nodeSize, { dir }));
    previous = dir;
  });
  const directions = { blocks, decorations: DecorationSet.create(doc, decorations) };
  const byPreference = docDirections.get(doc) ?? new Map();
  byPreference.set(requested, directions);
  docDirections.set(doc, byPreference);
  return directions;
}
