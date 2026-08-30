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
  readonly parseEnvironment: MarkdownParseEnvironment;
}

interface MarkdownParseEnvironment {
  readonly references?: Readonly<Record<string, { readonly href: string; readonly title: string }>>;
}

function parseWithContext(source: string, environment: MarkdownParseEnvironment) {
  // markdown-it collects definitions into its environment while parsing.
  // Speculative source patches must not mutate the accepted document context.
  return scientMarkdownParser.parse(source, { references: { ...environment.references } });
}

export interface ScientMarkdownProjectedSource {
  readonly source: string;
  readonly blockRanges: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
  }>;
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

function parseBlock(
  block: MarkdownSourceBlock,
  environment: MarkdownParseEnvironment,
): ProseMirrorNode {
  if (block.kind === "math") return displayMathBlock(block);
  const footnote = footnoteDefinitionBlock(block);
  if (footnote) return footnote;
  if (!COMMONMARK_BLOCK_KINDS.has(block.kind)) return rawBlock(block);
  const parsed = parseWithContext(block.source, environment);
  if (parsed.childCount !== 1) return rawBlock(block);
  return withMarkdownSourceId(parsed.child(0), block.id);
}

export function createScientMarkdownProjection(source: string): ScientMarkdownProjection {
  const ledger = createMarkdownSourceLedger(source);
  const parseEnvironment = {};
  // References belong to the document, not the paragraph using them. Collect
  // definitions once; keep individual source slices as the projection owners.
  if (ledger.hasReferenceDefinitions) {
    scientMarkdownParser.tokenizer.parse(source, parseEnvironment);
  }
  const children = ledger.blocks.map((block) => parseBlock(block, parseEnvironment));
  if (children.length === 0) {
    const paragraph = scientMarkdownSchema.nodes.paragraph?.create();
    if (!paragraph) throw new Error("Scient Markdown schema is missing paragraph.");
    children.push(paragraph);
  }
  const document = scientMarkdownSchema.topNodeType.createAndFill(null, children);
  if (!document) throw new Error("Unable to create the Scient Markdown document.");
  return { ledger, baselineDocument: document, document, parseEnvironment };
}

function sourceIdOf(node: ProseMirrorNode): string | null {
  const sourceId = node.attrs.sourceId;
  return typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
}

function sourceCopyIdOf(node: ProseMirrorNode): string | null {
  const sourceCopyId = node.attrs.sourceCopyId;
  return typeof sourceCopyId === "string" && sourceCopyId.length > 0 ? sourceCopyId : null;
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
    Object.entries(node.attrs).filter(([name]) => name !== "sourceId" && name !== "sourceCopyId"),
  );
  return JSON.stringify(attrs);
}

function hasSameProjectedContent(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  if (
    before.type !== after.type ||
    comparableAttrs(before) !== comparableAttrs(after) ||
    before.text !== after.text ||
    before.childCount !== after.childCount ||
    JSON.stringify(before.marks) !== JSON.stringify(after.marks)
  )
    return false;
  for (let index = 0; index < before.childCount; index += 1) {
    if (!hasSameProjectedContent(before.child(index), after.child(index))) return false;
  }
  return true;
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
  while (start < before.length && start < after.length) {
    const beforePoint = before.codePointAt(start);
    const afterPoint = after.codePointAt(start);
    if (beforePoint !== afterPoint) break;
    start += beforePoint !== undefined && beforePoint > 0xffff ? 2 : 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start) {
    const previousBefore = previousCodePointStart(before, beforeEnd);
    const previousAfter = previousCodePointStart(after, afterEnd);
    if (before.slice(previousBefore, beforeEnd) !== after.slice(previousAfter, afterEnd)) break;
    beforeEnd = previousBefore;
    afterEnd = previousAfter;
  }
  return { start, beforeEnd, replacement: after.slice(start, afterEnd) };
}

function previousCodePointStart(value: string, end: number): number {
  const last = value.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end > 1) {
    const preceding = value.charCodeAt(end - 2);
    if (preceding >= 0xd800 && preceding <= 0xdbff) return end - 2;
  }
  return end - 1;
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
  environment: MarkdownParseEnvironment,
): string | null {
  if (block.logicalText !== baseline.textContent) return null;
  if (baseline.textContent === next.textContent) return null;
  if (textStructure(baseline) !== textStructure(next)) return null;
  // Concatenated text cannot locate an edit among identical cells/items.
  // Follow corresponding text nodes before calculating a narrow local diff.
  let offset = 0;
  const changes: Array<ReturnType<typeof textDifference>> = [];
  const visit = (before: ProseMirrorNode, after: ProseMirrorNode): void => {
    if (before.isText) {
      if (before.text !== after.text) {
        const diff = textDifference(before.text!, after.text!);
        changes.push({ ...diff, start: offset + diff.start, beforeEnd: offset + diff.beforeEnd });
      }
      offset += before.text!.length;
    } else if (before.isLeaf) offset += before.textContent.length;
    else before.forEach((child, _pos, index) => visit(child, after.child(index)));
  };
  visit(baseline, next);
  if (changes.length !== 1) return null;
  const difference = changes[0]!;
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
  try {
    const patched = applyMarkdownSourcePatches(block.source, [
      {
        start: sourceStart - block.start,
        end: sourceEnd - block.start,
        replacement: difference.replacement,
      },
    ]);
    // A literal keystroke can introduce Markdown syntax. Only reuse a narrow
    // patch when reopening it means exactly the same thing as the live node.
    const parsed = parseWithContext(patched, environment);
    return parsed.childCount === 1 && hasSameProjectedContent(parsed.child(0), next)
      ? patched
      : null;
  } catch {
    // Unsafe source boundaries (surrogates/CRLF) use the normal serializer.
    return null;
  }
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
export function projectScientMarkdownSource(
  projection: ScientMarkdownProjection,
  document: ProseMirrorNode,
): ScientMarkdownProjectedSource {
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
  const blockRanges: Array<{ readonly from: number; readonly to: number }> = [];

  nodes.forEach((node, index) => {
    const sourceId = sourceIdOf(node);
    const directOriginal =
      sourceId === null || consumedIds.has(sourceId) ? undefined : blockById.get(sourceId);
    const copyId = directOriginal ? null : sourceCopyIdOf(node);
    const original = directOriginal ?? (copyId === null ? undefined : blockById.get(copyId));
    const baselineId = directOriginal ? sourceId : copyId;
    const baseline = baselineId === null ? undefined : baselineById.get(baselineId);
    if (directOriginal && sourceId !== null) consumedIds.add(sourceId);

    const sourceUnchanged =
      directOriginal && baseline
        ? baseline.eq(node)
        : original && baseline
          ? hasSameProjectedContent(baseline, node)
          : false;
    const source =
      sourceUnchanged && original
        ? original.source
        : ((original && baseline
            ? minimallyPatchedTextBlock(original, baseline, node, projection.parseEnvironment)
            : null) ?? serializeNode(node));
    const from = output.length;
    output += source;
    blockRanges.push({ from, to: from + source.length });
    const nextSourceId = nodes[index + 1] ? sourceIdOf(nodes[index + 1]!) : null;
    const originalSequenceContinues =
      directOriginal !== undefined && originalSuccessorById.get(directOriginal.id) === nextSourceId;
    output += originalSequenceContinues
      ? directOriginal.trailing
      : inferredSeparator(projection.ledger, index, nodes.length);
  });
  return { source: output, blockRanges };
}

export function serializeScientMarkdownProjection(
  projection: ScientMarkdownProjection,
  document: ProseMirrorNode,
): string {
  return projectScientMarkdownSource(projection, document).source;
}

export function withProjectedDocument(
  projection: ScientMarkdownProjection,
  document: ProseMirrorNode,
): ScientMarkdownProjection {
  return { ...projection, document };
}

/** Refresh derived reference marks without replacing the editor or its source identities. */
export function refreshScientMarkdownReferences(
  projection: ScientMarkdownProjection,
  projected: ScientMarkdownProjectedSource,
) {
  const document = projection.document;
  if (
    !projection.ledger.hasReferenceDefinitions &&
    !projection.parseEnvironment.references &&
    !Array.from({ length: document.childCount }, (_, index) => document.child(index)).some(
      (node) => node.type.name === "raw_block",
    )
  )
    return null;
  const environment: MarkdownParseEnvironment = {};
  scientMarkdownParser.tokenizer.parse(projected.source, environment);
  const before = projection.parseEnvironment.references ?? {};
  const after = environment.references ?? {};
  if (
    Object.keys(before).length === Object.keys(after).length &&
    Object.entries(before).every(
      ([key, value]) => value.href === after[key]?.href && value.title === after[key]?.title,
    )
  )
    return null;

  const replacements: Array<{
    readonly from: number;
    readonly to: number;
    readonly node: ProseMirrorNode;
  }> = [];
  document.forEach((node, offset, index) => {
    // Source islands remain editable source, even while temporarily incomplete.
    if (node.type.name === "raw_block" || node.type.name === "footnote_definition") return;
    const range = projected.blockRanges[index]!;
    const source = projected.source.slice(range.from, range.to);
    const oldParsed = parseWithContext(source, projection.parseEnvironment);
    const nextParsed = parseWithContext(source, environment);
    if (
      oldParsed.childCount !== 1 ||
      nextParsed.childCount !== 1 ||
      !hasSameProjectedContent(oldParsed.child(0), node) ||
      hasSameProjectedContent(nextParsed.child(0), node)
    )
      return;
    const next = nextParsed.child(0);
    replacements.push({
      from: offset,
      to: offset + node.nodeSize,
      node: next.type.create(
        { ...next.attrs, sourceId: node.attrs.sourceId, sourceCopyId: node.attrs.sourceCopyId },
        next.content,
        next.marks,
      ),
    });
  });
  // The same unchanged reference source now projects to a different href. Rebind
  // its baseline too, so a subsequent save still preserves the original syntax.
  const baselineDocument = projection.baselineDocument.type.create(
    null,
    projection.ledger.blocks.map((block) => parseBlock(block, environment)),
  );
  return {
    projection: { ...projection, parseEnvironment: environment, baselineDocument },
    replacements,
  };
}
