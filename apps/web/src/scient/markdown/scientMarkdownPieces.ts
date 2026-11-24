import { splitMarkdown, type SplitMarkdown } from "@t3tools/shared/markdownChunks";

// One parse of the whole file: ~2 ms for 32 KB of prose and ~30–180 ms for 32 KB of tables full
// of math (Node 26, M-series), so larger files keep the pieces.
const WHOLE_FILE_MAX_CHARS = 32 * 1024;

/**
 * Whether any line may define a footnote (`[^` before a later `]:`), in one pass. A false match only
 * renders a small file in one piece; a missed one would leave its references as text, so this errs
 * toward matching.
 */
function mayDefineFootnote(text: string): boolean {
  let lineStart = 0;
  for (;;) {
    const marker = text.indexOf("[^", lineStart);
    if (marker === -1) return false;
    const lineEnd = text.indexOf("\n", marker);
    const end = lineEnd === -1 ? text.length : lineEnd;
    // The first marker on a line is enough: a later definition's `]:` also follows it.
    if (text.slice(marker + 2, end).includes("]:")) return true;
    if (lineEnd === -1) return false;
    lineStart = lineEnd + 1;
  }
}

/**
 * The rendered preview's pieces of a file. Footnotes resolve only inside one piece, so a small
 * file that may define a footnote stays whole.
 */
export function splitScientFileMarkdown(text: string): SplitMarkdown {
  if (text.length > WHOLE_FILE_MAX_CHARS || !mayDefineFootnote(text)) {
    return splitMarkdown(text);
  }
  return { chunks: [{ text, lines: text.split("\n").length }], definitions: "" };
}
