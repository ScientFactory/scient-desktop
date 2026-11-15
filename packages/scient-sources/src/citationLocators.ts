/** One work a citation names, with the locator written for it (`p. 4`), if any. */
export interface CitationItem {
  readonly key: string;
  readonly locator: string | null;
}

// Pandoc's citation key: starts with a letter, digit or `_`; inner `:.#-` are allowed but a key
// never ends with punctuation, so `@smith2020.` cites `smith2020`.
const PANDOC_KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#-]*[\p{L}\p{N}_])?`;
const PANDOC_ITEM = new RegExp(
  String.raw`(?:^|[\s\[(-])-?@(?:\{([^{}\s]+)\}|(${PANDOC_KEY}))(.*)$`,
  "su",
);

function locatorText(value: string): string | null {
  const trimmed = value
    .replace(/^\s*,?\s*\[?/u, "")
    .replace(/\]?\s*$/u, "")
    .trim();
  // Punctuation alone (`@smith2020.` ending a sentence) is no locator.
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
}

/**
 * The works a Pandoc citation group cites, in order: the text between its brackets, such as
 * `see @a, p. 4; -@b`. Items are separated by `;`; whatever follows an item's key is its
 * locator. A part without a key (a stray prefix) is skipped.
 */
export function pandocCitationItems(group: string): ReadonlyArray<CitationItem> {
  return group.split(";").flatMap((part) => {
    const match = PANDOC_ITEM.exec(part);
    if (!match) return [];
    const key = match[1] ?? match[2]!;
    return [{ key, locator: locatorText(match[3] ?? "") }];
  });
}

/**
 * The works a LaTeX citation cites: the comma-separated keys of its required argument and the
 * notes in its optional arguments, as written. The last note is the postnote (the locator);
 * a lone `\cite[p.~4]{key}` note is a postnote too. A postnote belongs to the whole list, so it
 * is given to a key only when the citation names one key.
 */
export function latexCitationItems(
  keys: string,
  notes: ReadonlyArray<string>,
): ReadonlyArray<CitationItem> {
  const listed = keys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key && key !== "*");
  const postnote = notes.length > 0 ? locatorText(notes.at(-1)!) : null;
  return listed.map((key) => ({ key, locator: listed.length === 1 ? postnote : null }));
}

const PAGE_LOCATOR = /^(?:pp?|pages?|pg|s)\.?\s*~?\s*([0-9]+|[ivxlcdm]+)\b/iu;
const BARE_PAGE = /^([0-9]+)(?:\s*[-–—]\s*[0-9]+)?$/u;

/**
 * The first page a locator names, as written (`4` for `p. 4`, `pp.~4–5` or a bare `4`;
 * `xii` for `p. xii`). It is a printed page label, which can differ from the PDF's page
 * number; null when the locator names no page (a chapter, a section, a figure).
 */
export function citationLocatorPage(locator: string | null): string | null {
  if (!locator) return null;
  const text = locator.trim();
  return PAGE_LOCATOR.exec(text)?.[1] ?? BARE_PAGE.exec(text)?.[1] ?? null;
}
