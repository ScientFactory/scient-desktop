/**
 * Message bodies as they are written into one shared Markdown document, and
 * back. Writing a body makes it safe to place next to other bodies:
 *
 * - chat's line breaks become explicit hard breaks where chat shows them;
 * - raw HTML is escaped where chat shows it as text;
 * - the literal `<!-- scient:` is escaped outside code so it cannot be read
 *   as a structure marker;
 * - reference definitions, footnote labels, and explicit anchors are prefixed
 *   with a namespace so two bodies cannot collide;
 * - a body that ends inside an unclosed fence or HTML block is closed, so it
 *   cannot swallow what follows.
 *
 * Reading reverses only the namespacing; everything else is what a reader sees.
 */
import type { Definition, Html, ImageReference, Link, LinkReference, Root } from "mdast";

import { normalizeScientMathDelimiters } from "./chatMathDelimiters.ts";
import {
  applyEdits,
  fencedBlock,
  literalRanges,
  nodeRange,
  parseMarkdown,
  visitNodes,
  type SourceEdit,
} from "./markdownAst.ts";

export const STRUCTURE_MARKER_PREFIX = "<!-- scient:";

/** How chat renders raw HTML for this kind of message. */
export type RawHtmlMode =
  /** Shown as literal text (chat's user messages parse Markdown without raw HTML). */
  | "literal"
  /** Rendered after sanitization (assistant messages, reasoning, plans). */
  | "render";

export interface BodyWriteOptions {
  /** Prefix for labels and anchors, e.g. `m2-`. */
  readonly namespace: string;
  /** Chat renders single line breaks as breaks (remark-breaks) for this body. */
  readonly preserveLineBreaks: boolean;
  readonly rawHtml: RawHtmlMode;
}

export interface WrittenBody {
  readonly markdown: string;
  /** The body could not be contained as Markdown and was written as a literal block. */
  readonly containedAsLiteral: boolean;
}

// An attribute value is double-quoted, single-quoted, or unquoted.
const HTML_ANCHOR_ATTRIBUTE = /(\s(?:id|name)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;
const HTML_FRAGMENT_REFERENCE = /(\shref\s*=\s*)(?:"#([^"]*)"|'#([^']*)'|#([^\s"'=<>`]+))/giu;

/** The value of an attribute match and its offset within the match (after a quote and a `#`). */
function attributeValue(
  match: RegExpMatchArray,
  hashPrefix: boolean,
): { value: string; offset: number } {
  const value = match[2] ?? match[3] ?? match[4] ?? "";
  const quoted = match[4] === undefined;
  return { value, offset: match[1]!.length + (quoted ? 1 : 0) + (hashPrefix ? 1 : 0) };
}
const HEADING_ANCHOR = /\{#([A-Za-z][\w:.-]*)\}\s*$/u;

interface LabelSite {
  /** Offset of the first label character and the end of the label. */
  readonly start: number;
  readonly end: number;
}

/** Label position of `[label]` starting at `open` (the `[`), honoring backslash escapes. */
function bracketLabel(source: string, open: number): LabelSite | null {
  if (source[open] !== "[") return null;
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") return null;
    if (character === "]") return { start: open + 1, end: index };
  }
  return null;
}

/** The trailing `[label]` of a full reference: the last bracket pair in the node's source. */
function trailingLabel(source: string, range: { start: number; end: number }): LabelSite | null {
  if (source[range.end - 1] !== "]") return null;
  for (let index = range.end - 2; index > range.start; index -= 1) {
    if (source[index] === "[" && source[index - 1] !== "\\") {
      return { start: index + 1, end: range.end - 1 };
    }
  }
  return null;
}

type Direction = { readonly kind: "add" } | { readonly kind: "remove" };

function renameLabel(label: string, namespace: string, direction: Direction): string | null {
  if (direction.kind === "add") return `${namespace}${label}`;
  return label.toLowerCase().startsWith(namespace.toLowerCase())
    ? label.slice(namespace.length)
    : null;
}

/**
 * Edits that add or remove `namespace` on reference definitions and uses,
 * footnote labels, explicit HTML/heading anchors, and same-body `#fragment`
 * links to those anchors.
 */
function namespaceEdits(
  source: string,
  root: Root,
  namespace: string,
  direction: Direction,
  includeHtml: boolean,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const anchors = new Set<string>();

  const relabel = (site: LabelSite | null) => {
    if (!site) return;
    const renamed = renameLabel(source.slice(site.start, site.end), namespace, direction);
    if (renamed !== null) edits.push({ start: site.start, end: site.end, text: renamed });
  };

  visitNodes(root, (node) => {
    const range = nodeRange(node);
    if (!range) return;
    switch (node.type) {
      case "definition":
      case "footnoteDefinition": {
        const open = source.indexOf("[", range.start);
        if (node.type === "footnoteDefinition") {
          const site = bracketLabel(source, open);
          if (site && source[site.start] === "^") relabel({ start: site.start + 1, end: site.end });
        } else {
          relabel(bracketLabel(source, open));
        }
        break;
      }
      case "footnoteReference": {
        const site = bracketLabel(source, range.start);
        if (site && source[site.start] === "^") relabel({ start: site.start + 1, end: site.end });
        break;
      }
      case "linkReference":
      case "imageReference": {
        const reference = node as LinkReference | ImageReference;
        const label = reference.label ?? reference.identifier;
        if (reference.referenceType === "full") {
          const site = trailingLabel(source, range);
          if (!site) break;
          const renamed = renameLabel(source.slice(site.start, site.end), namespace, direction);
          if (renamed === null) break;
          // A reader restores `[text][text]` to the shortcut form the writer expanded.
          const textSite = bracketLabel(
            source,
            node.type === "imageReference" ? range.start + 1 : range.start,
          );
          if (
            direction.kind === "remove" &&
            textSite &&
            source.slice(textSite.start, textSite.end).toLowerCase() === renamed.toLowerCase()
          ) {
            edits.push({ start: textSite.end + 1, end: range.end, text: "" });
          } else {
            edits.push({ start: site.start, end: site.end, text: renamed });
          }
        } else if (direction.kind === "add") {
          const renamed = `${namespace}${label}`;
          if (reference.referenceType === "collapsed") {
            edits.push({ start: range.end - 2, end: range.end, text: `[${renamed}]` });
          } else {
            edits.push({ start: range.end, end: range.end, text: `[${renamed}]` });
          }
        }
        break;
      }
      case "heading": {
        const line = source.slice(range.start, range.end);
        const match = HEADING_ANCHOR.exec(line);
        if (!match || match.index === undefined) break;
        const idStart = range.start + match.index + 2;
        const renamed = renameLabel(match[1]!, namespace, direction);
        if (renamed === null) break;
        anchors.add(direction.kind === "add" ? match[1]! : renamed);
        edits.push({ start: idStart, end: idStart + match[1]!.length, text: renamed });
        break;
      }
      case "html": {
        if (!includeHtml) break;
        const value = source.slice(range.start, range.end);
        for (const match of value.matchAll(HTML_ANCHOR_ATTRIBUTE)) {
          const attribute = attributeValue(match, false);
          const renamed = renameLabel(attribute.value, namespace, direction);
          if (renamed === null || attribute.value.length === 0) continue;
          anchors.add(direction.kind === "add" ? attribute.value : renamed);
          const valueStart = range.start + match.index! + attribute.offset;
          edits.push({
            start: valueStart,
            end: valueStart + attribute.value.length,
            text: renamed,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  if (anchors.size > 0) {
    visitNodes(root, (node) => {
      if (node.type === "html" && includeHtml) {
        // `href="#anchor"` inside raw HTML targets the same renamed anchors.
        const range = nodeRange(node);
        if (!range) return;
        const value = source.slice(range.start, range.end);
        for (const match of value.matchAll(HTML_FRAGMENT_REFERENCE)) {
          const attribute = attributeValue(match, true);
          const original =
            direction.kind === "add"
              ? attribute.value
              : renameLabel(attribute.value, namespace, direction);
          if (original === null || !anchors.has(original)) continue;
          const valueStart = range.start + match.index! + attribute.offset;
          edits.push({
            start: valueStart,
            end: valueStart + attribute.value.length,
            text: direction.kind === "add" ? `${namespace}${attribute.value}` : original,
          });
        }
        return;
      }
      if (node.type !== "link" && node.type !== "definition") return;
      const url = (node as Link | Definition).url;
      if (!url.startsWith("#")) return;
      const target = url.slice(1);
      const original =
        direction.kind === "add" ? target : renameLabel(target, namespace, direction);
      if (original === null || !anchors.has(original)) return;
      const range = nodeRange(node);
      if (!range) return;
      const position = source.lastIndexOf(`#${target}`, range.end);
      if (position < range.start) return;
      const renamed = direction.kind === "add" ? `${namespace}${target}` : original;
      edits.push({ start: position + 1, end: position + 1 + target.length, text: renamed });
    });
  }
  return edits;
}

/** Soft line breaks in text become hard breaks, as `remark-breaks` renders them in chat. */
function lineBreakEdits(source: string, root: Root): SourceEdit[] {
  const edits: SourceEdit[] = [];
  visitNodes(root, (node) => {
    if (node.type !== "text") return;
    const range = nodeRange(node);
    if (!range) return;
    for (let index = range.start; index < range.end; index += 1) {
      const character = source[index];
      if (character !== "\n" && character !== "\r") continue;
      if (character === "\n" && source[index - 1] === "\r") continue;
      edits.push({ start: index, end: index, text: "\\" });
    }
  });
  return edits;
}

function literalHtmlEdits(source: string, root: Root): SourceEdit[] {
  const edits: SourceEdit[] = [];
  visitNodes(root, (node) => {
    if (node.type !== "html") return;
    const range = nodeRange(node);
    if (!range) return;
    for (let index = range.start; index < range.end; index += 1) {
      const character = source[index];
      if (character === "<") edits.push({ start: index, end: index + 1, text: "&lt;" });
      else if (character === "&") edits.push({ start: index, end: index + 1, text: "&amp;" });
    }
  });
  return edits;
}

function markerEscapeEdits(
  source: string,
  root: Root,
  skip: ReadonlyArray<SourceEdit>,
): SourceEdit[] {
  const literal = literalRanges(root).toSorted((left, right) => left.start - right.start);
  const skippedStarts = new Set(
    skip.filter((edit) => edit.end === edit.start + 1).map((edit) => edit.start),
  );
  const edits: SourceEdit[] = [];
  let literalIndex = 0;
  let position = source.indexOf(STRUCTURE_MARKER_PREFIX);
  while (position >= 0) {
    while (literalIndex < literal.length && literal[literalIndex]!.end <= position) {
      literalIndex += 1;
    }
    const range = literal[literalIndex];
    if (
      !(range && position >= range.start && position < range.end) &&
      !skippedStarts.has(position)
    ) {
      edits.push({ start: position, end: position + 1, text: "&lt;" });
    }
    position = source.indexOf(STRUCTURE_MARKER_PREFIX, position + 1);
  }
  return edits;
}

const HTML_BLOCK_TERMINATORS: ReadonlyArray<{
  readonly start: RegExp;
  readonly end: (opening: string) => RegExp;
  readonly close: (opening: string) => string;
}> = [
  {
    start: /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/iu,
    end: (tag) => new RegExp(`</${tag}>`, "iu"),
    close: (tag) => `</${tag.toLowerCase()}>`,
  },
  { start: /^ {0,3}<!--/u, end: () => /-->/u, close: () => "-->" },
  { start: /^ {0,3}<\?/u, end: () => /\?>/u, close: () => "?>" },
  { start: /^ {0,3}<![A-Za-z]/u, end: () => />/u, close: () => ">" },
  { start: /^ {0,3}<!\[CDATA\[/u, end: () => /\]\]>/u, close: () => "]]>" },
];

/** A terminator that closes a top-level block left open at the end of the body. */
function closingSuffix(source: string, root: Root): string | null {
  const last = root.children.at(-1);
  if (!last) return null;
  const range = nodeRange(last);
  if (!range) return null;
  const block = source.slice(range.start, range.end);
  const lines = block.split(/\r?\n/u);
  if (last.type === "code" || last.type === "math") {
    const opening = /^ {0,3}(`{3,}|~{3,}|\${2,})/u.exec(lines[0] ?? "");
    if (!opening) return null;
    const fence = opening[1]!;
    const closing = new RegExp(`^ {0,3}[${fence[0]}]{${fence.length},}\\s*$`, "u");
    return lines.length > 1 && closing.test(lines.at(-1)!) ? null : fence;
  }
  if (last.type === "html") {
    for (const terminator of HTML_BLOCK_TERMINATORS) {
      const opening = terminator.start.exec(block);
      if (!opening) continue;
      const rest = block.slice(opening[0].length);
      const tag = opening[1] ?? "";
      return terminator.end(tag).test(rest) ? null : terminator.close(tag);
    }
  }
  return null;
}

const PROBE = "<!-- scient:probe -->";

/**
 * Parses a body as chat reads it: `\(…\)` and `\[…\]` are math (chat's
 * length-preserving delimiter normalization), so no edit ever lands inside
 * them. Offsets address the original text, which keeps its delimiters.
 */
function parseChatMarkdown(source: string): Root {
  return parseMarkdown(normalizeScientMathDelimiters(source));
}

/** Whether a structure marker written after `body` still parses as its own top-level block. */
export function bodyIsContained(body: string): boolean {
  const root = parseChatMarkdown(`${body}\n\n${PROBE}\n`);
  const last = root.children.at(-1);
  return last?.type === "html" && (last as Html).value === PROBE;
}

/**
 * Prepares one body for a shared conversation document. Deterministic: the
 * same input always produces the same Markdown.
 */
export function writeMessageBody(body: string, options: BodyWriteOptions): WrittenBody {
  const source = body.replace(/\r\n?/gu, "\n").replace(/\s+$/u, "");
  if (source.length === 0) return { markdown: "", containedAsLiteral: false };
  const root = parseChatMarkdown(source);
  const htmlEdits = options.rawHtml === "literal" ? literalHtmlEdits(source, root) : [];
  const edits = [
    ...(options.preserveLineBreaks ? lineBreakEdits(source, root) : []),
    ...htmlEdits,
    ...markerEscapeEdits(source, root, htmlEdits),
    ...namespaceEdits(
      source,
      root,
      options.namespace,
      { kind: "add" },
      options.rawHtml === "render",
    ),
  ];
  let markdown = applyEdits(source, edits);
  const suffix = closingSuffix(markdown, parseChatMarkdown(markdown));
  if (suffix !== null) markdown = `${markdown}\n${suffix}`;
  if (bodyIsContained(markdown)) return { markdown, containedAsLiteral: false };
  return { markdown: fencedBlock(source, "markdown"), containedAsLiteral: true };
}

/** Removes the namespace a writer added; the reader's inverse of `writeMessageBody`. */
export function readMessageBody(body: string, namespace: string): string {
  const root = parseChatMarkdown(body);
  return applyEdits(body, namespaceEdits(body, root, namespace, { kind: "remove" }, true));
}
