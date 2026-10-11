import { describe, expect, it, vi } from "vite-plus/test";

import { dictionaryFor, makeDocumentSpelling } from "./spellingLanguages.ts";

// The shape Electron reports on Windows and Linux: some bare codes, some regional.
const AVAILABLE = [
  "af",
  "bg",
  "de",
  "de-DE",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-US",
  "es",
  "es-ES",
  "fr",
  "fr-FR",
  "gl",
  "he",
  "it",
  "it-IT",
  "pt-BR",
  "pt-PT",
  "ru",
];

const FRENCH = "Les résultats montrent une amélioration significative de la précision du modèle.";
const GERMAN = "Die Ergebnisse zeigen eine deutliche Verbesserung der Genauigkeit des Modells.";
const SPANISH = "Los resultados muestran una mejora significativa en la precisión del modelo.";
const ITALIAN = "I risultati mostrano un miglioramento significativo della precisione del modello.";
const ENGLISH = "The results show a significant improvement in the accuracy of the model.";
const GALICIAN =
  "Os resultados mostran unha mellora significativa na precisión do modelo e na calidade da investigación.";

function setup(preferredLocales: readonly string[], available: readonly string[] = AVAILABLE) {
  const setSpellCheckerLanguages = vi.fn<(languages: string[]) => void>();
  const spelling = makeDocumentSpelling(
    { availableSpellCheckerLanguages: available, setSpellCheckerLanguages },
    preferredLocales,
  );
  return { spelling, setSpellCheckerLanguages };
}

describe("dictionaryFor", () => {
  it("uses the user's own regional variant", () => {
    expect(dictionaryFor("en", AVAILABLE, ["en-GB", "fr-FR"])).toBe("en-GB");
    expect(dictionaryFor("pt", AVAILABLE, ["pt-PT"])).toBe("pt-PT");
  });

  it("falls back to the language's main dictionary for a region without one", () => {
    expect(dictionaryFor("en-IL", AVAILABLE, ["en-IL"])).toBe("en-US");
    expect(dictionaryFor("fr-CA", AVAILABLE, ["fr-CA"])).toBe("fr");
    expect(dictionaryFor("it-CH", ["it-IT"], ["it-CH"])).toBe("it-IT");
  });

  it("finds nothing for a language without a dictionary", () => {
    expect(dictionaryFor("ja", AVAILABLE, ["ja-JP"])).toBeNull();
  });
});

describe("makeDocumentSpelling", () => {
  it("enables every system language at once, not only the first", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-IL", "he-IL", "ja-JP"]);
    expect(setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith(["en-US", "he"]);
    expect(spelling.languages()).toEqual(["en-US", "he"]);
  });

  it("keeps each regional dictionary the system lists", () => {
    const { spelling } = setup(["en-GB", "en-US"]);
    expect(spelling.languages()).toEqual(["en-GB", "en-US"]);
    expect(spelling.noteSample(ENGLISH)).toBe(false);
  });

  it("tells Galician from Spanish", () => {
    const { spelling } = setup(["en-US"]);
    expect(spelling.noteSample(GALICIAN)).toBe(true);
    expect(spelling.languages()).toEqual(["en-US", "gl"]);
  });

  it("records a dictionary only once Electron accepted it, so a failure is retried", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"]);
    setSpellCheckerLanguages.mockImplementationOnce(() => {
      throw new Error("dictionary unavailable");
    });
    expect(() => spelling.noteSample(FRENCH)).toThrow("dictionary unavailable");
    expect(spelling.languages()).toEqual(["en-US"]);
    expect(spelling.noteSample(FRENCH)).toBe(true);
    expect(spelling.languages()).toEqual(["en-US", "fr"]);
  });

  it("adds the dictionary for a document written in another language", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"]);
    expect(spelling.noteSample(FRENCH)).toBe(true);
    expect(setSpellCheckerLanguages).toHaveBeenLastCalledWith(["en-US", "fr"]);
  });

  it("changes nothing for a language that is already enabled", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"]);
    expect(spelling.noteSample(ENGLISH)).toBe(false);
    spelling.noteSample(FRENCH);
    expect(spelling.noteSample(FRENCH)).toBe(false);
    expect(setSpellCheckerLanguages).toHaveBeenCalledTimes(2);
  });

  it("keeps the three most recently written languages besides the system ones", () => {
    const { spelling } = setup(["en-US"]);
    for (const sample of [FRENCH, GERMAN, SPANISH, FRENCH, ITALIAN]) spelling.noteSample(sample);
    expect(spelling.languages()).toEqual(["en-US", "es", "fr", "it"]);
  });

  it("ignores short samples and languages it cannot check", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"], ["en-US", "fr"]);
    expect(spelling.noteSample("Titre")).toBe(false);
    expect(spelling.noteSample(GERMAN)).toBe(false);
    expect(spelling.noteSample("今日はとても良い天気ですね。散歩に行きましょう。")).toBe(false);
    expect(setSpellCheckerLanguages).toHaveBeenCalledTimes(1);
  });

  it("does nothing where spellcheck has no dictionaries", () => {
    const { spelling, setSpellCheckerLanguages } = setup(["en-US"], []);
    expect(spelling.noteSample(FRENCH)).toBe(false);
    expect(setSpellCheckerLanguages).not.toHaveBeenCalled();
  });
});
