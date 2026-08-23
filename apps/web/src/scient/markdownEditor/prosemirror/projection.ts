import {
  applyMarkdownSourcePatches,
  createMarkdownSourceLedger,
  type MarkdownSourceBlock,
  type MarkdownSourceLedger,
} from "@scientfactory/scient-markdown";
import type { Node as ProseMirrorNode } from "prosemirror-model";

import {
  scientMarkdownParser,
  scientMarkdownSchema,
  scientMarkdownSerializer,
  withMarkdownSourceId,
} from "./schema";

const COMMONMARK_BLOCK_KINDS = new Set<MarkdownSourceBlock["kind"]>([
  "blockquote",
  "break",
  "code",
  "heading",
  "list",
  "paragraph",
  "table",
  "thematicBreak",
]);

export interface ScientMarkdownProjection {
  readonly ledger: MarkdownSourceLedger;
  readonly baselineDocument: ProseMirrorNode;
  readonly document: ProseMirrorNode;
}

function rawBlock(block: MarkdownSourceBlock): ProseMirrorNode {
  const nodeType = scientMarkdownSchema.nodes.raw_block;
  if (!nodeType) throw new Error("Scient Markdown schema is missing raw_block.");
  return nodeType.create({ source: block.source, sourceId: block.id, sourceKind: block.kind });
}

function displayMathBlock(block: MarkdownSourceBlock): ProseMirrorNode {
  const nodeType = scientMarkdownSchema.nodes.display_math;
  if (!nodeType) throw new Error("Scient Markdown schema is missing display_math.");
  const trimmed = block.source.trim();
  if (!trimmed.startsWith("$$") || !trimmed.endsWith("$$") || trimmed.length < 4) {
    return rawBlock(block);
  }
  const tex = trimmed.slice(2, -2).replace(/^\r?\n|\r?\n$/gu, "");
  return nodeType.create({ tex, delimiter: "$$", sourceId: block.id });
}

function footnoteDefinitionBlock(block: MarkdownSourceBlock): ProseMirrorNode | null {
  const match = /^\[\^([^\]\r\n]+)\]:/u.exec(block.source);
  if (!match?.[1]) return null;
  const nodeType = scientMarkdownSchema.nodes.footnote_definition;
  if (!nodeType) throw new Error("Scient Markdown schema is missing footnote_definition.");
  return nodeType.create({ label: match[1], source: block.source, sourceId: block.id });
}

function parseBlock(block: MarkdownSourceBlock): ProseMirrorNode {
  if (block.kind === "math") return displayMathBlock(block);
  const footnote = footnoteDefinitionBlock(block);
  if (footnote) return footnote;
  if (!COMMONMARK_BLOCK_KINDS.has(block.kind)) return rawBlock(block);
  const parsed = scientMarkdownParser.parse(block.source);
  if (parsed.childCount !== 1) return rawBlock(block);
  return withMarkdownSourceId(parsed.child(0), block.id);
}

export function createScientMarkdownProjection(source: string): ScientMarkdownProjection {
  const ledger = createMarkdownSourceLedger(source);
  const children = ledger.blocks.map(parseBlock);
  const document = scientMarkdownSchema.topNodeType.createAndFill(null, children);
  if (!document) throw new Error("Unable to create the Scient Markdown document.");
  return { ledger, baselineDocument: document, document };
}

function sourceIdOf(node: ProseMirrorNode): string | null {
  const sourceId = node.attrs.sourceId;
  return typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
}

function topLevelNodesBySourceId(document: ProseMirrorNode): ReadonlyMap<string, ProseMirrorNode> {
  const nodes = new Map<string, ProseMirrorNode>();
  document.forEach((node) => {
    const sourceId = sourceIdOf(node);
    if (sourceId !== null && !nodes.has(sourceId)) nodes.set(sourceId, node);
  });
  return nodes;
}

function serializeNode(node: ProseMirrorNode): string {
  if (node.type.name === "raw_block") return String(node.attrs.source);
  const document = scientMarkdownSchema.topNodeType.createAndFill(null, [node]);
  if (!document) throw new Error(`Unable to serialize Markdown node '${node.type.name}'.`);
  return scientMarkdownSerializer.serialize(document);
}

function comparableAttrs(node: ProseMirrorNode): string {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs).filter(([name]) => name !== "sourceId"),
  );
  return JSON.stringify(attrs);
}

function textStructure(node: ProseMirrorNode): string {
  if (node.isText) {
    return `text:${node.marks
      .map((mark) => `${mark.type.name}:${JSON.stringify(mark.attrs)}`)
      .join(",")}`;
  }
  const children: string[] = [];
  node.forEach((child) => children.push(textStructure(child)));
  return `${node.type.name}:${comparableAttrs(node)}[${children.join("|")}]`;
}

function textDifference(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, beforeEnd, replacement: after.slice(start, afterEnd) };
}

/**
 * Preserve list markers, table spacing, emphasis delimiters, and other local
 * syntax when an edit changes only text inside one exact mdast text span.
 * Structural or ambiguous edits deliberately fall back to the block
 * serializer.
 */
function minimallyPatchedTextBlock(
  block: MarkdownSourceBlock,
  baseline: ProseMirrorNode,
  next: ProseMirrorNode,
): string | null {
  if (block.logicalText !== baseline.textContent) return null;
  if (baseline.textContent === next.textContent) return null;
  if (textStructure(baseline) !== textStructure(next)) return null;
  const difference = textDifference(baseline.textContent, next.textContent);
  const candidates = block.textSpans.filter(
    (candidate) =>
      candidate.direct &&
      difference.start >= candidate.textStart &&
      difference.beforeEnd <= candidate.textEnd,
  );
  // At a boundary between two logical text spans, ProseMirror positions the
  // caret inside the following text node. Prefer that span so an insertion at
  // the start of a nested list item is not appended to the preceding item.
  const span =
    candidates.find((candidate) => candidate.textStart === difference.start) ?? candidates[0];
  if (!span) return null;
  const sourceStart = span.sourceStart + difference.start - span.textStart;
  const sourceEnd = span.sourceStart + difference.beforeEnd - span.textStart;
  const expected = baseline.textContent.slice(difference.start, difference.beforeEnd);
  if (block.source.slice(sourceStart - block.start, sourceEnd - block.start) !== expected) {
    return null;
  }
  return applyMarkdownSourcePatches(block.source, [
    {
      start: sourceStart - block.start,
      end: sourceEnd - block.start,
      replacement: difference.replacement,
    },
  ]);
}

function inferredSeparator(
  ledger: MarkdownSourceLedger,
  index: number,
  childCount: number,
): string {
  if (index < childCount - 1) return `${ledger.lineEnding}${ledger.lineEnding}`;
  return ledger.hasFinalLineEnding ? ledger.lineEnding : "";
}

/**
 * Project a changed ProseMirror document back to Markdown. Nodes that still
 * equal their parsed baseline reuse exact source and trivia. Only nodes
 * changed by a user transaction enter a serializer.
 */
export function serializeScientMarkdownProjection(
  projection: ScientMarkdownProjection,
  document: ProseMirrorNode,
): string {
  const blockById = new Map(projection.ledger.blocks.map((block) => [block.id, block]));
  const originalSuccessorById = new Map<string, string | null>();
  projection.ledger.blocks.forEach((block, index) => {
    originalSuccessorById.set(block.id, projection.ledger.blocks[index + 1]?.id ?? null);
  });
  const baselineById = topLevelNodesBySourceId(projection.baselineDocument);
  const consumedIds = new Set<string>();
  const nodes: ProseMirrorNode[] = [];
  document.forEach((node) => nodes.push(node));
  let output = projection.ledger.prefix;

  nodes.forEach((node, index) => {
    const sourceId = sourceIdOf(node);
    const original =
      sourceId === null || consumedIds.has(sourceId) ? undefined : blockById.get(sourceId);
    const baseline = sourceId === null ? undefined : baselineById.get(sourceId);
    if (sourceId !== null) consumedIds.add(sourceId);

    output +=
      original && baseline?.eq(node)
        ? original.source
        : ((original && baseline ? minimallyPatchedTextBlock(original, baseline, node) : null) ??
          serializeNode(node));
    const nextSourceId = nodes[index + 1] ? sourceIdOf(nodes[index + 1]!) : null;
    const originalSequenceContinues =
      original !== undefined && originalSuccessorById.get(original.id) === nextSourceId;
    output += originalSequenceContinues
      ? original.trailing
      : inferredSeparator(projection.ledger, index, nodes.length);
  });
  return output;
}

export function withProjectedDocument(
  projection: ScientMarkdownProjection,
  document: ProseMirrorNode,
): ScientMarkdownProjection {
  return { ...projection, document };
}
