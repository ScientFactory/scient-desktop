import { describe, expect, it } from "vite-plus/test";
import { legacyDictationCatalogModel } from "./catalogDictation";

describe("legacy voice model selection", () => {
  it("maps Hebrew, including a Hebrew device preference with automatic language", () => {
    const model = "vladkens/ivrit-whisper-large-v3-turbo-gguf";
    expect(legacyDictationCatalogModel(true, "he", ["en"])).toBe(model);
    expect(legacyDictationCatalogModel(true, "auto", ["he", "en"])).toBe(model);
  });

  it("maps other languages to multilingual turbo and leaves fresh setup unpinned", () => {
    expect(legacyDictationCatalogModel(true, "fr", ["he"])).toBe(
      "handy-computer/whisper-large-v3-turbo-gguf",
    );
    expect(legacyDictationCatalogModel(false, "he", ["he"])).toBeNull();
  });
});
