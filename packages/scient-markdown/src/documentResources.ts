import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

const HTML_IMAGE_SOURCE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;
const MAX_TITLE_LENGTH = 512;
const FRONT_MATTER_KINDS = ["yaml", "toml"] as const;

/**
 * The rich editor's front matter grammar: a YAML (`---`) or TOML (`+++`)
 * block at the very start of a file is metadata, not content. Renderers that
 * parse with unified register both extensions so the block never prints.
 */
export const MARKDOWN_FRONT_MATTER_EXTENSIONS = {
  syntax: frontmatter([...FRONT_MATTER_KINDS]),
  fromMarkdown: frontmatterFromMarkdown([...FRONT_MATTER_KINDS]),
};

/** What document export needs to know about one Markdown source before rendering it. */
export interface MarkdownDocumentInspection {
  /** Image destinations exactly as authored, in document order, without duplicates. */
  readonly imageReferences: ReadonlyArray<string>;
  /**
   * The document title: the front matter's `title`, otherwise the plain text
   * of the first level-one heading.
   */
  readonly title: string | null;
  /** Raw HTML reaches the document page only through its sanitizer. */
  readonly hasRawHtml: boolean;
}

/** Unique Mermaid code fences in source order, using the document parser. */
export function mermaidSourcesInMarkdown(source: string): ReadonlyArray<string> {
  const found = new Set<string>();
  const visit = (node: Nodes) => {
    if (node.type === "code" && node.lang === "mermaid") found.add(node.value);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parse(source));
  return [...found];
}

function parse(source: string): Root {
  return fromMarkdown(source, {
    extensions: [MARKDOWN_FRONT_MATTER_EXTENSIONS.syntax, gfm(), math()],
    mdastExtensions: [
      MARKDOWN_FRONT_MATTER_EXTENSIONS.fromMarkdown,
      gfmFromMarkdown(),
      mathFromMarkdown(),
    ],
  });
}

function boundedTitle(text: string): string | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, MAX_TITLE_LENGTH) : null;
}

/** A quoted scalar's text, or null when the quoting is not one this reader understands. */
function unquote(value: string): string | null {
  if (value.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"/u.exec(value)?.[0];
    if (quoted === undefined) return null;
    try {
      return JSON.parse(quoted) as string;
    } catch {
      return quoted.slice(1, -1);
    }
  }
  if (value.startsWith("'")) {
    const quoted = /^'(?:[^']|'')*'/u.exec(value)?.[0];
    return quoted === undefined ? null : quoted.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/u, "");
}

/**
 * The top-level `title` of a YAML or TOML front matter block, when it is a
 * single-line string. Block scalars, nested keys, and TOML tables are ignored.
 */
function frontMatterTitle(kind: string, value: string): string | null {
  for (const line of value.split(/\r?\n/u)) {
    if (kind === "toml" && /^\s*\[/u.test(line)) return null;
    const match = (
      kind === "yaml" ? /^title[ \t]*:[ \t]*(.*)$/u : /^title[ \t]*=[ \t]*(.*)$/u
    ).exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw === "" || /^[|>]/u.test(raw)) return null;
    const text = unquote(raw);
    return text === null ? null : boundedTitle(text);
  }
  return null;
}

function plainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") {
    return node.type === "html" ? "" : node.value;
  }
  if ("children" in node) return node.children.map((child) => plainText(child)).join("");
  return "";
}

/**
 * Parses Markdown with the same CommonMark, GFM, and math grammar as the rich
 * editor and reports image destinations (inline, reference-style, and raw
 * `<img>`), the title, and whether raw HTML is present. Destinations inside
 * code are never reported because they are not images.
 */
export function inspectMarkdownDocument(source: string): MarkdownDocumentInspection {
  const tree = parse(source);
  const definitions = new Map<string, string>();
  const references: string[] = [];
  const seen = new Set<string>();
  // TOML front matter is not in mdast's node map, so the leading node is read structurally.
  const leading: { readonly type: string; readonly value?: unknown } | undefined = tree.children[0];
  let title =
    (leading?.type === "yaml" || leading?.type === "toml") && typeof leading.value === "string"
      ? frontMatterTitle(leading.type, leading.value)
      : null;
  let hasRawHtml = false;
  const add = (destination: string | null | undefined) => {
    const trimmed = destination?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    references.push(trimmed);
  };
  const collectDefinitions = (node: Nodes) => {
    if (node.type === "definition") {
      const key = node.identifier.toLowerCase();
      if (!definitions.has(key)) definitions.set(key, node.url);
    }
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(tree);
  const visit = (node: Nodes) => {
    switch (node.type) {
      case "image":
        add(node.url);
        break;
      case "imageReference":
        add(definitions.get(node.identifier.toLowerCase()));
        break;
      case "html": {
        hasRawHtml = true;
        for (const match of node.value.matchAll(HTML_IMAGE_SOURCE)) {
          add(match[1] ?? match[2] ?? match[3]);
        }
        break;
      }
      case "heading":
        if (title === null && node.depth === 1) title = boundedTitle(plainText(node));
        break;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return { imageReferences: references, title, hasRawHtml };
}

interface DestinationEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Finds `authored` (bare or `<bracketed>`) after `marker` inside one node's source span. */
function locateDestination(
  source: string,
  span: { readonly start: number; readonly end: number },
  marker: string,
  authored: string,
  fromEnd: boolean,
): { readonly start: number; readonly end: number } | null {
  const slice = source.slice(span.start, span.end);
  for (const candidate of [`${marker}<${authored}>`, `${marker}${authored}`]) {
    const index = fromEnd ? slice.lastIndexOf(candidate) : slice.indexOf(candidate);
    if (index < 0) continue;
    const bracketed = candidate.startsWith(`${marker}<`);
    const start = span.start + index + marker.length + (bracketed ? 1 : 0);
    return { start, end: start + authored.length };
  }
  return null;
}

/**
 * Rewrites image destinations in place, leaving every other byte of the
 * source untouched. `replace` returns the new destination, or null to keep
 * one. Destinations are located inside the parsed node's own source span, so
 * matching text in code, prose, or other nodes is never touched. A destination
 * written with escapes or entities that cannot be located verbatim is kept and
 * reported in `unlocated`.
 */
export function rewriteMarkdownImageDestinations(
  source: string,
  replace: (destination: string) => string | null,
): { readonly markdown: string; readonly unlocated: ReadonlyArray<string> } {
  const tree = parse(source);
  const referencedDefinitions = new Set<string>();
  const edits: DestinationEdit[] = [];
  const unlocated: string[] = [];
  const span = (node: Nodes) =>
    node.position?.start.offset === undefined || node.position.end.offset === undefined
      ? null
      : { start: node.position.start.offset, end: node.position.end.offset };
  const edit = (node: Nodes, destination: string, marker: string, fromEnd: boolean): void => {
    const trimmed = destination.trim();
    const replacement = replace(trimmed);
    if (replacement === null) return;
    const nodeSpan = span(node);
    const located = nodeSpan && locateDestination(source, nodeSpan, marker, trimmed, fromEnd);
    if (!located) {
      unlocated.push(trimmed);
      return;
    }
    edits.push({ ...located, replacement });
  };
  const collectReferences = (node: Nodes) => {
    if (node.type === "imageReference") referencedDefinitions.add(node.identifier.toLowerCase());
    if ("children" in node) node.children.forEach(collectReferences);
  };
  collectReferences(tree);
  const visit = (node: Nodes) => {
    switch (node.type) {
      case "image":
        // The destination follows the label, so search from the end of the span.
        edit(node, node.url, "](", true);
        break;
      case "definition":
        if (referencedDefinitions.has(node.identifier.toLowerCase())) {
          const nodeSpan = span(node);
          const colon = nodeSpan ? source.slice(nodeSpan.start, nodeSpan.end).indexOf("]:") : -1;
          if (nodeSpan && colon >= 0) {
            const whitespace = /^[ \t]*(?:\r?\n[ \t]*)?/u.exec(
              source.slice(nodeSpan.start + colon + 2, nodeSpan.end),
            )?.[0];
            edit(node, node.url, `]:${whitespace ?? ""}`, false);
          } else {
            unlocated.push(node.url);
          }
        }
        break;
      case "html":
        for (const match of node.value.matchAll(HTML_IMAGE_SOURCE)) {
          const destination = match[1] ?? match[2] ?? match[3];
          const nodeSpan = span(node);
          if (!destination || !nodeSpan) continue;
          const replacement = replace(destination.trim());
          if (replacement === null) continue;
          // The html node's value is its exact source text.
          const valueStart = source.indexOf(node.value, nodeSpan.start);
          const attributeStart =
            match.index + match[0].length - destination.length - (match[3] === undefined ? 1 : 0);
          if (valueStart < 0) {
            unlocated.push(destination);
            continue;
          }
          const start = valueStart + attributeStart;
          edits.push({ start, end: start + destination.length, replacement });
        }
        break;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  let markdown = source;
  for (const change of edits.toSorted((left, right) => right.start - left.start)) {
    markdown = `${markdown.slice(0, change.start)}${change.replacement}${markdown.slice(change.end)}`;
  }
  return { markdown, unlocated };
}

/**
 * Resolves an authored destination against the Markdown file's own directory,
 * as the rich editor does. Absolute paths, schemes, and destinations that climb
 * above the workspace root are not workspace resources and return null.
 */
export function resolveMarkdownDocumentRelativePath(
  documentRelativePath: string,
  destination: string,
): string | null {
  const suffixStart = destination.search(/[?#]/u);
  const encoded = suffixStart < 0 ? destination : destination.slice(0, suffixStart);
  let pathname: string;
  try {
    pathname = decodeURIComponent(encoded).replaceAll("\\", "/");
  } catch {
    return null;
  }
  if (
    !pathname ||
    pathname.startsWith("/") ||
    pathname.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/iu.test(pathname)
  ) {
    return null;
  }
  const segments = documentRelativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of pathname.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
