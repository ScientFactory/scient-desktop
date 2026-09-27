/**
 * Markdown parsing and source editing shared by the conversation Markdown
 * writer and reader. Every structural decision comes from the parsed tree;
 * edits are applied to the original source by offset so untouched text keeps
 * its exact bytes.
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/**
 * Chat's dialect: CommonMark with GFM and `$$` math. Single-dollar math is off
 * in the tokenizer, as in chat's remark stack, so `$5 and $6` stays text.
 */
export function parseMarkdown(source: string, options?: { readonly frontMatter?: boolean }): Root {
  const withFrontMatter = options?.frontMatter === true;
  return fromMarkdown(source, {
    extensions: [
      ...(withFrontMatter ? [frontmatter(["yaml"])] : []),
      gfm(),
      math({ singleDollarTextMath: false }),
    ],
    mdastExtensions: [
      ...(withFrontMatter ? [frontmatterFromMarkdown(["yaml"])] : []),
      gfmFromMarkdown(),
      mathFromMarkdown(),
    ],
  });
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export function nodeRange(node: Nodes): SourceRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/** Depth-first visit with the chain of ancestors (root first). */
export function visitNodes(
  root: Nodes,
  visitor: (node: Nodes, ancestors: ReadonlyArray<Nodes>) => void,
): void {
  const walk = (node: Nodes, ancestors: Nodes[]) => {
    visitor(node, ancestors);
    if ("children" in node) {
      ancestors.push(node);
      for (const child of node.children) walk(child as Nodes, ancestors);
      ancestors.pop();
    }
  };
  walk(root, []);
}

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Applies non-overlapping edits. Insertions at the same offset keep the order
 * they were given in; an edit overlapping an earlier one is a programming
 * error and throws.
 */
export function applyEdits(source: string, edits: ReadonlyArray<SourceEdit>): string {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    // At one offset, insertions go before a replacement that starts there.
    .toSorted(
      (left, right) =>
        left.edit.start - right.edit.start ||
        Number(left.edit.end > left.edit.start) - Number(right.edit.end > right.edit.start) ||
        left.index - right.index,
    )
    .map(({ edit }) => edit);
  let result = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) throw new Error("Overlapping Markdown source edits.");
    result += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}

/** Node types whose content is literal: nothing inside them is Markdown. */
export const LITERAL_NODE_TYPES: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
]);

/** Source ranges of literal content, for skipping text searches inside code. */
export function literalRanges(root: Root): ReadonlyArray<SourceRange> {
  const ranges: SourceRange[] = [];
  visitNodes(root, (node) => {
    if (!LITERAL_NODE_TYPES.has(node.type)) return;
    const range = nodeRange(node);
    if (range) ranges.push(range);
  });
  return ranges;
}

export function insideAny(offset: number, ranges: ReadonlyArray<SourceRange>): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

/** The longest run of `character` in `text`, for choosing a fence that cannot close early. */
export function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** A fenced block whose fence no line of `content` can close. */
export function fencedBlock(content: string, info = "text"): string {
  const fence = "`".repeat(Math.max(3, longestRun(content, "`") + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

const INLINE_ESCAPE_PATTERN = /[\\`*_[\]|~<>&$]/gu;

/**
 * Plain text written into Markdown so that it renders as exactly that text.
 * Line breaks become hard breaks; nothing can start a block.
 */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(INLINE_ESCAPE_PATTERN, (character) =>
          character === "<"
            ? "&lt;"
            : character === ">"
              ? "&gt;"
              : character === "&"
                ? "&amp;"
                : `\\${character}`,
        )
        // Block starts: headings, list markers, ordered lists, setext underlines.
        .replace(/^(\s*)([#=+-])/u, "$1\\$2")
        .replace(/^(\s*\d+)([.)])/u, "$1\\$2"),
    )
    .join("\\\n");
}

export function escapeHtmlText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
