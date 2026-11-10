import * as Schema from "effect/Schema";

import { ScientSourceIdentifier, ScientSourceVerification } from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";

/** Most identifiers one add accepts; registry rate limits make larger batches slow. */
export const MAX_SOURCE_IDENTIFIER_BATCH = 50;

/** Schemes a person or agent can add a source by; each resolves against its registry. */
export const SOURCE_ADD_IDENTIFIER_SCHEMES = ["doi", "pmid", "arxiv", "isbn"] as const;
export type SourceAddIdentifierScheme = (typeof SOURCE_ADD_IDENTIFIER_SCHEMES)[number];

const SCHEME_NAMES: Readonly<
  Record<SourceAddIdentifierScheme, { readonly label: string; readonly registry: string }>
> = {
  doi: { label: "DOI", registry: "doi.org" },
  pmid: { label: "PMID", registry: "PubMed" },
  arxiv: { label: "arXiv ID", registry: "arXiv" },
  isbn: { label: "ISBN", registry: "Open Library or Google Books" },
};

function schemeNames(scheme: string) {
  return (
    SCHEME_NAMES[scheme as SourceAddIdentifierScheme] ?? { label: scheme, registry: "its registry" }
  );
}

/** "DOI 10.1000/x", for messages to people and agents. */
export function sourceIdentifierLabel(identifier: ScientSourceIdentifier): string {
  return `${schemeNames(identifier.scheme).label} ${identifier.value}`;
}

/** The registry an identifier is checked against, for messages to people and agents. */
export function sourceIdentifierRegistryName(identifier: ScientSourceIdentifier): string {
  return schemeNames(identifier.scheme).registry;
}

const DOI_BODY = /^10\.\d{4,9}\/\S+$/u;
const ARXIV_NEW = /^\d{4}\.\d{4,5}$/u;
const ARXIV_OLD = /^[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}$/u;
// PubMed IDs have eight digits today; a longer bare number is more likely an ISBN-10 typo.
const PMID_BODY = /^[1-9]\d{0,8}$/u;

export function isWellFormedDoi(value: string): boolean {
  return DOI_BODY.test(value);
}

export function isWellFormedPmid(value: string): boolean {
  return PMID_BODY.test(value);
}

/** A version-less arXiv identifier in either the 2007+ or the archive/number form. */
export function isWellFormedArxivId(value: string): boolean {
  return ARXIV_NEW.test(value) || ARXIV_OLD.test(value);
}

function isbn10CheckDigit(digits: string): string {
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += (10 - index) * Number(digits[index]);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? "x" : String(check);
}

function isbn13CheckDigit(digits: string): string {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += (index % 2 === 0 ? 1 : 3) * Number(digits[index]);
  }
  return String((10 - (sum % 10)) % 10);
}

/** An ISBN-10 or ISBN-13 (hyphens and spaces removed) whose check digit is right. */
export function isValidIsbn(value: string): boolean {
  const compact = value.replace(/[\s-]+/gu, "").toLowerCase();
  if (/^\d{9}[\dx]$/u.test(compact)) return isbn10CheckDigit(compact) === compact[9];
  if (/^97[89]\d{10}$/u.test(compact)) return isbn13CheckDigit(compact) === compact[12];
  return false;
}

/** The ISBN-13 form of a valid ISBN, so ISBN-10 and ISBN-13 spellings of a book compare equal. */
export function isbn13(value: string): string | null {
  if (!isValidIsbn(value)) return null;
  const compact = value.replace(/[\s-]+/gu, "").toLowerCase();
  if (compact.length === 13) return compact;
  const body = `978${compact.slice(0, 9)}`;
  return `${body}${isbn13CheckDigit(body)}`;
}

function trimTrailingPunctuation(value: string): string {
  // A DOI may end in ")" when it contains "(", so only strip an unbalanced one.
  let trimmed = value.replace(/[.,;:'"\]}>]+$/u, "");
  while (
    trimmed.endsWith(")") &&
    (trimmed.match(/\(/gu)?.length ?? 0) < (trimmed.match(/\)/gu)?.length ?? 0)
  ) {
    trimmed = trimmed.slice(0, -1).replace(/[.,;:'"\]}>]+$/u, "");
  }
  return trimmed;
}

function decodeUrlPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identifier(scheme: SourceAddIdentifierScheme, value: string): ScientSourceIdentifier {
  return { scheme, value };
}

function arxivIdentifier(raw: string): ScientSourceIdentifier | null {
  const value = normalizePersistentIdentifier("arxiv", raw).slice("arxiv:".length);
  return isWellFormedArxivId(value) ? identifier("arxiv", value) : null;
}

function isbnIdentifier(raw: string): ScientSourceIdentifier | null {
  const value = isbn13(raw);
  return value ? identifier("isbn", value) : null;
}

/**
 * Reads one DOI, PMID, arXiv ID or ISBN written in any common form: a bare value, a
 * "scheme:" prefix, or a doi.org, PubMed or arXiv link. Returns null when the text is
 * not exactly one identifier.
 */
export function detectSourceIdentifier(text: string): ScientSourceIdentifier | null {
  const value = trimTrailingPunctuation(text.trim().replace(/^<|>$/gu, ""));
  if (!value) return null;

  const doiLink = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/(10\.\S+)$/iu.exec(value);
  const doiPrefixed = /^doi:?\s*(10\.\S+)$/iu.exec(value);
  const doi = doiLink?.[1] ? decodeUrlPath(doiLink[1]) : (doiPrefixed?.[1] ?? value);
  if (isWellFormedDoi(doi)) return identifier("doi", doi.toLowerCase());

  const arxivLink =
    /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(\S+?)(?:\.pdf)?$/iu.exec(value);
  const arxivPrefixed = /^arxiv:?\s*(\S+)$/iu.exec(value);
  const arxivRaw = arxivLink?.[1] ?? arxivPrefixed?.[1];
  if (arxivRaw) return arxivIdentifier(arxivRaw);
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/u.test(value)) return arxivIdentifier(value);

  const pubmedLink =
    /^(?:https?:\/\/)?(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)\/?$/iu.exec(
      value,
    );
  const pmidPrefixed = /^pmid:?\s*(\d+)$/iu.exec(value);
  const pmid = pubmedLink?.[1] ?? pmidPrefixed?.[1];
  if (pmid) return isWellFormedPmid(pmid) ? identifier("pmid", pmid) : null;

  const isbnPrefixed = /^isbn(?:-1[03])?:?\s*([\d\s-]+[\dxX])$/iu.exec(value);
  if (isbnPrefixed?.[1]) return isbnIdentifier(isbnPrefixed[1]);
  if (/^[\d-]+[\dxX]$/u.test(value)) {
    const digits = value.replace(/-/gu, "");
    if (digits.length >= 10) return isbnIdentifier(value);
    if (!value.includes("-") && isWellFormedPmid(digits)) return identifier("pmid", digits);
  }
  return null;
}

export interface SourceIdentifierListEntry {
  /** The text as written, for reporting back. */
  readonly input: string;
  /** Null when the text is not a DOI, PMID, arXiv ID or ISBN. */
  readonly identifier: ScientSourceIdentifier | null;
}

const EMBEDDED_IDENTIFIER =
  /(?:https?:\/\/)?(?:dx\.)?doi\.org\/10\.\S+|\bdoi:?\s*10\.\S+|\b10\.\d{4,9}\/\S+|(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\/\S+|\barxiv:?\s*\S+|(?:https?:\/\/)?pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/?|\bpmid:?\s*\d+|\bisbn(?:-1[03])?:?\s*[\d-]+[\dxX]\b/giu;

function segmentEntries(segment: string): ReadonlyArray<SourceIdentifierListEntry> {
  const whole = detectSourceIdentifier(segment);
  if (whole) return [{ input: segment, identifier: whole }];
  const words = segment.split(/\s+/u);
  const wordIdentifiers = words.map(detectSourceIdentifier);
  if (words.length > 1 && wordIdentifiers.every((value) => value !== null)) {
    return words.map((word, index) => ({
      input: word,
      identifier: wordIdentifiers[index] ?? null,
    }));
  }
  // Inside prose, only forms that cannot be mistaken for a year or a page count count.
  const embedded = [...segment.matchAll(EMBEDDED_IDENTIFIER)].flatMap((match) => {
    const found = detectSourceIdentifier(match[0]);
    return found ? [{ input: trimTrailingPunctuation(match[0]), identifier: found }] : [];
  });
  return embedded.length > 0 ? embedded : [{ input: segment, identifier: null }];
}

/**
 * Splits pasted text (one per line, or separated by commas or semicolons) into identifiers.
 * Repeats of the same identifier collapse to the first; unreadable parts are kept so they
 * can be reported.
 */
export function parseSourceIdentifierList(text: string): ReadonlyArray<SourceIdentifierListEntry> {
  const seen = new Set<string>();
  return text
    .split(/[\r\n]+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      // Some old DOIs contain ";" or ",", so a line that is one identifier is never split.
      const whole = detectSourceIdentifier(line);
      if (whole) return [{ input: line, identifier: whole }];
      return line
        .split(/[,;\t]+/u)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .flatMap(segmentEntries);
    })
    .filter((entry) => {
      if (!entry.identifier) return true;
      const key = normalizePersistentIdentifier(entry.identifier.scheme, entry.identifier.value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** What happened to one entry of an add by identifier. */
export const ScientSourceIdentifierAddItem = Schema.Struct({
  input: Schema.String,
  identifier: Schema.NullOr(ScientSourceIdentifier),
  outcome: Schema.Literals([
    "imported",
    "duplicate",
    "unrecognized",
    "identifier-not-found",
    "unavailable",
  ]),
  /** The new source, or the existing one a duplicate matches. */
  sourceId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  verification: Schema.optionalKey(ScientSourceVerification.fields.state),
  message: Schema.NullOr(Schema.String),
});
export type ScientSourceIdentifierAddItem = typeof ScientSourceIdentifierAddItem.Type;
