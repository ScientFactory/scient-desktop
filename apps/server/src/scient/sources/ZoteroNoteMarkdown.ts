import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];

/** How long "My note" may be; what does not fit is left out by whole blocks and listed. */
export const ZOTERO_NOTE_CHARACTERS = 100_000;
/** A note's name in Zotero's list is its first line, cut at this length. */
const TITLE_CHARACTERS = 120;

interface Block {
  readonly kind: "heading" | "paragraph" | "other";
  readonly text: string;
}

interface Conversion {
  images: number;
}

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "dl",
  "dd",
  "dt",
  "figure",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
const SKIPPED_TAGS: ReadonlySet<string> = new Set(["script", "style", "head", "title", "template"]);
const MARKS: Readonly<Record<string, string>> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  s: "~~",
  strike: "~~",
  del: "~~",
};

const isElement = (node: Node): node is Element => "tagName" in node;
const isText = (node: Node): node is DefaultTreeAdapterMap["textNode"] => node.nodeName === "#text";
const attribute = (element: Element, name: string) =>
  element.attrs.find((entry) => entry.name === name)?.value;
const hasClass = (element: Element, name: string) =>
  (attribute(element, "class") ?? "").split(/\s+/u).includes(name);

/** The text of a subtree as written, for code and math, where nothing is Markdown. */
function rawText(node: Node): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return "";
  if (node.tagName === "br") return "\n";
  return node.childNodes.map(rawText).join("");
}

const BARE_ADDRESS = /https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]}']/gu;

/**
 * A character a person typed stays that character: Markdown's own marks are escaped. A web
 * address written out is kept whole between `<` and `>`, where an escape would break it.
 */
function escapeText(text: string): string {
  const escaped = (part: string) =>
    part.replace(/[\\`*_[\]<$~|]/gu, "\\$&").replace(/&(?=#?[A-Za-z0-9]+;)/gu, "\\&");
  let out = "";
  let at = 0;
  for (const match of text.matchAll(BARE_ADDRESS)) {
    out += `${escaped(text.slice(at, match.index))}<${match[0]}>`;
    at = match.index + match[0].length;
  }
  return out + escaped(text.slice(at));
}

/** The start of a line that would otherwise read as a heading, quote, list item or rule. */
function escapeLineStart(line: string): string {
  if (/^(?:#{1,6}(?:\s|$)|>|[-+](?:\s|$)|[-=]+\s*$)/u.test(line)) return `\\${line}`;
  return line.replace(/^(\d{1,9})([.)])(?=\s|$)/u, "$1\\$2");
}

function codeSpan(text: string): string {
  const code = text.replace(/\s+/gu, " ");
  if (!code.trim()) return code;
  const fence = "`".repeat(longestRun(code, "`") + 1);
  const padded = code.startsWith("`") || code.endsWith("`") ? ` ${code} ` : code;
  return `${fence}${padded}${fence}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let run = 0;
  for (const current of text) {
    run = current === character ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** A link target Markdown reads back whole, whatever characters it has. */
function linkTarget(href: string): string {
  const target = href.trim().replace(/\s/gu, "%20").replace(/</gu, "%3C").replace(/>/gu, "%3E");
  return /[()]/u.test(target) ? `<${target}>` : target;
}

/** A mark around text, with the spaces at its ends outside it, where Markdown needs them. */
function marked(mark: string, inner: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(inner);
  const body = match?.[2] ?? "";
  return body ? `${match?.[1] ?? ""}${mark}${body}${mark}${match?.[3] ?? ""}` : inner;
}

function inline(
  nodes: ReadonlyArray<Node>,
  state: Conversion,
  active: ReadonlySet<string>,
): string {
  let out = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (isText(node)) {
      out += escapeText(node.value.replace(/\s+/gu, " "));
      continue;
    }
    if (!isElement(node) || SKIPPED_TAGS.has(node.tagName)) continue;
    const tag = node.tagName;
    if (tag === "br") out += "\n";
    else if (tag === "img") state.images += 1;
    else if (tag === "code") out += codeSpan(rawText(node));
    else if (hasClass(node, "math")) out += rawText(node).trim();
    else if (tag === "a") out += link(node, state, active);
    else if (MARKS[tag] !== undefined) {
      const mark = MARKS[tag];
      // Neighbours with the same mark are one run, so their marks never meet as `****`.
      const run = [...node.childNodes];
      while (isSameMark(nodes[index + 1], mark)) {
        index += 1;
        run.push(...(nodes[index] as Element).childNodes);
      }
      const inner = inline(run, state, new Set([...active, mark]));
      out += active.has(mark) ? inner : marked(mark, inner);
    } else out += inline(node.childNodes, state, active);
  }
  return out;
}

function isSameMark(node: Node | undefined, mark: string): boolean {
  return node !== undefined && isElement(node) && MARKS[node.tagName] === mark;
}

function link(element: Element, state: Conversion, active: ReadonlySet<string>): string {
  const href = attribute(element, "href")?.trim();
  const label = inline(element.childNodes, state, active)
    .replace(/\s*\n\s*/gu, " ")
    .trim();
  if (!href) return label;
  const plain = rawText(element).trim();
  // A link shown as its own address is written the way Markdown writes one.
  if (!label || plain === href)
    return /[\s<>]/u.test(href) ? `[${label || href}](${linkTarget(href)})` : `<${href}>`;
  return `[${label}](${linkTarget(href)})`;
}

/** Inline text as the lines of one or more paragraphs: two line breaks in a row part them. */
function paragraphs(text: string): ReadonlyArray<string> {
  return text
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/ {2,}/gu, " ")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim().split("\n").map(escapeLineStart).join("\n"))
    .filter(Boolean);
}

const indented = (text: string, indent: string) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || !line ? line : `${indent}${line}`))
    .join("\n");

function list(element: Element, state: Conversion): string {
  const ordered = element.tagName === "ol";
  const start = Number.parseInt(attribute(element, "start") ?? "1", 10);
  let number = Number.isFinite(start) ? start : 1;
  const items: string[] = [];
  for (const child of element.childNodes) {
    if (!isElement(child) || child.tagName !== "li") continue;
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    const parts = blocks(child.childNodes, state);
    // A list right under an item's text is that item's sublist; other blocks stand apart.
    const body = parts.reduce(
      (text, part, index) =>
        index === 0
          ? part.text
          : `${text}${/^(?:- |\d+\. )/u.test(part.text) ? "\n" : "\n\n"}${part.text}`,
      "",
    );
    items.push(`${marker}${indented(body, " ".repeat(marker.length))}`);
  }
  return items.join("\n");
}

function table(element: Element, state: Conversion): string {
  const rows: string[][] = [];
  const visit = (node: Node) => {
    if (!isElement(node)) return;
    if (node.tagName === "tr") {
      rows.push(
        node.childNodes
          .filter((cell): cell is Element => isElement(cell) && /^t[dh]$/u.test(cell.tagName))
          .map((cell) =>
            blocks(cell.childNodes, state)
              .map((block) => block.text)
              .join(" ")
              .replace(/\s*\n\s*/gu, " "),
          ),
      );
    } else if (node.tagName !== "table" || node === element) node.childNodes.forEach(visit);
  };
  visit(element);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const line = (cells: ReadonlyArray<string>) =>
    `| ${Array.from({ length: width }, (_, at) => cells[at] ?? "").join(" | ")} |`;
  const [header, ...body] = rows;
  return [
    line(header ?? []),
    line(Array.from({ length: width }, () => "---")),
    ...body.map(line),
  ].join("\n");
}

function codeBlock(element: Element): string {
  const code = rawText(element).replace(/\r\n?/gu, "\n").replace(/\n$/u, "");
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  return `${fence}\n${code}\n${fence}`;
}

function blocks(nodes: ReadonlyArray<Node>, state: Conversion): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];
  const flush = () => {
    for (const text of paragraphs(inline(run, state, new Set())))
      out.push({ kind: "paragraph", text });
    run = [];
  };
  const other = (text: string) => {
    if (text) out.push({ kind: "other", text });
  };
  for (const node of nodes) {
    if (!isElement(node) || !BLOCK_TAGS.has(node.tagName)) {
      if (!isElement(node) || !SKIPPED_TAGS.has(node.tagName)) run.push(node);
      continue;
    }
    flush();
    const tag = node.tagName;
    if (tag === "p") {
      run = [...node.childNodes];
      flush();
    } else if (/^h[1-6]$/u.test(tag)) {
      const text = inline(node.childNodes, state, new Set())
        .replace(/\s*\n\s*/gu, " ")
        .trim();
      if (text) out.push({ kind: "heading", text: `${"#".repeat(Number(tag[1]))} ${text}` });
    } else if (tag === "blockquote") {
      other(
        blocks(node.childNodes, state)
          .map((block) => block.text)
          .join("\n\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    } else if (tag === "pre") {
      // Zotero writes display math as a block of `$$…$$`, which Markdown reads as it is.
      other(hasClass(node, "math") ? rawText(node).trim() : codeBlock(node));
    } else if (tag === "ul" || tag === "ol") other(list(node, state));
    else if (tag === "table") other(table(node, state));
    else if (tag === "hr") other("---");
    else out.push(...blocks(node.childNodes, state));
  }
  flush();
  return out;
}

/** The first line of a note's text, as Zotero names the note in its list. */
function noteTitle(nodes: ReadonlyArray<Node>): string {
  const lines = (node: Node): string => {
    if (isText(node)) return node.value;
    if (!isElement(node) || SKIPPED_TAGS.has(node.tagName)) return "";
    const inner = node.childNodes.map(lines).join("");
    return node.tagName === "br" || BLOCK_TAGS.has(node.tagName) ? `${inner}\n` : inner;
  };
  const first =
    nodes
      .map(lines)
      .join("")
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find(Boolean) ?? "";
  return first.length > TITLE_CHARACTERS ? `${first.slice(0, TITLE_CHARACTERS - 1)}…` : first;
}

/**
 * One Zotero note (HTML) as Markdown blocks. Headings, links, lists, quotes, tables, code,
 * bold, italic and strikethrough are kept; an embedded citation becomes its text; images are
 * left out and counted. Colour, underline, superscript and alignment have no Markdown.
 */
function zoteroNoteBlocks(html: string): {
  readonly blocks: ReadonlyArray<Block>;
  readonly title: string;
  readonly images: number;
} {
  const fragment = parseFragment(html);
  const state: Conversion = { images: 0 };
  return {
    blocks: blocks(fragment.childNodes, state),
    title: noteTitle(fragment.childNodes),
    images: state.images,
  };
}

/** A note's blocks under its first line as a heading, for a reference with several notes. */
function underHeading(note: ReturnType<typeof zoteroNoteBlocks>): ReadonlyArray<string> {
  const [first, ...rest] = note.blocks;
  const others = rest.map((block) => block.text);
  if (first?.kind === "heading") return [first.text.replace(/^#+/u, "##"), ...others];
  const [line = "", ...lines] = first?.kind === "paragraph" ? first.text.split("\n") : [];
  if (line && line.length <= TITLE_CHARACTERS) {
    return [`## ${line}`, ...(lines.length > 0 ? [lines.join("\n")] : []), ...others];
  }
  return [`## ${escapeText(note.title)}`, ...note.blocks.map((block) => block.text)];
}

/**
 * A reference's Zotero notes as one Markdown note. Several notes each stand under their first
 * line as a heading, in the order Zotero lists them (by that line). What does not fit in a
 * note is left out by whole blocks, and `cut` says so.
 */
export function zoteroNotesMarkdown(
  notes: ReadonlyArray<{ readonly itemKey: string; readonly html: string }>,
): { readonly markdown: string | null; readonly images: number; readonly cut: boolean } {
  const converted = notes
    .map((note) => ({ itemKey: note.itemKey, ...zoteroNoteBlocks(note.html) }))
    .toSorted(
      (left, right) =>
        left.title.localeCompare(right.title, "en", { numeric: true, sensitivity: "base" }) ||
        left.itemKey.localeCompare(right.itemKey),
    );
  const images = converted.reduce((sum, note) => sum + note.images, 0);
  const written = converted.filter((note) => note.blocks.length > 0);
  const all =
    written.length === 1
      ? written[0]!.blocks.map((block) => block.text)
      : written.flatMap(underHeading);
  let markdown = "";
  let cut = false;
  for (const block of all) {
    const next = markdown ? `${markdown}\n\n${block}` : block;
    if (next.length > ZOTERO_NOTE_CHARACTERS) {
      cut = true;
      // One block longer than a note: its start arrives, cut where a word ends.
      if (!markdown) markdown = block.slice(0, ZOTERO_NOTE_CHARACTERS).replace(/\s+\S*$/u, "");
      break;
    }
    markdown = next;
  }
  return { markdown: markdown || null, images, cut };
}
