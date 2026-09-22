import { cssFontFamilyName } from "../../appearanceFonts";

export const DEFAULT_FONT_VALUE = "__default__";

export function getFontPickerPreviewFontFamily(
  item: string,
  defaultPreviewFontFamily: string,
): string {
  if (item === DEFAULT_FONT_VALUE) return defaultPreviewFontFamily;
  const exactFamily = cssFontFamilyName(item);
  return exactFamily === null
    ? defaultPreviewFontFamily
    : `${exactFamily}, ${defaultPreviewFontFamily}`;
}

export function getFontPickerItems(input: {
  readonly families: readonly string[];
  readonly query: string;
  readonly defaultFamily: string;
  readonly defaultOptionLabel: string;
}): string[] {
  const query = input.query.trim().toLowerCase();
  const defaultSearchText = `${input.defaultOptionLabel} ${input.defaultFamily}`.toLowerCase();
  const items: string[] = [];
  if (query.length === 0 || defaultSearchText.includes(query)) items.push(DEFAULT_FONT_VALUE);
  items.push(
    ...input.families.filter(
      (family) => query.length === 0 || family.toLowerCase().includes(query),
    ),
  );
  return items;
}

export function getFontPickerDisplayLabel(
  selectedFamily: string,
  defaultOptionLabel: string,
): string {
  return selectedFamily.length === 0 ? defaultOptionLabel : selectedFamily;
}

export function getFontFamilyPreference(value: string): string {
  return value === DEFAULT_FONT_VALUE ? "" : value;
}
