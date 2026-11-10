/** A highlighted passage ready to quote in a document. */
export interface DocumentQuote {
  readonly quote: string;
  /** PDF page numbers, in order. */
  readonly pages: ReadonlyArray<number>;
  /** The Library key to cite, when the PDF belongs to a Source that has one. */
  readonly citationKey: string | null;
  readonly fileName: string;
}

/** The passage as one line of prose: PDF line breaks become spaces and split words rejoin. */
function quoteProse(quote: string): string {
  return quote
    .replace(/(\p{L})[-\xAD]\n(\p{L})/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

function pageLocator(pages: ReadonlyArray<number>, separator: string): string {
  const first = pages[0];
  const last = pages.at(-1);
  if (first === undefined || last === undefined) return "";
  return first === last ? `p.${separator}${first}` : `pp.${separator}${first}–${last}`;
}

/** Pandoc Markdown: a block quote ending in a citation, or the file and page without a key. */
export function markdownQuote(input: DocumentQuote): {
  readonly text: string;
  /** The citation node's source, e.g. `@key, p. 4`; null when there is no key. */
  readonly citation: string | null;
  /** What follows the quote: the bracketed citation, or the file and page. */
  readonly reference: string;
  readonly markdown: string;
} {
  const text = quoteProse(input.quote);
  const locator = pageLocator(input.pages, " ");
  const citation = input.citationKey
    ? `@${input.citationKey}${locator ? `, ${locator}` : ""}`
    : null;
  const reference = citation
    ? `[${citation}]`
    : `(${input.fileName}${locator ? `, ${locator}` : ""})`;
  return { text, citation, reference, markdown: `> ${text} ${reference}` };
}

/** LaTeX: the quote in typographic quotation marks, then `\cite` with the page. */
export function latexQuote(input: DocumentQuote): {
  readonly text: string;
  readonly cite: { readonly key: string; readonly raw: string } | null;
} {
  const prose = quoteProse(input.quote);
  const locator = pageLocator(input.pages, "~");
  if (!input.citationKey) {
    return {
      text: `“${prose}” (${input.fileName}${locator ? `, ${pageLocator(input.pages, " ")}` : ""})`,
      cite: null,
    };
  }
  return {
    text: `“${prose}” `,
    cite: {
      key: input.citationKey,
      raw: `\\cite${locator ? `[${locator}]` : ""}{${input.citationKey}}`,
    },
  };
}
