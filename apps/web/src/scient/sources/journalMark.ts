/**
 * A journal's generated mark: up to four letters from its name and a tone from its title, made
 * from the row alone, with no lookup. It is a cue, not an identifier: two journals may share one.
 */

const MAX_GRAPHEMES = 4;

const STOPWORDS = new Set([
  // English
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  // French
  "de",
  "des",
  "du",
  "et",
  "la",
  "le",
  "les",
  // German
  "der",
  "die",
  "das",
  "für",
  "und",
  // Spanish and Portuguese
  "da",
  "do",
  "e",
  "el",
  "y",
]);

/** Names the rules shorten badly, by their normalised text. Each has a test. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["proceedings of the national academy of sciences", "PNAS"],
  ["proceedings of the national academy of sciences of the united states of america", "PNAS"],
  ["proc natl acad sci u s a", "PNAS"],
  ["proc natl acad sci usa", "PNAS"],
  ["journal of the national cancer institute", "JNCI"],
  ["j natl cancer inst", "JNCI"],
  ["ieee transactions on pattern analysis and machine intelligence", "PAMI"],
  ["ieee trans pattern anal mach intell", "PAMI"],
  ["communications of the acm", "CACM"],
  ["commun acm", "CACM"],
]);

/** Series letters that name one journal of a family: Physical Review B, Physical Review X. */
const SERIES_LETTER = /^[A-FX]$/u;
const LATIN_GREEK_CYRILLIC = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const LETTER = /\p{L}/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

/** Lower-cased words without punctuation: the key for aliases and tones. */
function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /u, "");
}

/** The name once, without trailing punctuation: "Physical review. D/Physical review. D." */
function cleanName(name: string): string {
  let text = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const halves = text.split("/");
  if (halves.length === 2 && nameKey(halves[0]!) === nameKey(halves[1]!)) text = halves[0]!;
  return text.replace(/[\s.,;:]+$/u, "");
}

/** The first letter of a word, upper-cased where the script has case. */
function initial(word: string): string {
  const letter = graphemes(word).find((part) => LETTER.test(part)) ?? "";
  return LATIN_GREEK_CYRILLIC.test(letter) ? letter.toUpperCase() : letter;
}

const isAcronym = (word: string) => /^\p{Lu}{2,4}$/u.test(word);

/** Up to four letters for a journal name, or null when the name gives none. */
export function journalMarkLetters(name: string): string | null {
  // Upper-casing can lengthen a letter (ß → SS), so the limit applies to the result.
  const letters = markLetters(name);
  return letters === null ? null : graphemes(letters).slice(0, MAX_GRAPHEMES).join("");
}

function markLetters(name: string): string | null {
  const text = cleanName(name);
  if (!text) return null;
  const alias = ALIASES.get(nameKey(text));
  if (alias) return alias;
  const trailing = /\((\p{Lu}{2,4})\)$/u.exec(text);
  if (trailing) return trailing[1]!;

  const first = graphemes(text).find((part) => LETTER.test(part));
  if (!first) return null;
  // Scripts without capitals or word initials (CJK, Arabic, Hebrew) show the name's first letter.
  if (!LATIN_GREEK_CYRILLIC.test(first)) return first;

  const main = text.replace(/\([^)]*\)|\[[^\]]*\]/gu, " ").split(":")[0]!;
  const all = main.split(/[\s\-–—/.&,]+/u).filter((word) => word !== "" && LETTER.test(word));
  // A single capital is an initial ("N Y" in "Ann N Y Acad Sci"), except the article "A".
  const significant = (word: string) =>
    /^\p{Lu}$/u.test(word) ? word !== "A" : !STOPWORDS.has(word.toLowerCase());
  // A series letter after two longer words names one journal of a family: Physical Review B
  // → PRB, Proceedings of the Royal Society A … → PRSA. "Chemistry - A European Journal" has
  // one word before its "A", which stays an article.
  const seriesIndex = all.findIndex(
    (word, index) =>
      SERIES_LETTER.test(word) &&
      all.slice(0, index).filter((before) => significant(before) && graphemes(before).length > 1)
        .length >= 2,
  );
  if (seriesIndex !== -1) {
    const before = all.slice(0, seriesIndex).filter(significant);
    return (
      before
        .slice(0, MAX_GRAPHEMES - 1)
        .map(initial)
        .join("") + all[seriesIndex]!
    );
  }
  const words = all.filter(significant);
  const kept = words.length > 0 ? words : all;
  if (kept.length === 0) return null;

  const [lead, ...rest] = kept;
  // A leading acronym spelled out after it: "JNCI Journal of the National Cancer Institute".
  if (isAcronym(lead!) && rest.length > 0 && rest.map(initial).join("") === lead) return lead!;
  if (kept.length === 1) return isAcronym(lead!) ? lead! : initial(lead!) || null;
  const initials = kept.length <= MAX_GRAPHEMES ? kept : [...kept.slice(0, 3), kept.at(-1)!];
  return initials.map(initial).join("") || null;
}

/** Light and dark background and text colours; each pair is checked for 4.5:1 contrast. */
export const JOURNAL_MARK_TONES = [
  {
    light: { background: "#dbeafe", text: "#1e40af" },
    dark: { background: "#1e3a8a", text: "#dbeafe" },
  },
  {
    light: { background: "#ccfbf1", text: "#115e59" },
    dark: { background: "#134e4a", text: "#ccfbf1" },
  },
  {
    light: { background: "#dcfce7", text: "#166534" },
    dark: { background: "#14532d", text: "#dcfce7" },
  },
  {
    light: { background: "#fef3c7", text: "#92400e" },
    dark: { background: "#78350f", text: "#fef3c7" },
  },
  {
    light: { background: "#ffedd5", text: "#9a3412" },
    dark: { background: "#7c2d12", text: "#ffedd5" },
  },
  {
    light: { background: "#ffe4e6", text: "#9f1239" },
    dark: { background: "#881337", text: "#ffe4e6" },
  },
  {
    light: { background: "#ede9fe", text: "#5b21b6" },
    dark: { background: "#4c1d95", text: "#ede9fe" },
  },
  {
    light: { background: "#e2e8f0", text: "#1e293b" },
    dark: { background: "#334155", text: "#f1f5f9" },
  },
] as const;

/** The same title, the same tone, on every computer (FNV-1a over the normalised title). */
export function journalMarkTone(title: string): (typeof JOURNAL_MARK_TONES)[number] {
  const key = nameKey(cleanName(title));
  let hash = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(key)) {
    hash ^= unit;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return JOURNAL_MARK_TONES[hash % JOURNAL_MARK_TONES.length]!;
}
