import type { ScientSourceCreator } from "./model.ts";

const SCIENT_CITATION_KEY_MAX_LENGTH = 100;
const GENERATED_PART_MAX_LENGTH = 24;
export const CITATION_KEY_SYNTAX_MESSAGE =
  "Use letters, digits and _ : . - in the citation key, starting and ending with a letter, digit or _.";

// What Scient's Markdown `[@key]` reader, Pandoc, BibTeX and biber all accept.
const CITATION_KEY_PATTERN = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_:.-]*[\p{L}\p{N}_])?$/u;
const CITATION_KEY_INVALID_CHARACTERS = /[^\p{L}\p{N}_:.-]+/gu;

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "why",
  "with",
]);

const ASCII_FOLDS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
};

export function isValidCitationKey(key: string): boolean {
  return key.length <= SCIENT_CITATION_KEY_MAX_LENGTH && CITATION_KEY_PATTERN.test(key);
}

export function citationKeyComparisonValue(key: string): string {
  return key.normalize("NFC").toLowerCase();
}

/**
 * Keeps a key brought from Zotero, Better BibTeX or a `.bib` file. Characters
 * that Pandoc or BibTeX cannot read are dropped; nothing usable returns null.
 */
export function normalizeImportedCitationKey(value: string | null | undefined): string | null {
  const trimmed = value?.normalize("NFC").trim() ?? "";
  if (!trimmed) return null;
  if (isValidCitationKey(trimmed)) return trimmed;
  const cleaned = trimmed
    .replace(CITATION_KEY_INVALID_CHARACTERS, "")
    .replace(/^[:.-]+|[:.-]+$/gu, "")
    .slice(0, SCIENT_CITATION_KEY_MAX_LENGTH)
    .replace(/[:.-]+$/gu, "");
  return cleaned && isValidCitationKey(cleaned) ? cleaned : null;
}

/** Reads a Better BibTeX `Citation Key:` line from a Zotero `extra` field. */
export function citationKeyFromZoteroExtra(extra: string | null | undefined): string | null {
  const match = extra?.match(/^\s*citation key:\s*(\S+)\s*$/imu);
  return normalizeImportedCitationKey(match?.[1]);
}

function asciiWord(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/gu, (character) => ASCII_FOLDS[character] ?? "")
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, GENERATED_PART_MAX_LENGTH);
}

function authorPart(creators: ReadonlyArray<ScientSourceCreator>): string {
  const creator =
    creators.find((candidate) => candidate.creatorType === "author") ?? creators[0] ?? null;
  if (!creator) return "";
  if (creator.familyName?.trim()) return asciiWord(creator.familyName);
  const literal = creator.literalName?.trim().split(/\s+/u)[0];
  if (literal) return asciiWord(literal);
  return asciiWord(creator.givenName ?? "");
}

function titlePart(title: string | null): string {
  if (!title) return "";
  for (const raw of title.split(/[\s\-–—:;,.!?/()[\]{}"“”'‘’]+/u)) {
    const word = asciiWord(raw);
    if (word && !TITLE_STOPWORDS.has(word)) return word;
  }
  return "";
}

/** Author, year and first significant title word, e.g. `smith2020deep`. */
export function generateCitationKeyBase(input: {
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
  readonly title: string | null;
}): string {
  const author = authorPart(input.creators) || "anon";
  const year = input.issuedYear === null ? "" : String(input.issuedYear);
  return `${author}${year}${titlePart(input.title)}`;
}

function suffix(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

/** Adds `a`, `b`, … `z`, `aa` until the key is free. Keys compare case-insensitively. */
export function uniqueCitationKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(citationKeyComparisonValue(base))) return base;
  const stem = base.slice(0, SCIENT_CITATION_KEY_MAX_LENGTH - 4);
  for (let index = 0; ; index += 1) {
    const key = `${stem}${suffix(index)}`;
    if (!taken.has(citationKeyComparisonValue(key))) return key;
  }
}

export function takenCitationKeys(
  records: ReadonlyArray<{ readonly sourceId: string; readonly citationKey?: string }>,
  exceptSourceId?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const record of records) {
    if (record.sourceId === exceptSourceId || !record.citationKey) continue;
    taken.add(citationKeyComparisonValue(record.citationKey));
  }
  return taken;
}

/**
 * The key a new source gets: its imported key when it has one, otherwise a
 * generated author-year-word key, with a suffix when another source has it.
 * Keys never change on their own afterwards; only a deliberate rename does.
 */
export function assignCitationKey(input: {
  readonly preferred?: string | null | undefined;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
  readonly title: string | null;
  readonly taken: ReadonlySet<string>;
}): string {
  const base = normalizeImportedCitationKey(input.preferred) ?? generateCitationKeyBase(input);
  return uniqueCitationKey(base, input.taken);
}

export function citationKeyValidationMessage(
  key: string,
  taken: ReadonlySet<string>,
): string | null {
  if (!isValidCitationKey(key)) {
    return CITATION_KEY_SYNTAX_MESSAGE;
  }
  if (taken.has(citationKeyComparisonValue(key))) {
    return "Another source already uses this citation key.";
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function renameInMarkdownText(text: string, from: string, to: string): string {
  // A key follows the start, space, `[`, `;`, `(` or `-`; an e-mail address does not.
  const pattern = new RegExp(
    `(^|[\\s\\[;(-])@${escapeRegExp(from)}(?![\\p{L}\\p{N}_]|[:.#-][\\p{L}\\p{N}_])`,
    "gu",
  );
  // Inline code keeps its text.
  return text
    .split(/(`+[^`]*`+)/u)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, `$1@${to}`)))
    .join("");
}

/**
 * Renames a citation key where a document cites it: `[@key]` and `@key` in
 * Markdown outside code, the key lists of `\cite`-family commands in LaTeX.
 */
export function renameCitationKeyInDocument(
  kind: "markdown" | "latex",
  text: string,
  from: string,
  to: string,
): string {
  if (kind === "latex") {
    return text.replace(
      /(\\[A-Za-z]*cite[A-Za-z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{)([^{}]*)\}/gu,
      (match, command: string, keys: string) => {
        const items = keys.split(",");
        if (!items.some((item) => item.trim() === from)) return match;
        return `${command}${items.map((item) => (item.trim() === from ? item.replace(from, to) : item)).join(",")}}`;
      },
    );
  }
  let fence: string | null = null;
  return text
    .split(/(?<=\n)/u)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
      if (fence !== null) {
        if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (marker !== null) {
        fence = marker;
        return line;
      }
      return renameInMarkdownText(line, from, to);
    })
    .join("");
}
