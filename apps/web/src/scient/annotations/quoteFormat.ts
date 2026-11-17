import {
  scientMarkdownSchema,
  scientMarkdownSerializer,
} from "../markdownEditor/prosemirror/schema";

/** A highlighted passage ready to quote in a document. */
export interface DocumentQuote {
  readonly quote: string;
  /** PDF page numbers, in order. */
  readonly pages: ReadonlyArray<number>;
  /**
   * The printed page labels of `pages`, in the same order, when the PDF defines them
   * (a journal article's "1121"); the citation names these instead of the numbers.
   */
  readonly pageLabels?: ReadonlyArray<string> | null;
  /** The Library key to cite, when the PDF belongs to a Source that has one. */
  readonly citationKey: string | null;
  readonly fileName: string;
}

/**
 * The printed labels of PDF pages, from the document's label list (pdf.js
 * `getPageLabels()`, one entry per page). Null when the PDF has none or one of
 * these pages lacks one, so the citation keeps the page numbers throughout.
 */
export function quotePageLabels(
  pages: ReadonlyArray<number>,
  documentLabels: ReadonlyArray<string> | null,
): ReadonlyArray<string> | null {
  if (!documentLabels || pages.length === 0) return null;
  const labels: string[] = [];
  for (const page of pages) {
    const label = documentLabels[page - 1]?.trim();
    if (!label) return null;
    labels.push(label);
  }
  return labels;
}

/** The passage as one line of prose: PDF line breaks become spaces and split words rejoin. */
export function quoteProse(quote: string): string {
  return quote
    .replace(/(\p{L})[-\xAD]\n(\p{L})/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

function pageLocator(input: DocumentQuote, separator: string): string {
  const pages =
    input.pageLabels && input.pageLabels.length === input.pages.length
      ? input.pageLabels
      : input.pages.map(String);
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
  const locator = pageLocator(input, " ");
  const citation = input.citationKey
    ? `@${input.citationKey}${locator ? `, ${locator}` : ""}`
    : null;
  const reference = citation
    ? `[${citation}]`
    : `(${input.fileName}${locator ? `, ${locator}` : ""})`;
  const { blockquote, paragraph, citation: citationNode } = scientMarkdownSchema.nodes;
  const inline = citation
    ? [scientMarkdownSchema.text(`${text} `), citationNode!.create({ source: citation })]
    : [scientMarkdownSchema.text(`${text} ${reference}`)];
  const document = scientMarkdownSchema.topNodeType.create(
    null,
    blockquote!.create(null, paragraph!.create(null, inline)),
  );
  return {
    text,
    citation,
    reference,
    markdown: scientMarkdownSerializer.serialize(document).trimEnd(),
  };
}

/** LaTeX: the quote in typographic quotation marks, then `\cite` with the page. */
export function latexQuote(input: DocumentQuote): {
  readonly text: string;
  readonly cite: { readonly key: string; readonly raw: string } | null;
} {
  const prose = quoteProse(input.quote);
  const locator = pageLocator(input, "~");
  if (!input.citationKey) {
    return {
      text: `“${prose}” (${input.fileName}${locator ? `, ${pageLocator(input, " ")}` : ""})`,
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
