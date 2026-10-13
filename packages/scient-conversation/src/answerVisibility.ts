/**
 * Whether an assistant message reads as a real answer rather than a progress
 * note. Once a turn settles, the chat folds its work behind "Worked for…";
 * earlier messages that are real answers stay visible in place.
 *
 * A message is an answer when it has structure (a heading, a list of two or
 * more items, a table, fenced code, display math or an image) or at least
 * {@link SUBSTANTIVE_ANSWER_MIN_CHARS} characters. Measured on real threads,
 * this matched hand judgement on 95% of mid-turn messages; a sentence count
 * did not, since status updates are often several short sentences.
 *
 * Line scanning only, without a Markdown parser: the timeline asks on every
 * derivation.
 */
export const SUBSTANTIVE_ANSWER_MIN_CHARS = 400;

const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
/** Lines a setext underline cannot turn into a heading: a quote or a heading of its own. */
const NOT_PARAGRAPH = /^ {0,3}(?:>|#{1,6}(?:[ \t]|$))/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;
/**
 * Inline code shows its text literally, so syntax inside it is not structure;
 * it stands in as a word, so a heading or list made of code still counts. A
 * span may cross a line break but not a blank line.
 */
const INLINE_CODE = /(?<!`)(`+)(?!`)((?:[^\n]|\n(?![ \t]*\n))*?[^`])\1(?!`)/g;
/** Text within one paragraph. */
const SPAN = String.raw`(?:[^\n]|\n(?![ \t]*\n))+?`;
/** Display math as chat renders it: a closed `$$` or `\[` within a paragraph, or an environment. */
const DISPLAY_MATH = new RegExp(
  String.raw`\$\$${SPAN}\$\$|\\\[${SPAN}\\\]|\\begin\{(?:equation|align)\*?\}`,
);
const INLINE_IMAGE = /!\[[^\]\n]*\]\([^)\s]+|<img\b/i;
/** `![alt][label]`, `![label][]` and `![label]`: images only when the label is defined. */
const REFERENCE_IMAGE = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\]|(?![[(]))/g;
const LINK_DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?\S/gm;

const referenceLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

function hasReferenceImage(text: string) {
  const defined = new Set([...text.matchAll(LINK_DEFINITION)].map((m) => referenceLabel(m[1]!)));
  if (defined.size === 0) return false;
  return [...text.matchAll(REFERENCE_IMAGE)].some((match) => {
    const label = referenceLabel(match[2] || match[1]!);
    return label.length > 0 && defined.has(label);
  });
}

export function isSubstantiveAnswer(
  text: string,
  options: { readonly hasImages?: boolean } = {},
): boolean {
  if (options.hasImages === true) return true;
  if (text.trim().length >= SUBSTANTIVE_ANSWER_MIN_CHARS) return true;
  const raw = text.split(/\r?\n/);
  if (raw.some((line) => FENCE.test(line))) return true;
  const prose = text.replace(/\r\n/g, "\n").replace(INLINE_CODE, "code");
  if (DISPLAY_MATH.test(prose) || INLINE_IMAGE.test(prose) || hasReferenceImage(prose)) return true;
  const lines = prose.split("\n");
  let listItems = 0;
  for (const [index, line] of lines.entries()) {
    if (ATX_HEADING.test(line)) return true;
    if (LIST_ITEM.test(line) && ++listItems >= 2) return true;
    const previous = index > 0 ? lines[index - 1] : undefined;
    if (previous === undefined || previous.trim() === "") continue;
    if (TABLE_DELIMITER.test(line) && previous.includes("|")) return true;
    // A paragraph line underlined with = or - is a heading; a list item's or a quote's is not.
    if (SETEXT_UNDERLINE.test(line) && !LIST_ITEM.test(previous) && !NOT_PARAGRAPH.test(previous)) {
      return true;
    }
  }
  return false;
}
