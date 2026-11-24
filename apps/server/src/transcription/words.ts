import type { TranscriptionWord } from "@t3tools/contracts";

export const wordKey = (word: Pick<TranscriptionWord, "term" | "language">) =>
  JSON.stringify([word.language.toLowerCase(), word.term.normalize("NFC").toLowerCase()]);

export function mergeWords(
  levels: readonly (readonly TranscriptionWord[])[],
  language: string,
  context: string,
  limit = 32,
) {
  const merged = new Map<string, { word: TranscriptionWord; scope: number }>();
  for (const [scope, words] of levels.entries()) {
    for (const word of words) merged.set(wordKey(word), { word, scope });
  }
  const lower = context.toLowerCase();
  const relevant = (word: TranscriptionWord) =>
    [word.term, word.preferred, ...(word.variants ?? [])].some(
      (term) => term && lower.includes(term.toLowerCase()),
    );
  const base = (value: string) => value.toLowerCase().split("-")[0];
  return [...merged.values()]
    .filter(
      ({ word }) =>
        language === "auto" || word.language === "und" || base(language) === base(word.language),
    )
    .sort((a, b) => Number(relevant(b.word)) - Number(relevant(a.word)) || b.scope - a.scope)
    .slice(0, limit)
    .map(({ word }) => word);
}

export function recognitionTerms(
  words: readonly TranscriptionWord[],
  fallback: readonly string[] = [],
) {
  const terms = new Map<string, string>();
  for (const term of [...words.map((word) => word.preferred ?? word.term), ...fallback]) {
    const key = term.normalize("NFC").toLowerCase();
    if (!terms.has(key)) terms.set(key, term);
    if (terms.size === 16) break;
  }
  return [...terms.values()];
}
