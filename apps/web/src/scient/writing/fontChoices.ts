/** Font size and family choices shared by the Markdown and LaTeX Visual editors. */
import {
  FONT_CATALOGUE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  catalogueFont,
  normalizeFontSize,
  type CatalogueFont,
  type FontCategory,
} from "@scientfactory/scient-markdown/fonts";

export { FONT_SIZE_MAX, FONT_SIZE_MIN, catalogueFont, normalizeFontSize };

/** Sizes offered in the size field's list, in points (Word's list). */
export const FONT_SIZE_PRESETS: ReadonlyArray<number> = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
];

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

const CSS_PIXELS_PER_POINT = 96 / 72;

function selectionElement(): Element | null {
  const anchor = window.getSelection()?.anchorNode;
  return anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
}

/** The size in points that the selected text is drawn at now, or null without a selection in the page. */
export function measureSelectionSize(): number | null {
  const element = selectionElement();
  return element === null ? null : pointsOf(element);
}

/** The size in points that the text at a document position is drawn at, or null. */
export function drawnPointsAt(
  view: { domAtPos(pos: number): { node: Node } },
  pos: number,
): number | null {
  const { node } = view.domAtPos(pos);
  const element = node instanceof Element ? node : node.parentElement;
  return element === null ? null : pointsOf(element);
}

function pointsOf(element: Element): number | null {
  const pixels = Number.parseFloat(getComputedStyle(element).fontSize);
  // Nearest half point, so the stepper starts from a clean number (11.16 shows as 11).
  return normalizeFontSize(Math.round((pixels / CSS_PIXELS_PER_POINT) * 2) / 2);
}
