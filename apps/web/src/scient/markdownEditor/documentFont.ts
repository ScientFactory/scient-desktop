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

interface KeyLine {
  readonly index: number;
  /** The value without quotes and trailing comment; null when it spans several lines. */
  readonly value: string | null;
  readonly comment: string;
}

function findKey(lines: readonly string[], key: string): KeyLine | null {
  const index = lines.findIndex((line) => new RegExp(`^${key}[ \\t]*:`, "u").test(line));
  if (index < 0) return null;
  const line = lines[index]!;
  const rest = line.slice(line.indexOf(":") + 1);
  const comment = /\s+#.*$/u.exec(rest)?.[0] ?? "";
  const text = rest.slice(0, rest.length - comment.length).trim();
  const continues = /^\s+\S/u.test(lines[index + 1] ?? "") || /^[|>]/u.test(text) || text === "";
  return {
    index,
    value: continues ? null : text.replace(/^(["'])(.*)\1$/u, "$2"),
    comment,
  };
}

function bodyLines(frontMatter: string): string[] | null {
  const body = YAML_FRONT_MATTER.exec(frontMatter)?.[3];
  return body === undefined ? null : body.split(/\r?\n/u);
}

export function readMarkdownDocumentFont(frontMatter: string | null): MarkdownDocumentFont {
  const lines = frontMatter === null ? [] : (bodyLines(frontMatter) ?? []);
  const size = findKey(lines, SIZE_KEY)?.value ?? null;
  const family = findKey(lines, FAMILY_KEY)?.value ?? null;
  return {
    fontSize: DOCUMENT_FONT_SIZES.find((candidate) => candidate === size) ?? null,
    fontFamily: family !== null && catalogueFont(family) !== null ? family : null,
  };
}

/**
 * Whether the settings can be written: no front matter yet, or a YAML block whose
 * font keys are single-line values. Otherwise the card stays off and the file is left alone.
 */
export function canWriteMarkdownDocumentFont(frontMatter: string | null): boolean {
  if (frontMatter === null) return true;
  const lines = bodyLines(frontMatter);
  if (lines === null) return false;
  return [SIZE_KEY, FAMILY_KEY].every((key) => {
    const found = findKey(lines, key);
    return found === null || found.value !== null;
  });
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
  const match = YAML_FRONT_MATTER.exec(frontMatter);
  if (!match || !canWriteMarkdownDocumentFont(frontMatter)) return undefined;
  const [, open, eol, , close, after = ""] = match;
  const newline = eol ?? "\n";
  const lines = [...(bodyLines(frontMatter) ?? [])];
  const current = readMarkdownDocumentFont(frontMatter);
  const edits: ReadonlyArray<readonly [string, string | null, string | null]> = [
    [SIZE_KEY, current.fontSize, font.fontSize],
    [FAMILY_KEY, current.fontFamily, font.fontFamily],
  ];
  for (const [key, before, wanted] of edits) {
    if (before === wanted) continue;
    const found = findKey(lines, key);
    if (wanted === null) {
      if (found) lines.splice(found.index, 1);
    } else if (found) {
      lines[found.index] = `${key}: ${wanted}${found.comment}`;
    } else {
      // A new key goes after the last other key; blank lines inside the block are kept.
      lines.splice(lines.findLastIndex((line) => line !== "") + 1, 0, `${key}: ${wanted}`);
    }
  }
  if (lines.every((line) => line === "")) return null;
  return `${open}${newline}${lines.join(newline)}${newline}${close}${after}`;
}
