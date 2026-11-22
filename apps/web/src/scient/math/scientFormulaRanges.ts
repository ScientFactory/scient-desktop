import { markdownMathRanges } from "~/markdown/wordsHast";

// As markdownMathRanges' own check: text without these holds no math.
const MAY_HOLD_MATH = /[$\\]|(?:`{3,}|~{3,})[ \t]*math\b/;
// A label holds no whitespace, so the scan for one stops at its line.
const FOOTNOTE_DEFINITION = /^[ \t>]*\[\^([^\]\s]+)\]:/gm;

/** The labels of the footnote definitions in `text`; each is read within its own line. */
export function footnoteLabels(text: string): Set<string> {
  return new Set([...text.matchAll(FOOTNOTE_DEFINITION)].map((match) => match[1]!));
}

/**
 * The formulas Words reads in `text`, in source order and without overlaps, for editors that keep
 * math as source. Words renders footnotes after the body and leaves an unused one out, so each
 * definition gets a reference past the end of the text.
 */
export function scientFormulaRanges(text: string): Array<{ start: number; end: number }> {
  if (!MAY_HOLD_MATH.test(text)) return [];
  const labels = footnoteLabels(text);
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
