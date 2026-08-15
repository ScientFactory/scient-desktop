import type { SupportedLanguages } from "@pierre/diffs";

/** Scient-owned overrides for scientific extensions misclassified by the inherited renderer. */
export function resolveScientificSourceLanguage(path: string): SupportedLanguages | undefined {
  if (/\.m$/iu.test(path)) return "matlab";
  // The renderer maps `.tex` and `.ltx` already; `.latex` is the same language
  // under a spelling its extension table never learned.
  if (/\.latex$/iu.test(path)) return "tex";
  return undefined;
}

export function scientificSourceLanguageOverride(
  path: string,
): { readonly lang: SupportedLanguages } | Record<never, never> {
  const lang = resolveScientificSourceLanguage(path);
  return lang === undefined ? {} : { lang };
}
