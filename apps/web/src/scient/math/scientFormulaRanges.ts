import { markdownMathRanges } from "~/markdown/wordsHast";

const FOOTNOTE_DEFINITION = /^[ \t>]*\[\^([^\]\s][^\]]*)\]:/gm;

/**
 * The formulas Words reads in `text`, in source order and without overlaps, for editors that keep
 * math as source. Words renders footnotes after the body and leaves an unused one out, so each
 * definition gets a reference past the end of the text.
 */
export function scientFormulaRanges(text: string): Array<{ start: number; end: number }> {
  const labels = new Set([...text.matchAll(FOOTNOTE_DEFINITION)].map((match) => match[1]!));
  const probe =
    labels.size === 0 ? text : `${text}${[...labels].map((label) => `\n\n[^${label}]`).join("")}`;
  const ranges = markdownMathRanges(probe)
    .filter((range) => range.end <= text.length)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const separate: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (range.start >= (separate.at(-1)?.end ?? 0)) separate.push(range);
  }
  return separate;
}
