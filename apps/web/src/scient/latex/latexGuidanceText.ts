/**
 * How a template marks its guidance, shared by Visual (latexGuidance.ts) and
 * the template pictures (scripts/render-template-previews.ts), so both show
 * the same guidance in the same places. Plain functions with no imports: the
 * preview script runs this file directly under Node.
 */

/** A template's guidance is a comment that begins `% Guide:`. */
const GUIDE = /^%+\s*Guide:\s*/u;

/**
 * The text of a template's guidance: comment lines (blank lines allowed), the
 * first marked `Guide:`, joined. Null for anything else, an ordinary comment
 * included.
 */
export function guidanceText(source: string): string | null {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || !GUIDE.test(lines[0]!) || !lines.every((line) => line.startsWith("%")))
    return null;
  const text = lines
    .map((line, index) => (index === 0 ? line.replace(GUIDE, "") : line.replace(/^%+\s?/u, "")))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return text || null;
}

/** An environment and its body: `\begin{name}[options] … \end{name}`. */
export const GUIDED_ENVIRONMENT =
  /^\\begin\s*\{([A-Za-z]+\*?)\}(?:\s*\[[^\]]*\])?([\s\S]*)\\end\s*\{\1\}$/u;

/**
 * The source with each guided place rewritten by `render`, in document order:
 * the guidance above an empty paragraph (every comment or blank line directly
 * above a `\par` line), or the comment-only body of an environment that holds
 * nothing else. The same places Visual finds; anything else is left as it is.
 */
export function rewriteGuidedPlaces(source: string, render: (text: string) => string): string {
  const places: { from: number; to: number; text: string; closing: string }[] = [];
  // Empty paragraphs: a `\par` line and the comment or blank lines above it.
  const lineStart = (at: number) => source.lastIndexOf("\n", at - 1) + 1;
  for (const line of source.matchAll(/^[ \t]*\\par[ \t]*$/gmu)) {
    let from = line.index;
    while (from > 0) {
      const previous = lineStart(from - 1);
      const text = source.slice(previous, from - 1).trim();
      if (text !== "" && !text.startsWith("%")) break;
      from = previous;
    }
    const text = guidanceText(source.slice(from, line.index));
    // Rewritten from its first comment: a blank line above still begins a paragraph.
    const first = from + source.slice(from, line.index).search(/%/u);
    if (text !== null)
      places.push({ from: first, to: line.index + line[0].length, text, closing: "\\par" });
  }
  // Environments holding no other environment, with a comment-only body.
  for (const block of source.matchAll(
    /\\begin\s*\{([A-Za-z]+\*?)\}(?:\s*\[[^\]]*\])?[^\n]*\n((?:(?!\\begin\s*\{)[\s\S])*?)\\end\s*\{\1\}/gu,
  )) {
    const text = guidanceText(block[2]!);
    if (text === null) continue;
    // The body starts after the opening line.
    const from = block.index + block[0].indexOf("\n") + 1;
    places.push({
      from,
      to: block.index + block[0].length,
      text,
      closing: `\n\\end{${block[1]}}`,
    });
  }
  places.sort((a, b) => a.from - b.from);
  let result = "";
  let cursor = 0;
  for (const place of places) {
    result += source.slice(cursor, place.from) + render(place.text) + place.closing;
    cursor = place.to;
  }
  return result + source.slice(cursor);
}
