// @effect-diagnostics nodeBuiltinImport:off -- Page-text hashes use the same synchronous sha256 the reader stores.
import * as NodeCrypto from "node:crypto";

import {
  PDF_TARGET_LIMITS,
  PDF_TEXT_PROFILE,
  type PdfTextPageSelector,
} from "@scientfactory/document-artifacts";
import type { ScientPdfAnnotationAnchor } from "@t3tools/contracts";

/** One page's text in the reader's target profile, with its geometry. */
export interface PdfPageText {
  readonly page: number;
  readonly text: string;
  readonly viewBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly userUnit: number;
}

export type PdfQuoteAnchoring =
  | { readonly _tag: "Found"; readonly anchor: ScientPdfAnnotationAnchor }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Ambiguous"; readonly pages: ReadonlyArray<number> }
  /** The quote is longer or spans more pages than one annotation can hold. */
  | { readonly _tag: "TooLong" };

const SOFT_HYPHEN = String.fromCharCode(0xad);

interface Folded {
  readonly text: string;
  /** For each folded character, the offset of the original character it came from. */
  readonly origin: ReadonlyArray<number>;
}

/**
 * Folds text for matching an agent's quote against the PDF: compatibility
 * forms (ligatures), case, every whitespace run as one space, and a line-end
 * hyphen joining a split word. Offsets map back to the original text.
 */
function fold(text: string): Folded {
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  let pendingSpace = false;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const character = String.fromCodePoint(code);
    const width = character.length;
    if (/\s/u.test(character)) {
      pendingSpace = folded.length > 0;
      index += width;
      continue;
    }
    if ((character === "-" || character === SOFT_HYPHEN) && text[index + width] === "\n") {
      index += width + 1;
      pendingSpace = false;
      continue;
    }
    if (character === SOFT_HYPHEN) {
      index += width;
      continue;
    }
    if (pendingSpace) {
      folded += " ";
      origin.push(index);
      pendingSpace = false;
    }
    for (const part of character.normalize("NFKC").toLowerCase()) {
      folded += part;
      for (let unit = 0; unit < part.length; unit += 1) origin.push(index);
    }
    index += width;
  }
  return { text: folded, origin };
}

function textHash(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Finds an agent's quote in the PDF's page texts and builds the same anchor
 * the reader stores for a selection. Never guesses between repeats; `page`
 * narrows the search to matches that start on that page.
 */
export function anchorPdfQuote(
  pages: ReadonlyArray<PdfPageText>,
  quote: string,
  extractorVersion: string,
  page?: number,
): PdfQuoteAnchoring {
  const needle = fold(quote).text;
  if (needle.length === 0) return { _tag: "NotFound" };
  const ordered = [...pages].toSorted((left, right) => left.page - right.page);
  const folded = ordered.map((entry) => fold(entry.text));
  let joined = "";
  // Page index of each joined character; -1 for the space between two pages.
  const pageAt: number[] = [];
  const originAt: number[] = [];
  folded.forEach((part, at) => {
    if (joined.length > 0 && part.text.length > 0) {
      joined += " ";
      pageAt.push(-1);
      originAt.push(0);
    }
    joined += part.text;
    for (let unit = 0; unit < part.text.length; unit += 1) {
      pageAt.push(at);
      originAt.push(part.origin[unit]!);
    }
  });

  const matches: number[] = [];
  for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + 1)) {
    if (page === undefined || ordered[pageAt[at]!]!.page === page) matches.push(at);
    if (matches.length > 8) break;
  }
  if (matches.length === 0) return { _tag: "NotFound" };
  if (matches.length > 1) {
    return {
      _tag: "Ambiguous",
      pages: [...new Set(matches.map((at) => ordered[pageAt[at]!]!.page))],
    };
  }

  const first = matches[0]!;
  const last = first + needle.length - 1;
  const firstPage = pageAt[first]!;
  const lastPage = pageAt[last]!;
  if (lastPage - firstPage + 1 > PDF_TARGET_LIMITS.pages) return { _tag: "TooLong" };
  const selectorPages: PdfTextPageSelector[] = [];
  for (let at = firstPage; at <= lastPage; at += 1) {
    const entry = ordered[at]!;
    let from = -1;
    let to = -1;
    for (let index = first; index <= last; index += 1) {
      if (pageAt[index] !== at) continue;
      if (from === -1) from = originAt[index]!;
      to = originAt[index]!;
    }
    if (from === -1) continue;
    const start = from;
    const end = endOffset(entry.text, to);
    const text = entry.text.slice(start, end);
    if (text.trim().length === 0) continue;
    selectorPages.push({
      page: entry.page,
      viewBox: [...entry.viewBox],
      rotation: entry.rotation,
      userUnit: entry.userUnit,
      pageTextHash: textHash(entry.text),
      start,
      end,
      quote: text,
      prefix: entry.text.slice(Math.max(0, start - PDF_TARGET_LIMITS.context), start),
      suffix: entry.text.slice(end, end + PDF_TARGET_LIMITS.context),
    });
  }
  const characters = selectorPages.reduce((total, entry) => total + entry.quote.length, 0);
  if (selectorPages.length === 0 || characters > PDF_TARGET_LIMITS.characters) {
    return { _tag: "TooLong" };
  }
  return {
    _tag: "Found",
    anchor: {
      extractor: { profile: PDF_TEXT_PROFILE, version: extractorVersion },
      selector: { type: "text", pages: selectorPages },
    },
  };
}

/** The end offset just past the original character at `offset` (a surrogate pair is one character). */
function endOffset(text: string, offset: number): number {
  const code = text.codePointAt(offset);
  return offset + (code !== undefined && code > 0xffff ? 2 : 1);
}
