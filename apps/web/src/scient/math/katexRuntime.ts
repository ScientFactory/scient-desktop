import katex from "katex";
// The swap variant KaTeX ships: identical to katex.min.css except every
// @font-face declares `font-display: swap`, so math paints with fallback
// glyphs while the bundled fonts load instead of staying invisible.
import "katex/dist/katex-swap.min.css";

/**
 * KaTeX escapes echoed TeX, allowing markup injection. Cap dimensions to protect layout from
 * pathological commands; show literal source on parse failure rather than red error markup.
 */
export function renderScientTexToHtml(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      maxSize: 50,
      maxExpand: 1000,
    });
  } catch {
    return null;
  }
}
