/** Font size and family choices shared by the Markdown and LaTeX Visual editors. */
import {
  MARKDOWN_FONT_FAMILIES,
  MARKDOWN_FONT_SIZES,
  type MarkdownFontFamilyName,
  type MarkdownFontSizeName,
} from "@scientfactory/scient-markdown";

export type FontSizeName = MarkdownFontSizeName;
export type FontFamilyName = MarkdownFontFamilyName;

const SIZE_LABELS: Readonly<Record<FontSizeName, string>> = {
  tiny: "Tiny",
  scriptsize: "Very small",
  footnotesize: "Footnote",
  small: "Small",
  normalsize: "Normal",
  large: "Large",
  Large: "Larger",
  LARGE: "Very large",
  huge: "Huge",
  Huge: "Largest",
};

const FAMILY_LABELS: Readonly<Record<FontFamilyName, string>> = {
  serif: "Serif",
  "sans-serif": "Sans serif",
  monospace: "Code",
};

/** The ten LaTeX size names; `em` is each size relative to `\normalsize` at 10 pt. */
export const FONT_SIZES = MARKDOWN_FONT_SIZES.map((size) => ({
  ...size,
  label: SIZE_LABELS[size.name],
}));

/** Generic families only; the names are the CSS keywords written in Markdown. */
export const FONT_FAMILIES = MARKDOWN_FONT_FAMILIES.map((name) => ({
  name,
  label: FAMILY_LABELS[name],
}));

export function isFontFamilyName(value: string): value is FontFamilyName {
  return MARKDOWN_FONT_FAMILIES.some((family) => family === value);
}
