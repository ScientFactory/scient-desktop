export interface ScientMarkdownTextMatch {
  readonly from: number;
  readonly to: number;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

/**
 * Literal (never regex) case/whole-word aware matching for the rich Markdown
 * document search surface.
 */
export function markdownTextMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): ReadonlyArray<ScientMarkdownTextMatch> {
  if (query.length === 0) return [];
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escapedQuery, caseSensitive ? "gu" : "giu");
  const matches: Array<ScientMarkdownTextMatch> = [];
  for (const match of text.matchAll(expression)) {
    const from = match.index;
    const to = from + match[0].length;
    if (!wholeWord || (!isWordCharacter(text[from - 1]) && !isWordCharacter(text[to]))) {
      matches.push({ from, to });
    }
  }
  return matches;
}
