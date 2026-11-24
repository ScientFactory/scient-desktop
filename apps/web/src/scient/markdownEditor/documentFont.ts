import { isMap, isScalar, parseDocument } from "yaml";
import {
  DOCUMENT_FONT_SIZES,
  catalogueFont,
  type DocumentFontSize,
} from "@scientfactory/scient-markdown";

/**
 * Whole-document font settings of a Markdown file, kept as two keys of its
 * leading YAML front matter: `fontsize: 11pt` and `mainfont: Times New Roman`
 * (the names Pandoc and Quarto already read). Only a key whose setting the user
 * changed is rewritten; every other line, value and comment stays as it is.
 */

export interface MarkdownDocumentFont {
  readonly fontFamily: string | null;
  readonly fontSize: DocumentFontSize | null;
}

// The leading `---` block of a whole document.
export const LEADING_FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;
// Fence, body, closing fence, and whatever follows the block (kept untouched).
const YAML_FRONT_MATTER = /^(---[ \t]*)(\r?\n)([\s\S]*?)(?:\r?\n)?(---[ \t]*)(\s*)$/u;

const SIZE_KEY = "fontsize";
const FAMILY_KEY = "mainfont";

/** Keep source ranges so changing a setting preserves the rest of the YAML verbatim. */
function fontMapping(frontMatter: string) {
  const match = YAML_FRONT_MATTER.exec(frontMatter);
  if (!match) return null;
  const body = match[3] ?? "";
  const doc = parseDocument(body);
  if (
    doc.errors.length ||
    doc.warnings.length ||
    (doc.contents && (!isMap(doc.contents) || doc.contents.flow))
  )
    return null;
  const fields = new Map<
    string,
    { start: number; end: number; value: string; lineStart: number }
  >();
  let indent = "";
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || !pair.key.range || typeof pair.key.value !== "string") return null;
      const start = pair.key.range[0];
      const lineStart = body.lastIndexOf("\n", start - 1) + 1;
      indent = body.slice(lineStart, start);
      if (!/^ *$/u.test(indent)) return null;
      if (pair.key.value !== SIZE_KEY && pair.key.value !== FAMILY_KEY) continue;
      const value = pair.value;
      if (
        !isScalar(value) ||
        !value.range ||
        value.anchor ||
        value.tag ||
        /[\r\n]/u.test(body.slice(start, value.range[1])) ||
        ["BLOCK_FOLDED", "BLOCK_LITERAL"].includes(value.type ?? "")
      )
        return null;
      fields.set(pair.key.value, {
        start: value.range[0],
        end: value.range[1],
        value: String(value.value),
        lineStart,
      });
    }
  }
  return { fields, indent, body, match };
}

export function readMarkdownDocumentFont(frontMatter: string | null): MarkdownDocumentFont {
  const fields = frontMatter && fontMapping(frontMatter)?.fields;
  const size = fields ? fields.get(SIZE_KEY)?.value : null;
  const family = fields ? fields.get(FAMILY_KEY)?.value : null;
  return {
    fontSize: DOCUMENT_FONT_SIZES.find((candidate) => candidate === size) ?? null,
    fontFamily: family && catalogueFont(family) ? family : null,
  };
}

export function canWriteMarkdownDocumentFont(frontMatter: string | null): boolean {
  return frontMatter === null || fontMapping(frontMatter) !== null;
}

/**
 * The front matter block after applying `font`, or null when it would be empty
 * (the block is then removed); undefined when the block cannot be written safely.
 */
export function writeMarkdownDocumentFont(
  frontMatter: string | null,
  font: MarkdownDocumentFont,
): string | null | undefined {
  if (frontMatter === null) {
    const wanted = [
      ...(font.fontSize ? [`${SIZE_KEY}: ${font.fontSize}`] : []),
      ...(font.fontFamily ? [`${FAMILY_KEY}: ${font.fontFamily}`] : []),
    ];
    return wanted.length ? `---\n${wanted.join("\n")}\n---` : null;
  }
  const parsed = fontMapping(frontMatter);
  if (!parsed) return undefined;
  const { match, fields, indent } = parsed;
  const open = match[1]!;
  const eol = match[2]!;
  const after = match[5];
  let body = parsed.body;
  const current = readMarkdownDocumentFont(frontMatter);
  const changes: Array<{ from: number; to: number; text: string }> = [];
  const additions: string[] = [];
  for (const [key, before, wanted] of [
    [SIZE_KEY, current.fontSize, font.fontSize],
    [FAMILY_KEY, current.fontFamily, font.fontFamily],
  ] as const) {
    if (wanted === before) continue;
    const field = fields.get(key);
    if (!field) {
      if (wanted) additions.push(indent + key + ": " + wanted);
    } else if (wanted) {
      changes.push({ from: field.start, to: field.end, text: wanted });
    } else {
      const end = body.indexOf("\n", field.end);
      const tail = body.slice(field.end, end < 0 ? body.length : end).trim();
      changes.push({
        from: field.lineStart,
        to: end < 0 ? body.length : end + 1,
        text: tail ? indent + tail + (end < 0 ? "" : eol) : "",
      });
    }
  }
  for (const change of changes.sort((a, b) => b.from - a.from))
    body = body.slice(0, change.from) + change.text + body.slice(change.to);
  if (additions.length) {
    const trailing = /(?:\r?\n)*$/u.exec(body)![0];
    const at = body.length - trailing.length;
    body = body.slice(0, at) + (at ? eol : "") + additions.join(eol) + trailing;
  }
  if (!body.trim()) return null;
  const updated = open + eol + body + eol + match[4] + (after ?? "");
  return fontMapping(updated) ? updated : undefined;
}
