/** Font size and family choices shared by the Markdown and LaTeX Visual editors. */
import {
  FONT_CATALOGUE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  catalogueFont,
  normalizeFontSize,
  type CatalogueFont,
  type FontCategory,
} from "@scientfactory/scient-markdown";

export { FONT_SIZE_MAX, FONT_SIZE_MIN, catalogueFont, normalizeFontSize };

const CATEGORY_LABELS: Readonly<Record<FontCategory, string>> = {
  serif: "Serif",
  "sans-serif": "Sans serif",
  monospace: "Monospace",
};

export interface FontGroup {
  readonly label: string;
  readonly fonts: ReadonlyArray<CatalogueFont>;
}

/** The catalogue grouped for the picker, in catalogue order. */
export const FONT_GROUPS: ReadonlyArray<FontGroup> = (
  ["serif", "sans-serif", "monospace"] as const
).map((category) => ({
  label: CATEGORY_LABELS[category],
  fonts: FONT_CATALOGUE.filter((font) => font.category === category),
}));
