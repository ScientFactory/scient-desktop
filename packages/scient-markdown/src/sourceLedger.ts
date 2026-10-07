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
  /**
   * Kinds of the blocks nested inside a container (quote, list, list item,
   * footnote), in document order and without repeats, plus `html` for inline
   * HTML within those nested blocks. Empty for a block whose content is
   * inline only. Lets a projection notice nested syntax, such as a reference
   * definition or an HTML comment, that it cannot carry.
   */
  readonly nestedBlockKinds: ReadonlyArray<string>;
  /** For a merged `<div dir>` region holding exactly one block, that block's kind. */
  readonly directionWrappedKind?: RootContent["type"];
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
  /** Exact document-context syntax in parse order, including nested definitions. */
  readonly contextSources: readonly string[];
}

export interface MarkdownSourceBlockReplacement {
  readonly id: string;
  /** Null deletes only the block content; its trailing trivia remains. */
  readonly markdown: string | null;
}

export {
  applyDocumentSourcePatches as applyMarkdownSourcePatches,
  type DocumentSourcePatch as MarkdownSourcePatch,
} from "@scientfactory/scient-document";

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

const CONTAINER_NODE_KINDS = new Set(["blockquote", "list", "listItem", "footnoteDefinition"]);

/** A `<div dir>` / `</div>` line pair inside a container, which the editor reads as direction. */
const DIRECTION_WRAPPER_KIND = "directionWrapper";

function isDirectionWrapperLine(node: MdastValueNode): "open" | "close" | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const value = node.value.trim();
  if (DIRECTION_OPEN_PATTERN.test(value)) return "open";
  return value === DIRECTION_CLOSE_TEXT ? "close" : null;
}

const DIRECTABLE_KINDS = new Set(["heading", "paragraph", "table"]);

/**
 * Indexes of wrapper lines that form a supported region: an opening line, one
 * paragraph, heading or table, then a closing line. Any other arrangement
 * (reversed, unbalanced, nested, or around a block that has no direction)
 * stays HTML, so the container keeps its exact source.
 */
function directionWrapperIndexes(children: ReadonlyArray<MdastValueNode>): Set<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < children.length; index += 1) {
    const open = children[index];
    const inner = children[index + 1];
    const close = children[index + 2];
    if (!open || !inner || !close || isDirectionWrapperLine(open) !== "open") continue;
    if (isDirectionWrapperLine(close) !== "close" || !DIRECTABLE_KINDS.has(inner.type)) continue;
    indexes.add(index);
    indexes.add(index + 2);
    index += 2;
  }
  return indexes;
}

function nestedBlockKinds(node: MdastValueNode): string[] {
  const kinds = new Set<string>();
  // Inline HTML inside a nested paragraph, heading or table is source the
  // rich document shows as literal text; report it like an HTML block.
  const visitInline = (parent: MdastValueNode): void => {
    for (const child of parent.children ?? []) {
      if (child.type === "html") kinds.add(child.type);
      visitInline(child);
    }
  };
  const visit = (container: MdastValueNode): void => {
    if (!CONTAINER_NODE_KINDS.has(container.type)) return;
    const children = container.children ?? [];
    const wrapperIndexes = directionWrapperIndexes(children);
    children.forEach((child, index) => {
      kinds.add(wrapperIndexes.has(index) ? DIRECTION_WRAPPER_KIND : child.type);
      if (CONTAINER_NODE_KINDS.has(child.type)) visit(child);
      else visitInline(child);
    });
  };
  visit(node);
  return [...kinds];
}

const CONTEXT_NODE_KINDS = new Set(["definition", "footnoteDefinition", "yaml", "toml", "html"]);

function contextSources(node: MdastValueNode, source: string, parserOffset: number): string[] {
  if (CONTEXT_NODE_KINDS.has(node.type)) {
    return [
      source.slice(
        requiredOffset(node.position?.start, "start") + parserOffset,
        requiredOffset(node.position?.end, "end") + parserOffset,
      ),
    ];
  }
  return node.children?.flatMap((child) => contextSources(child, source, parserOffset)) ?? [];
}

function markdownLogicalText(
  node: MdastValueNode,
  source: string,
  parserOffset: number,
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
      const parsedStart = current.position?.start?.offset;
      const parsedEnd = current.position?.end?.offset;
      if (typeof parsedStart === "number" && typeof parsedEnd === "number") {
        const sourceStart = parsedStart + parserOffset;
        const sourceEnd = parsedEnd + parserOffset;
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
    const innerKinds = new Set<string>();
    for (const block of inner) {
      innerKinds.add(block.kind);
      for (const kind of block.nestedBlockKinds) innerKinds.add(kind);
    }
    const onlyInner = inner.length === 1 ? inner[0] : undefined;
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
      nestedBlockKinds: [...innerKinds],
      ...(onlyInner ? { directionWrappedKind: onlyInner.kind } : {}),
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
  // mdast excludes exactly one leading BOM from every reported offset. Keep
  // it as source prefix while aligning block and nested text ownership with
  // the original string. A second BOM remains ordinary parsed content.
  const parserOffset = source.startsWith("\uFEFF") ? 1 : 0;
  const positioned = root.children.map((node) => ({
    node,
    start: requiredOffset(node.position?.start, "start") + parserOffset,
    contentEnd: requiredOffset(node.position?.end, "end") + parserOffset,
  }));
  const prefix = positioned.length > 0 ? source.slice(0, positioned[0]?.start ?? 0) : source;
  const blocks = mergeDirectionRegions(
    source,
    positioned.map(({ node, start, contentEnd }, index): MarkdownSourceBlock => {
      const end = positioned[index + 1]?.start ?? source.length;
      if (start > contentEnd || contentEnd > end) {
        throw new Error(`Invalid Markdown source range for top-level ${node.type} block.`);
      }
      const text = markdownLogicalText(node as MdastValueNode, source, parserOffset);
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
        nestedBlockKinds: nestedBlockKinds(node as MdastValueNode),
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
    contextSources: contextSources(root, source, parserOffset),
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
