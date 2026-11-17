export const WORD_CITATION_STYLE_STORAGE_KEY = "scient.wordExport.citationStyle";

export const WORD_CITATION_STYLES = [
  { id: "default", name: "Chicago author-date" },
  { id: "apa", name: "APA 7" },
  { id: "vancouver", name: "Vancouver" },
] as const;

export type WordCitationStyle = (typeof WORD_CITATION_STYLES)[number]["id"];

export function normalizeWordCitationStyle(value: string): WordCitationStyle {
  return WORD_CITATION_STYLES.find((style) => style.id === value)?.id ?? "default";
}
