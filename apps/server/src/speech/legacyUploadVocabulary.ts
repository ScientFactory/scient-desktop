import type { SpeechTranscriptionOptions, TranscriptionWord } from "@t3tools/contracts";
import {
  dictationSpelling,
  legacyDictationVocabulary,
  legacyDictationWords,
} from "@t3tools/shared/speech";
import { mergeWords, recognitionTerms } from "../transcription/words.ts";

export function legacyUploadVocabulary(
  options: SpeechTranscriptionOptions,
  words: readonly TranscriptionWord[],
  language: string,
) {
  const legacy = legacyDictationVocabulary(options);
  const selected = mergeWords([words], language, "", words.length);
  if (selected.length === 0) return legacy;
  return {
    hints: recognitionTerms(selected, legacy.hints),
    spell: dictationSpelling([...selected, ...legacyDictationWords(options)]),
  };
}
