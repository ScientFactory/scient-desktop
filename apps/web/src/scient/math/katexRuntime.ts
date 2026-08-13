import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * The lazily loaded half of the module: everything that pulls KaTeX and its
 * stylesheet into a chunk of their own. KaTeX escapes the TeX it echoes back,
 * so the returned markup is safe to inject.
 *
 * `maxSize` caps user-specified dimensions so a pathological command like
 * `\rule{500em}{500em}` cannot distort the conversation layout. Returns null
 * for TeX KaTeX cannot parse; the caller shows the literal source instead of
 * KaTeX's red error markup.
 */
export function renderScientTexToHtml(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      maxSize: 50,
      maxExpand: 1000,
    });
  } catch {
    return null;
  }
}
