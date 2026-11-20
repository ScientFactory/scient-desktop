// Rules shared by the Markdown and LaTeX Visual editors: the word a font change at the caret
// covers, the text that counts when the size or font of a selection is shown, and the size one
// step larger or smaller.
import { FONT_SIZE_MAX, FONT_SIZE_MIN, normalizeFontSize } from "./fontChoices";

/** Points added or removed by one step of the size buttons and shortcuts. */
export const FONT_SIZE_STEP = 1;

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

/**
 * A size moved by `steps` steps, kept within the allowed range. Each run of a mixed selection
 * moves by the same amount, so every word keeps its difference (as Word does).
 */
export function steppedFontSize(current: number, steps: number): number {
  const target = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + steps * FONT_SIZE_STEP));
  return normalizeFontSize(target) ?? current;
}

/** A piece of one text node inside the selection, with its explicit size in points, if any. */
export interface FontRun {
  readonly text: string;
  readonly from: number;
  readonly isCode: boolean;
  readonly size: number | null;
}

/**
 * What a size step changes: each run without the spaces at its ends, moved by `steps` from its
 * own size or, without one, from the size it is drawn at. Code and whitespace keep their size.
 */
export function steppedRuns(
  runs: Iterable<FontRun>,
  steps: number,
  drawnPoints: (position: number) => number | null,
): Array<{ readonly from: number; readonly to: number; readonly size: number }> {
  const changes = [];
  for (const run of runs) {
    if (!holdsFont(run.text, run.isCode)) continue;
    const start = run.text.length - run.text.trimStart().length;
    const end = run.text.trimEnd().length;
    const current = run.size ?? drawnPoints(run.from + start);
    if (current === null) continue;
    changes.push({
      from: run.from + start,
      to: run.from + end,
      size: steppedFontSize(current, steps),
    });
  }
  return changes;
}
