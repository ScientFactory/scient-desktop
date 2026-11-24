import { VOICE_LANGUAGE_NAMES, type VoiceTranscriptionLanguage } from "@t3tools/contracts";

const languageNamesByLocale = new Map<string, Intl.DisplayNames>();
export function languageLabel(code: string, locale = "en"): string {
  let languageNames = languageNamesByLocale.get(locale);
  if (!languageNames) {
    languageNames = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
    languageNamesByLocale.set(locale, languageNames);
  }
  const fallback = Object.hasOwn(VOICE_LANGUAGE_NAMES, code)
    ? VOICE_LANGUAGE_NAMES[code as VoiceTranscriptionLanguage]
    : code;
  // Chromium names both the separate fil and tl catalog entries Filipino.
  return code === "tl" ? fallback : (languageNames.of(code) ?? fallback);
}
