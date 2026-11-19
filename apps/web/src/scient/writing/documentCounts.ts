import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** Words in a piece of document text, for the footer's count. */
export function countWords(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(/\S+/gu)) count += 1;
  return count;
}

export interface DocumentWordCount {
  /** Words in the whole document. */
  readonly total: number;
  /** Words in the selection, or null when nothing is selected. */
  readonly selected: number | null;
}

/**
 * "1,284 words", or "12 of 1,284 words" while text is selected. Components pass `useMessages()`
 * so the count follows a language switch.
 */
export function formatWordCount(count: DocumentWordCount, resolve: MessageResolver = m): string {
  const total = count.total.toLocaleString("en-US");
  return count.selected === null || count.selected === 0
    ? resolve(
        msg("{count, plural, one {{total} word} other {{total} words}}", {
          count: count.total,
          total,
        }),
      )
    : resolve(
        msg(
          "{count, plural, one {{selected} of {total} word} other {{selected} of {total} words}}",
          {
            count: count.total,
            selected: count.selected.toLocaleString("en-US"),
            total,
          },
        ),
      );
}
