/**
 * The exact `<span style>` forms Scient reads and writes for local font size
 * and family: `font-size:12pt` and `font-family:'Times New Roman'`. Anything
 * else stays literal HTML source.
 */
import { catalogueFont } from "./fontCatalogue.ts";

/** Local sizes are free numbers of points inside this range. */
export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 100;

/** A valid size rounded to two decimals, or null for anything outside the range. */
export function normalizeFontSize(value: number): number | null {
  if (!Number.isFinite(value) || value < FONT_SIZE_MIN || value > FONT_SIZE_MAX) return null;
  return Math.round(value * 100) / 100;
}

/** Whole-document base sizes: the `fontsize` front matter values and the LaTeX class options. */
export const DOCUMENT_FONT_SIZES = ["10pt", "11pt", "12pt"] as const;
export type DocumentFontSize = (typeof DOCUMENT_FONT_SIZES)[number];

/** A size in points, or a font name from the catalogue. */
export type MarkdownFontSpan = { readonly size: number } | { readonly family: string };

export const MARKDOWN_FONT_SPAN_CLOSE = "</span>";

const SIZE_STYLE = /^font-size:(\d+(?:\.\d{1,2})?)pt$/u;
const FAMILY_STYLE = /^font-family:'([^'"<>;:\\]+)'$/u;
const OPEN_PATTERN = /^<span style="([^"]*)">$/u;

/** The font a `style` value stands for, or null for any other CSS. */
export function parseMarkdownFontSpanStyle(style: string): MarkdownFontSpan | null {
  const size = SIZE_STYLE.exec(style)?.[1];
  if (size !== undefined) {
    const points = normalizeFontSize(Number(size));
    return points === null ? null : { size: points };
  }
  const family = FAMILY_STYLE.exec(style)?.[1];
  return family !== undefined && catalogueFont(family) !== null ? { family } : null;
}

/** The font a complete opening tag stands for, or null for any other HTML. */
export function parseMarkdownFontSpanOpen(html: string): MarkdownFontSpan | null {
  const style = OPEN_PATTERN.exec(html)?.[1];
  return style === undefined ? null : parseMarkdownFontSpanStyle(style);
}

export function markdownFontSpanStyle(span: MarkdownFontSpan): string {
  return "family" in span ? `font-family:'${span.family}'` : `font-size:${span.size}pt`;
}

export function markdownFontSpanOpen(span: MarkdownFontSpan): string {
  return `<span style="${markdownFontSpanStyle(span)}">`;
}
