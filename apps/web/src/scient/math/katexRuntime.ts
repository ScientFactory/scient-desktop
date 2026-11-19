import katex from "katex";
// The swap variant KaTeX ships: identical to katex.min.css except every
// @font-face declares `font-display: swap`, so math paints with fallback
// glyphs while the bundled fonts load instead of staying invisible.
import "katex/dist/katex-swap.min.css";

import { escapeLiteralPercents } from "~/components/chat/MathTypeset.logic";

/**
 * KaTeX escapes echoed TeX, allowing markup injection. Cap dimensions to protect layout from
 * pathological commands; show literal source on parse failure rather than red error markup.
 */
export function renderScientTexToHtml(tex: string, displayMode: boolean): string | null {
  const options = {
    displayMode,
    throwOnError: true,
    strict: "ignore" as const,
    trust: false,
    maxSize: 50,
    maxExpand: 1000,
  };
  try {
    return katex.renderToString(tex, options);
  } catch {
    // Upstream's repair: a `%` written right after text, as in `\text{3.18% yield}`, is literal.
    const repaired = escapeLiteralPercents(tex);
    if (repaired === tex) return null;
    try {
      return katex.renderToString(repaired, options);
    } catch {
      return null;
    }
  }
}
