import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * The lazily loaded half of the module: everything that pulls KaTeX and its
 * stylesheet into a chunk of their own. KaTeX escapes the TeX it echoes back,
 * so the returned markup is safe to inject.
 */
export function renderScientTexToHtml(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { displayMode, throwOnError: false, strict: "ignore" });
}
