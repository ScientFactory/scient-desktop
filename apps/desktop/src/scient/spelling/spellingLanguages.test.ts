import { describe, expect, it, vi } from "vite-plus/test";

import { dictionaryFor, makeDocumentSpelling, type LanguageChoices } from "./spellingLanguages.ts";

// The shape Electron reports on Windows and Linux: some bare codes, some regional.
const AVAILABLE = [
  "bg",
  "da",
  "de",
  "de-DE",
  "el",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-US",
  "es",
  "fr",
  "fr-FR",
  "he",
  "it-IT",
  "pt-BR",
  "pt-PT",
  "ru",
  "sl",
];

const ENGLISH = "The results show a significant improvement in the accuracy of the model.";
const HEBREW = "התוצאות מראות שיפור משמעותי בדיוק של המודל";

function setup(
  preferredLocales: readonly string[],
  savedChoices: LanguageChoices = {},
  available: readonly string[] = AVAILABLE,
) {
  const setSpellCheckerLanguages = vi.fn<(languages: string[]) => void>();
  const spelling = makeDocumentSpelling(
    { availableSpellCheckerLanguages: available, setSpellCheckerLanguages },
    preferredLocales,
    savedChoices,
  );
  const codes = () => spelling.languages().map(({ code }) => code);
  return { spelling, codes, setSpellCheckerLanguages };
}

describe("dictionaryFor", () => {
  it("uses the user's own regional variant", () => {
    expect(dictionaryFor("en", AVAILABLE, ["en-GB", "fr-FR"])).toBe("en-GB");
    expect(dictionaryFor("pt", AVAILABLE, ["pt-PT"])).toBe("pt-PT");
  });

  it("falls back to the language's main dictionary for a region without one", () => {
    expect(dictionaryFor("en-IL", AVAILABLE, ["en-IL"])).toBe("en-US");
    expect(dictionaryFor("fr-CA", AVAILABLE, ["fr-CA"])).toBe("fr");
    expect(dictionaryFor("it-CH", AVAILABLE, ["it-CH"])).toBe("it-IT");
  });

  it("finds nothing for a language without a dictionary", () => {
    expect(dictionaryFor("ja", AVAILABLE, ["ja-JP"])).toBeNull();
  });
});

describe("makeDocumentSpelling", () => {
  it("sets every system language at start, replacing the list Electron kept", () => {
    const { codes, setSpellCheckerLanguages } = setup(["en-IL", "he-IL", "ja-JP"]);
    expect(setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith(["en-US", "he"]);
    expect(codes()).toEqual(["en-US", "he"]);
  });

  // English prompts a language guesser took for Indonesian, French and Danish (issue screenshots).
  it.each([
    "look at @data/cohort.csv and compute mean age",
    "write unit tests for parser.ts",
    "delete the tmp folder and rerun",
    "acknolegments",
  ])("adds nothing to an English system for %j", (prompt) => {
    const { spelling, codes } = setup(["en-US"]);
    expect(spelling.noteSample(prompt)).toBe(false);
    expect(codes()).toEqual(["en-US"]);
  });

  it.each([
    { system: ["he-IL"], sample: ENGLISH, expected: ["he", "en-US"] },
    { system: ["ru-RU"], sample: ENGLISH, expected: ["ru", "en-US"] },
    { system: ["ja-JP"], sample: ENGLISH, expected: ["en-US"] },
    { system: ["fr-FR"], sample: ENGLISH, expected: ["fr-FR"] },
    { system: ["en-US"], sample: HEBREW, expected: ["en-US", "he"] },
    { system: ["fr-FR"], sample: `${HEBREW} ${ENGLISH}`, expected: ["fr-FR", "he"] },
    { system: ["en-US"], sample: "Η ανάλυση των δεδομένων", expected: ["en-US", "el"] },
    { system: ["en-US"], sample: "We reject at α = 0.05 with μ known", expected: ["en-US"] },
    { system: ["ja-JP"], sample: "今日はとても良い天気ですね", expected: [] },
  ])(
    "turns on the language of an alphabet $system lacks: $sample",
    ({ system, sample, expected }) => {
      const { spelling, codes } = setup(system);
      spelling.noteSample(sample);
      expect(codes()).toEqual(expected);
    },
  );

  it("reports why each language is on", () => {
    const { spelling } = setup(["he-IL"], { sl: true });
    spelling.noteSample(ENGLISH);
    expect(spelling.languages()).toEqual([
      { code: "he", source: "system" },
      { code: "en-US", source: "alphabet" },
      { code: "sl", source: "user" },
    ]);
  });

  it("lets the user's choices win over the rules, and keeps them", () => {
    const { spelling, codes } = setup(["en-US"]);
    expect(spelling.choose("he", false)).toBe(false);
    expect(spelling.noteSample(HEBREW)).toBe(false);
    expect(spelling.choose("da", true)).toBe(true);
    expect(spelling.choose("en-US", false)).toBe(true);
    expect(codes()).toEqual(["da"]);
    expect(spelling.choices()).toEqual({ he: false, da: true, "en-US": false });
    expect(spelling.choose("xx", true)).toBe(false);
  });

  it("starts from saved choices, dropping dictionaries that are gone", () => {
    const { codes, setSpellCheckerLanguages } = setup(["en-US"], { fr: true, xx: true });
    expect(setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith(["en-US", "fr"]);
    expect(codes()).toEqual(["en-US", "fr"]);
  });

  it("records a change only once Electron accepted it, so a failure is retried", () => {
    const { spelling, codes, setSpellCheckerLanguages } = setup(["en-US"]);
    setSpellCheckerLanguages.mockImplementationOnce(() => {
      throw new Error("dictionary unavailable");
    });
    expect(() => spelling.noteSample(HEBREW)).toThrow("dictionary unavailable");
    expect(codes()).toEqual(["en-US"]);
    expect(spelling.noteSample(HEBREW)).toBe(true);
    expect(codes()).toEqual(["en-US", "he"]);
  });

  it("does nothing where spellcheck has no dictionaries", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"], {}, []);
    expect(spelling.noteSample(HEBREW)).toBe(false);
    expect(setSpellCheckerLanguages).not.toHaveBeenCalled();
  });
});
