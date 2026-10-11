import { franc } from "franc";

/**
 * Languages Chromium has Hunspell dictionaries for, keyed by the ISO 639-3
 * code franc reports. Windows and Linux spellcheck only with the dictionaries
 * the app enables, so a document in any other language is left unchecked
 * rather than underlined throughout.
 */
const DICTIONARY_LANGUAGE_BY_DETECTED: Readonly<Record<string, string>> = {
  afr: "af",
  als: "sq",
  bul: "bg",
  cat: "ca",
  ces: "cs",
  dan: "da",
  deu: "de",
  ekk: "et",
  ell: "el",
  eng: "en",
  fra: "fr",
  heb: "he",
  hin: "hi",
  hrv: "hr",
  hun: "hu",
  hye: "hy",
  ind: "id",
  ita: "it",
  kor: "ko",
  lit: "lt",
  lvs: "lv",
  nld: "nl",
  nob: "nb",
  pes: "fa",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rus: "ru",
  slk: "sk",
  slv: "sl",
  spa: "es",
  srp: "sr",
  swe: "sv",
  tam: "ta",
  tgk: "tg",
  tur: "tr",
  ukr: "uk",
  vie: "vi",
};

const DETECTABLE = Object.keys(DICTIONARY_LANGUAGE_BY_DETECTED);

/** The variant to use when neither the user's locales nor a bare code name one. */
const FALLBACK_VARIANT: Readonly<Record<string, string>> = { en: "en-US", pt: "pt-BR" };

/** Short samples guess wrong; a title alone is not enough to switch dictionaries. */
const MIN_SAMPLE_LENGTH = 20;
/** System languages always stay enabled; this many detected ones are kept besides. */
const MAX_DETECTED_LANGUAGES = 3;
const MAX_SYSTEM_LANGUAGES = 4;

const baseOf = (tag: string): string => tag.toLowerCase().split("-")[0] ?? "";

/** The installed dictionary for a language, preferring the user's own regional variant. */
export function dictionaryFor(
  language: string,
  available: readonly string[],
  preferredLocales: readonly string[],
): string | null {
  const base = baseOf(language);
  const byLowerCase = new Map(
    available.map((dictionary) => [dictionary.toLowerCase(), dictionary]),
  );
  const candidates = [
    language,
    ...preferredLocales.filter((locale) => baseOf(locale) === base),
    base,
    FALLBACK_VARIANT[base] ?? `${base}-${base}`,
  ];
  for (const candidate of candidates) {
    const dictionary = byLowerCase.get(candidate.toLowerCase());
    if (dictionary !== undefined) return dictionary;
  }
  return available.find((dictionary) => baseOf(dictionary) === base) ?? null;
}

function uniqueByLanguage(dictionaries: readonly string[]): string[] {
  const seen = new Set<string>();
  return dictionaries.filter((dictionary) => {
    const base = baseOf(dictionary);
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

/** What Hunspell needs to check spelling as the user writes. */
export interface SpellcheckSession {
  readonly availableSpellCheckerLanguages: readonly string[];
  readonly setSpellCheckerLanguages: (languages: string[]) => void;
}

export interface DocumentSpelling {
  readonly languages: () => readonly string[];
  /** Enables the dictionary for the language a sample is written in. Returns true when it was added. */
  readonly noteSample: (sample: string) => boolean;
}

/**
 * Keeps Hunspell's dictionaries matched to what the user writes: every
 * language in the system settings, plus the few most recent languages found in
 * documents. A word is accepted when any enabled dictionary knows it.
 */
export function makeDocumentSpelling(
  session: SpellcheckSession,
  preferredLocales: readonly string[],
): DocumentSpelling {
  const available = session.availableSpellCheckerLanguages;
  const system = uniqueByLanguage(
    preferredLocales.flatMap((locale) => dictionaryFor(locale, available, preferredLocales) ?? []),
  ).slice(0, MAX_SYSTEM_LANGUAGES);
  let detected: string[] = [];
  const languages = () => uniqueByLanguage([...system, ...detected]);
  const apply = () => session.setSpellCheckerLanguages([...languages()]);
  if (system.length > 0) apply();

  return {
    languages,
    noteSample: (sample) => {
      if (sample.trim().length < MIN_SAMPLE_LENGTH || available.length === 0) return false;
      // Choosing among every supported language, not just the installed ones,
      // keeps a German page from passing for the nearest installed language.
      const code = franc(sample, { only: DETECTABLE, minLength: MIN_SAMPLE_LENGTH });
      const language = DICTIONARY_LANGUAGE_BY_DETECTED[code];
      if (language === undefined) return false;
      if (system.some((dictionary) => baseOf(dictionary) === language)) return false;
      const known = detected.find((dictionary) => baseOf(dictionary) === language);
      if (known !== undefined) {
        // The most recently written languages are the ones kept.
        detected = [...detected.filter((dictionary) => dictionary !== known), known];
        return false;
      }
      const dictionary = dictionaryFor(language, available, preferredLocales);
      if (dictionary === null) return false;
      detected = [...detected, dictionary].slice(-MAX_DETECTED_LANGUAGES);
      apply();
      return true;
    },
  };
}
