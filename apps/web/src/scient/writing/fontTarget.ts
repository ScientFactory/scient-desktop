// Rules shared by the Markdown and LaTeX Visual editors: the word a font change at the caret
// covers, and the text that counts when the size or font of a selection is shown.

const isLetter = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{M}\p{N}_]/u.test(char);

/**
 * Start and end offsets of the word around `offset` in a text block's text, or null between
 * words. An apostrophe between two letters belongs to the word ("don't", "l'arbre").
 */
export function wordAround(text: string, offset: number): { start: number; end: number } | null {
  const isWord = (at: number) =>
    isLetter(text[at]) ||
    (/['’]/u.test(text[at] ?? "") && isLetter(text[at - 1]) && isLetter(text[at + 1]));
  let start = offset;
  let end = offset;
  while (isWord(start - 1)) start -= 1;
  while (isWord(end)) end += 1;
  return start === end ? null : { start, end };
}

/** Whether a text run holds a font in the file; whitespace and inline code never do. */
export const holdsFont = (text: string, isCode: boolean): boolean =>
  !isCode && !/^\s*$/u.test(text);

/** The value every run shares, or null; `mixed` when the runs hold more than one. */
export function sharedValue<T>(values: ReadonlySet<T | null>): {
  readonly value: T | null;
  readonly mixed: boolean;
} {
  return values.size === 1
    ? { value: [...values][0] ?? null, mixed: false }
    : { value: null, mixed: values.size > 1 };
}
