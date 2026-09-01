import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

export interface MarkdownSourceBlock {
  /** Stable only for the lifetime of this parsed ledger. */
  readonly id: string;
  readonly kind: RootContent["type"];
  /** UTF-16 offsets used by JavaScript String#slice, never byte offsets. */
  readonly start: number;
  readonly contentEnd: number;
  /** Includes inter-block trivia owned by this block. */
  readonly end: number;
  readonly source: string;
  readonly trailing: string;
  /**
   * Logical text in the order a rich document exposes it. Direct spans point
   * at source bytes that contain exactly the same UTF-16 text and can
   * therefore accept a narrow text patch without normalizing Markdown around
   * them. Non-direct spans keep later offsets aligned but require block
   * serialization when edited.
   */
  readonly logicalText: string;
  readonly textSpans: ReadonlyArray<MarkdownSourceTextSpan>;
}

export interface MarkdownSourceTextSpan {
  readonly textStart: number;
  readonly textEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly direct: boolean;
}

export interface MarkdownSourceLedger {
  readonly source: string;
  /** Trivia before the first parsed block, or all source when there are no blocks. */
  readonly prefix: string;
  readonly blocks: ReadonlyArray<MarkdownSourceBlock>;
  readonly lineEnding: "\n" | "\r\n";
  readonly hasFinalLineEnding: boolean;
  /** Includes definitions nested in lists or blockquotes. */
  readonly hasReferenceDefinitions: boolean;
}

export interface MarkdownSourceBlockReplacement {
  readonly id: string;
  /** Null deletes only the block content; its trailing trivia remains. */
  readonly markdown: string | null;
}

export interface MarkdownSourcePatch {
  /** Inclusive UTF-16 source offset. */
  readonly start: number;
  /** Exclusive UTF-16 source offset. */
  readonly end: number;
  readonly replacement: string;
}

function requiredOffset(
  position: { readonly offset?: number | undefined } | undefined,
  side: "start" | "end",
): number {
  const offset = position?.offset;
  if (typeof offset !== "number") {
    throw new Error(`Markdown parser did not provide a ${side} source offset.`);
  }
  return offset;
}

function lineEndingOf(source: string): "\n" | "\r\n" {
  const newline = source.indexOf("\n");
  return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n";
}

interface MdastValueNode {
  readonly type: string;
  readonly value?: unknown;
  readonly children?: ReadonlyArray<MdastValueNode> | undefined;
  readonly position?:
    | {
        readonly start?: { readonly offset?: number | undefined } | undefined;
        readonly end?: { readonly offset?: number | undefined } | undefined;
      }
    | undefined;
}

const LOGICAL_VALUE_NODE_KINDS = new Set(["code", "inlineCode", "text"]);

function hasReferenceDefinition(node: MdastValueNode): boolean {
  return node.type === "definition" || (node.children?.some(hasReferenceDefinition) ?? false);
}

function markdownLogicalText(
  node: MdastValueNode,
  source: string,
): {
  readonly logicalText: string;
  readonly textSpans: ReadonlyArray<MarkdownSourceTextSpan>;
} {
  let logicalText = "";
  const textSpans: MarkdownSourceTextSpan[] = [];
  const visit = (current: MdastValueNode): void => {
    if (LOGICAL_VALUE_NODE_KINDS.has(current.type) && typeof current.value === "string") {
      const value = current.type === "text" ? current.value.replace(/\r\n/gu, "\n") : current.value;
      const textStart = logicalText.length;
      logicalText += value;
      const textEnd = logicalText.length;
      const sourceStart = current.position?.start?.offset;
      const sourceEnd = current.position?.end?.offset;
      if (typeof sourceStart === "number" && typeof sourceEnd === "number") {
        const sourceValue = source.slice(sourceStart, sourceEnd);
        if (
          current.type === "text" &&
          sourceValue !== value &&
          sourceValue.replace(/\r\n/gu, "\n") === value
        ) {
          // mdast normalizes CRLF to LF inside text values. Keep the visible
          // offsets aligned while exposing each ordinary text run as a direct
          // source span; the newline itself remains intentionally non-direct.
          let sourceOffset = 0;
          let logicalOffset = textStart;
          for (const part of sourceValue.split(/(\r\n)/gu)) {
            if (part.length === 0) continue;
            const normalized = part === "\r\n" ? "\n" : part;
            textSpans.push({
              textStart: logicalOffset,
              textEnd: logicalOffset + normalized.length,
              sourceStart: sourceStart + sourceOffset,
              sourceEnd: sourceStart + sourceOffset + part.length,
              direct: part !== "\r\n",
            });
            logicalOffset += normalized.length;
            sourceOffset += part.length;
          }
          return;
        }
        textSpans.push({
          textStart,
          textEnd,
          sourceStart,
          sourceEnd,
          direct: current.type === "text" && sourceValue === value,
        });
      }
      return;
    }
    current.children?.forEach(visit);
  };
  visit(node);
  return { logicalText, textSpans };
}

const DIRECTION_OPEN_PATTERN = /^<div dir="(ltr|rtl|auto)">$/u;
const DIRECTION_CLOSE_TEXT = "</div>";

/**
 * Merge the blocks of a text-direction HTML region (`<div dir="...">` ...
 * `</div>`) into one block so the rich editor sees a single directed block
 * instead of literal wrapper lines. The wrapper is the only Markdown form
 * that carries paragraph direction across files.
 */
function mergeDirectionRegions(
  source: string,
  blocks: ReadonlyArray<MarkdownSourceBlock>,
): ReadonlyArray<MarkdownSourceBlock> {
  const merged: MarkdownSourceBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    const open = blocks[index];
    if (!open || !DIRECTION_OPEN_PATTERN.test(open.source.trim())) {
      if (open) merged.push(open);
      index += 1;
      continue;
    }
    let closeIndex = -1;
    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      if (blocks[cursor]?.source.trim() === DIRECTION_CLOSE_TEXT) {
        closeIndex = cursor;
        break;
      }
    }
    if (closeIndex < 0) {
      merged.push(open);
      index += 1;
      continue;
    }
    const close = blocks[closeIndex];
    if (!close) {
      merged.push(open);
      index += 1;
      continue;
    }
    const inner = blocks.slice(index + 1, closeIndex);
    let logicalText = "";
    const textSpans: MarkdownSourceTextSpan[] = [];
    for (const block of inner) {
      textSpans.push(
        ...block.textSpans.map((span) => ({
          ...span,
          textStart: span.textStart + logicalText.length,
          textEnd: span.textEnd + logicalText.length,
        })),
      );
      logicalText += block.logicalText;
    }
    merged.push({
      id: open.id,
      kind: "paragraph",
      start: open.start,
      contentEnd: close.contentEnd,
      end: close.end,
      source: source.slice(open.start, close.contentEnd),
      trailing: close.trailing,
      logicalText,
      textSpans,
    });
    index = closeIndex + 1;
  }
  return merged;
}

/**
 * Parse exact top-level Markdown source ownership without normalizing bytes.
 * The syntax tree is used only to locate blocks; the original string remains
 * the source of truth for every untouched slice.
 */
export function createMarkdownSourceLedger(source: string): MarkdownSourceLedger {
  const root = fromMarkdown(source, {
    extensions: [frontmatter(["yaml", "toml"]), gfm(), math()],
    mdastExtensions: [
      frontmatterFromMarkdown(["yaml", "toml"]),
      gfmFromMarkdown(),
      mathFromMarkdown(),
    ],
  });
  const positioned = root.children.map((node) => ({
    node,
    start: requiredOffset(node.position?.start, "start"),
    contentEnd: requiredOffset(node.position?.end, "end"),
  }));
  const prefix = positioned.length > 0 ? source.slice(0, positioned[0]?.start ?? 0) : source;
  const blocks = mergeDirectionRegions(
    source,
    positioned.map(({ node, start, contentEnd }, index): MarkdownSourceBlock => {
      const end = positioned[index + 1]?.start ?? source.length;
      if (start > contentEnd || contentEnd > end) {
        throw new Error(`Invalid Markdown source range for top-level ${node.type} block.`);
      }
      const text = markdownLogicalText(node as MdastValueNode, source);
      return {
        // Position is deliberately excluded: ordinary text edits can move every
        // later block offset, while their session identities must remain stable.
        id: `source-${index + 1}-${node.type}`,
        kind: node.type,
        start,
        contentEnd,
        end,
        source: source.slice(start, contentEnd),
        trailing: source.slice(contentEnd, end),
        logicalText: text.logicalText,
        textSpans: text.textSpans,
      };
    }),
  );
  return {
    source,
    prefix,
    blocks,
    lineEnding: lineEndingOf(source),
    hasFinalLineEnding: source.endsWith("\n"),
    hasReferenceDefinitions: hasReferenceDefinition(root),
  };
}

/** Rebuild a document while reusing every untouched block and trivia slice verbatim. */
export function replaceMarkdownSourceBlocks(
  ledger: MarkdownSourceLedger,
  replacements: ReadonlyArray<MarkdownSourceBlockReplacement>,
): string {
  const knownIds = new Set(ledger.blocks.map((block) => block.id));
  const replacementById = new Map<string, string | null>();
  for (const replacement of replacements) {
    if (!knownIds.has(replacement.id)) {
      throw new Error(`Unknown Markdown source block '${replacement.id}'.`);
    }
    if (replacementById.has(replacement.id)) {
      throw new Error(`Duplicate replacement for Markdown source block '${replacement.id}'.`);
    }
    replacementById.set(replacement.id, replacement.markdown);
  }

  let output = ledger.prefix;
  for (const block of ledger.blocks) {
    const replacement = replacementById.get(block.id);
    output += replacementById.has(block.id) ? (replacement ?? "") : block.source;
    output += block.trailing;
  }
  return output;
}

function assertSafeBoundary(source: string, offset: number): void {
  if (offset <= 0 || offset >= source.length) return;
  const previous = source.charCodeAt(offset - 1);
  const current = source.charCodeAt(offset);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  if (splitsSurrogatePair) {
    throw new Error(`Markdown patch boundary ${offset} splits a Unicode surrogate pair.`);
  }
  if (source[offset - 1] === "\r" && source[offset] === "\n") {
    throw new Error(`Markdown patch boundary ${offset} splits a CRLF line ending.`);
  }
}

/**
 * Apply non-overlapping exact source patches. This deliberately knows nothing
 * about a rich-editor serializer; callers must first constrain patches to the
 * source ranges owned by user-authored transactions.
 */
export function applyMarkdownSourcePatches(
  source: string,
  patches: ReadonlyArray<MarkdownSourcePatch>,
): string {
  const ordered = patches.toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let previousEnd = 0;
  for (const [index, patch] of ordered.entries()) {
    if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end)) {
      throw new Error("Markdown patch offsets must be integers.");
    }
    if (patch.start < 0 || patch.end < patch.start || patch.end > source.length) {
      throw new Error(`Markdown patch [${patch.start}, ${patch.end}) is outside the source.`);
    }
    if (index > 0 && patch.start < previousEnd) {
      throw new Error("Markdown source patches overlap.");
    }
    assertSafeBoundary(source, patch.start);
    assertSafeBoundary(source, patch.end);
    previousEnd = patch.end;
  }

  let cursor = 0;
  let output = "";
  for (const patch of ordered) {
    output += source.slice(cursor, patch.start);
    output += patch.replacement;
    cursor = patch.end;
  }
  return output + source.slice(cursor);
}
