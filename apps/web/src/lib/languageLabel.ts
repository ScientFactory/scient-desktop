const languageNamesByLocale = new Map<string, Intl.DisplayNames>();
export function languageLabel(code: string, locale = "en"): string {
  let languageNames = languageNamesByLocale.get(locale);
  if (!languageNames) {
    languageNames = new Intl.DisplayNames([locale], { type: "language" });
    languageNamesByLocale.set(locale, languageNames);
  }
  return languageNames.of(code) ?? code;
}
