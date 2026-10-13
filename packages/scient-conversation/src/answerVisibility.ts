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
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;
/** Inline code shows its text literally, so syntax inside it is not structure. */
const INLINE_CODE = /(`+)[^`\n]*?\1/g;
/** Display math anywhere, as chat renders it: an opened and closed `$$` or `\[`, or an environment. */
const DISPLAY_MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\begin\{(?:equation|align)\*?\}/;
/** Inline and reference images, and raw image tags. */
const IMAGE = /!\[[^\]\n]*\](?:\([^)\s]+|\[[^\]\n]*\])|<img\b/i;
const SHORTCUT_IMAGE = /!\[([^\]\n]+)\](?![[(])/g;
const LINK_DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*\S/gm;

function hasShortcutImage(text: string) {
  const defined = new Set(
    [...text.matchAll(LINK_DEFINITION)].map((match) => match[1]!.trim().toLowerCase()),
  );
  if (defined.size === 0) return false;
  return [...text.matchAll(SHORTCUT_IMAGE)].some((match) =>
    defined.has(match[1]!.trim().toLowerCase()),
  );
}

export function isSubstantiveAnswer(
  text: string,
  options: { readonly hasImages?: boolean } = {},
): boolean {
  if (options.hasImages === true) return true;
  if (text.trim().length >= SUBSTANTIVE_ANSWER_MIN_CHARS) return true;
  const raw = text.split(/\r?\n/);
  if (raw.some((line) => FENCE.test(line))) return true;
  const prose = text.replace(INLINE_CODE, "");
  if (DISPLAY_MATH.test(prose) || IMAGE.test(prose) || hasShortcutImage(prose)) return true;
  const lines = prose.split(/\r?\n/);
  let listItems = 0;
  for (const [index, line] of lines.entries()) {
    if (ATX_HEADING.test(line)) return true;
    if (LIST_ITEM.test(line) && ++listItems >= 2) return true;
    const previous = index > 0 ? lines[index - 1] : undefined;
    if (previous === undefined || previous.trim() === "") continue;
    if (TABLE_DELIMITER.test(line) && previous.includes("|")) return true;
    // A paragraph line underlined with = or - is a heading; a list item's is not.
    if (SETEXT_UNDERLINE.test(line) && !LIST_ITEM.test(previous)) return true;
  }
  return false;
}
