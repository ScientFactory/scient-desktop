/**
 * The exact `<span style>` forms Scient reads and writes for local font size
 * and family. Anything else stays literal HTML source.
 */

/** Size names (the ten LaTeX names) with their `em` ratio at a 10 pt base. */
export const MARKDOWN_FONT_SIZES = [
  { name: "tiny", em: 0.5 },
  { name: "scriptsize", em: 0.7 },
  { name: "footnotesize", em: 0.8 },
  { name: "small", em: 0.9 },
  { name: "normalsize", em: 1 },
  { name: "large", em: 1.2 },
  { name: "Large", em: 1.44 },
  { name: "LARGE", em: 1.73 },
  { name: "huge", em: 2.07 },
  { name: "Huge", em: 2.49 },
] as const;

export const MARKDOWN_FONT_FAMILIES = ["serif", "sans-serif", "monospace"] as const;

export type MarkdownFontSizeName = (typeof MARKDOWN_FONT_SIZES)[number]["name"];
export type MarkdownFontFamilyName = (typeof MARKDOWN_FONT_FAMILIES)[number];

export type MarkdownFontSpan =
  | { readonly size: MarkdownFontSizeName }
  | { readonly family: MarkdownFontFamilyName };

export const MARKDOWN_FONT_SPAN_CLOSE = "</span>";

const STYLE_PATTERN = /^font-(?:size:(\d+(?:\.\d+)?)em|family:(serif|sans-serif|monospace))$/u;
const OPEN_PATTERN = /^<span style="([^"]*)">$/u;

/** The font a `style` value stands for, or null for any other CSS. */
export function parseMarkdownFontSpanStyle(style: string): MarkdownFontSpan | null {
  const match = STYLE_PATTERN.exec(style);
  if (!match) return null;
  if (match[1] !== undefined) {
    const size = MARKDOWN_FONT_SIZES.find(({ em }) => em === Number(match[1]));
    return size ? { size: size.name } : null;
  }
  return { family: match[2] as MarkdownFontFamilyName };
}

/** The font a complete opening tag stands for, or null for any other HTML. */
export function parseMarkdownFontSpanOpen(html: string): MarkdownFontSpan | null {
  const style = OPEN_PATTERN.exec(html)?.[1];
  return style === undefined ? null : parseMarkdownFontSpanStyle(style);
}

export function markdownFontSpanStyle(span: MarkdownFontSpan): string {
  if ("family" in span) return `font-family:${span.family}`;
  const em = MARKDOWN_FONT_SIZES.find(({ name }) => name === span.size)?.em;
  return `font-size:${em}em`;
}

export function markdownFontSpanOpen(span: MarkdownFontSpan): string {
  return `<span style="${markdownFontSpanStyle(span)}">`;
}
