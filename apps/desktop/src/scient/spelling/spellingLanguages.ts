/**
 * Windows and Linux check only the languages the app enables: the system's, the language of any
 * alphabet written that no system language uses, and the user's choices, which win. Alphabets,
 * unlike a guess at the language, cannot turn short English prompts into Danish.
 */
interface Alphabet {
  /** The ISO 15924 code Intl gives the alphabet's languages. */
  readonly script: string;
  /** Two letters in a row, so a lone symbol such as a Greek α in a formula does not count. */
  readonly word: RegExp;
  readonly language: string;
}

const ALPHABETS: readonly Alphabet[] = [
  { script: "Latn", word: /\p{Script=Latin}{2}/u, language: "en" },
  { script: "Hebr", word: /\p{Script=Hebrew}{2}/u, language: "he" },
  { script: "Grek", word: /\p{Script=Greek}{2}/u, language: "el" },
  { script: "Armn", word: /\p{Script=Armenian}{2}/u, language: "hy" },
  { script: "Kore", word: /\p{Script=Hangul}{2}/u, language: "ko" },
  { script: "Taml", word: /\p{Script=Tamil}{2}/u, language: "ta" },
];

/** The variant to use when neither the user's locales nor a bare code name one. */
const FALLBACK_VARIANT: Readonly<Record<string, string>> = { en: "en-US", pt: "pt-BR" };
const MAX_SYSTEM_LANGUAGES = 4;

const baseOf = (tag: string): string => tag.toLowerCase().split("-")[0] ?? "";
const unique = (codes: readonly string[]): string[] => [...new Set(codes)];

function scriptOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().script;
  } catch {
    return undefined;
  }
}

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

/** What Chromium needs to check spelling as the user writes. */
export interface SpellcheckSession {
  readonly availableSpellCheckerLanguages: readonly string[];
  readonly setSpellCheckerLanguages: (languages: string[]) => void;
}

/** Why a language is on: the system lists it, the text uses its alphabet, or the user chose it. */
export type LanguageSource = "system" | "alphabet" | "user";

export interface SpellingLanguage {
  readonly code: string;
  readonly source: LanguageSource;
}

/** The user's choices from the context menu: true turns a language on, false keeps it off. */
export type LanguageChoices = Readonly<Record<string, boolean>>;

export interface DocumentSpelling {
  readonly available: readonly string[];
  readonly languages: () => readonly SpellingLanguage[];
  readonly choices: () => LanguageChoices;
  /** Enables the language of each new alphabet in a sample. Returns true when languages changed. */
  readonly noteSample: (sample: string) => boolean;
  /** Records the user's choice for one language. Returns true when languages changed. */
  readonly choose: (code: string, enabled: boolean) => boolean;
}

interface State {
  readonly fromAlphabets: readonly string[];
  readonly choices: LanguageChoices;
}

export function makeDocumentSpelling(
  session: SpellcheckSession,
  preferredLocales: readonly string[],
  savedChoices: LanguageChoices,
): DocumentSpelling {
  const available = session.availableSpellCheckerLanguages;
  // Every regional dictionary the user lists stays enabled, such as both British and American English.
  const system = unique(
    preferredLocales.flatMap((locale) => dictionaryFor(locale, available, preferredLocales) ?? []),
  ).slice(0, MAX_SYSTEM_LANGUAGES);
  // A system language without a dictionary, such as Japanese, still covers its own alphabet.
  const systemScripts = new Set(preferredLocales.map(scriptOf));
  const isAvailable = (code: string) => available.includes(code);

  const languagesOf = ({ fromAlphabets, choices }: State): SpellingLanguage[] => {
    const automatic = [
      ...system.map((code) => ({ code, source: "system" as const })),
      ...fromAlphabets.map((code) => ({ code, source: "alphabet" as const })),
    ].filter(({ code }) => choices[code] !== false);
    const chosen = Object.keys(choices)
      .filter((code) => choices[code] && !automatic.some((language) => language.code === code))
      .map((code) => ({ code, source: "user" as const }));
    return [...automatic, ...chosen];
  };
  const codesOf = (next: State) => languagesOf(next).map(({ code }) => code);

  let state: State = {
    fromAlphabets: [],
    choices: Object.fromEntries(Object.entries(savedChoices).filter(([code]) => isAvailable(code))),
  };
  // Only what Electron accepted is recorded, so a failed change is retried.
  const commit = (next: State): boolean => {
    const changed = codesOf(next).join() !== codesOf(state).join();
    if (changed) session.setSpellCheckerLanguages(codesOf(next));
    state = next;
    return changed;
  };
  // Electron keeps the last list across restarts, so the app sets its own from the start.
  if (available.length > 0) session.setSpellCheckerLanguages(codesOf(state));

  return {
    available,
    languages: () => languagesOf(state),
    choices: () => state.choices,
    noteSample: (sample) => {
      const found = ALPHABETS.filter(
        (alphabet) => !systemScripts.has(alphabet.script) && alphabet.word.test(sample),
      )
        .flatMap(({ language }) => dictionaryFor(language, available, preferredLocales) ?? [])
        .filter((code) => !system.includes(code) && !state.fromAlphabets.includes(code));
      if (found.length === 0) return false;
      return commit({ ...state, fromAlphabets: [...state.fromAlphabets, ...found] });
    },
    choose: (code, enabled) =>
      isAvailable(code) && commit({ ...state, choices: { ...state.choices, [code]: enabled } }),
  };
}
