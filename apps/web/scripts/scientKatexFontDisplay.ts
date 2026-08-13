import type { Plugin } from "vite";

/**
 * Injects `font-display: swap` into KaTeX's `@font-face` rules so math text
 * paints with fallback glyphs while the bundled fonts load, instead of staying
 * invisible. KaTeX's stylesheet ships without a font-display declaration, and
 * overriding it from outside would mean redeclaring every face with resolvable
 * src URLs; rewriting the stylesheet as it passes through the build is the
 * narrow, explicit strategy.
 */
export function scientKatexFontDisplay(): Plugin {
  return {
    name: "scient-katex-font-display",
    transform(code, id) {
      const filePath = id.split("?", 1)[0] ?? id;
      if (!filePath.includes("katex") || !filePath.endsWith(".css")) return null;
      if (!code.includes("@font-face")) return null;
      return {
        code: code.replace(/@font-face\s*\{/g, "@font-face{font-display:swap;"),
        map: null,
      };
    },
  };
}
