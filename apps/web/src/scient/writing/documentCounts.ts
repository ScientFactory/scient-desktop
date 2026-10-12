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

/** "1,284 words", or "12 of 1,284 words" while text is selected. */
export function formatWordCount(count: DocumentWordCount): string {
  const total = count.total.toLocaleString("en-US");
  const noun = count.total === 1 ? "word" : "words";
  return count.selected === null || count.selected === 0
    ? `${total} ${noun}`
    : `${count.selected.toLocaleString("en-US")} of ${total} ${noun}`;
}
