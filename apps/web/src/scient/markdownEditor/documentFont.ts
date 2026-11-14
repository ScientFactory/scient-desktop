import { DOCUMENT_FONT_SIZES, type DocumentFontSize } from "@scientfactory/scient-markdown";
import { FONT_FAMILIES, type FontFamilyName } from "../writing/fontChoices";

/**
 * Whole-document font settings of a Markdown file, kept as two keys of its
 * leading YAML front matter (`font-size: 11pt`, `font-family: serif`). The
 * sizes match the LaTeX Document settings card.
 */

export interface MarkdownDocumentFont {
  readonly fontFamily: FontFamilyName | null;
  readonly fontSize: DocumentFontSize | null;
}

// The leading `---` block of a whole document.
export const LEADING_FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;
// Fence, body, closing fence, and whatever follows the block (kept untouched).
const YAML_FRONT_MATTER = /^(---[ \t]*)(\r?\n)([\s\S]*?)(?:\r?\n)?(---[ \t]*)(\s*)$/u;
const FONT_KEYS = /^font-(?:size|family)[ \t]*:/u;

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

function keyValue(lines: readonly string[], key: string): string | null {
  const line = lines.find(
    (candidate) => candidate.startsWith(`${key}:`) || candidate.startsWith(`${key} :`),
  );
  return line === undefined ? null : unquote(line.slice(line.indexOf(":") + 1));
}

export function readMarkdownDocumentFont(frontMatter: string | null): MarkdownDocumentFont {
  const match = frontMatter === null ? null : YAML_FRONT_MATTER.exec(frontMatter);
  const lines = match?.[3]?.split(/\r?\n/u) ?? [];
  const size = keyValue(lines, "font-size");
  const family = keyValue(lines, "font-family");
  return {
    fontSize: DOCUMENT_FONT_SIZES.find((candidate) => candidate === size) ?? null,
    fontFamily: FONT_FAMILIES.find((candidate) => candidate.name === family)?.name ?? null,
  };
}

/**
 * The front matter block after applying `font`, or null when it would be
 * empty (the block is then removed). Other keys and the text around the block
 * are kept as they are; undefined when the block is not YAML.
 */
export function writeMarkdownDocumentFont(
  frontMatter: string | null,
  font: MarkdownDocumentFont,
): string | null | undefined {
  const wanted = [
    ...(font.fontSize ? [`font-size: ${font.fontSize}`] : []),
    ...(font.fontFamily ? [`font-family: ${font.fontFamily}`] : []),
  ];
  if (frontMatter === null) return wanted.length ? `---\n${wanted.join("\n")}\n---` : null;
  const match = YAML_FRONT_MATTER.exec(frontMatter);
  if (!match) return undefined;
  const [, open, eol, body = "", close, after = ""] = match;
  // The font keys go after the last other key; blank lines inside the block are kept.
  const others = body.split(/\r?\n/u).filter((line) => !FONT_KEYS.test(line));
  const kept = others.every((line) => line === "") ? [] : others;
  if (wanted.length === 0 && kept.length === 0) return null;
  const insertAt = kept.findLastIndex((line) => line !== "") + 1;
  const lines = [...kept.slice(0, insertAt), ...wanted, ...kept.slice(insertAt)];
  const newline = eol ?? "\n";
  return `${open}${newline}${lines.join(newline)}${newline}${close}${after}`;
}
