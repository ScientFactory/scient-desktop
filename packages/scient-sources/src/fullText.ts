import * as Schema from "effect/Schema";

/** Must equal `PDF_TEXT_PROFILE` in `@scientfactory/document-artifacts`, so stored offsets match reader quotes. */
export const SCIENT_SOURCE_FULL_TEXT_PROFILE = "pdfjs-text-layer-utf16-eol-v1";
export const SCIENT_SOURCE_FULL_TEXT_LIMITS = {
  pages: 5_000,
  characters: 6_000_000,
  context: 64,
} as const;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Coordinate = Schema.Finite;

export const ScientSourceFullTextPage = Schema.Struct({
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  text: Schema.String,
  viewBox: Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]),
  rotation: Schema.Int,
  userUnit: Schema.Finite,
});
export type ScientSourceFullTextPage = typeof ScientSourceFullTextPage.Type;

const Extractor = Schema.Struct({
  name: Schema.Literal("pdfjs"),
  version: Schema.String.check(Schema.isNonEmpty()),
});

export const ScientSourceFullText = Schema.Union([
  Schema.Struct({
    formatVersion: Schema.Literal(1),
    outcome: Schema.Literal("extracted"),
    sha256: Sha256,
    byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    profile: Schema.Literal(SCIENT_SOURCE_FULL_TEXT_PROFILE),
    extractor: Extractor,
    extractedAt: Schema.String,
    pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Every page was read in full; false when a page failed or a size limit cut the text. */
    complete: Schema.Boolean,
    pages: Schema.Array(ScientSourceFullTextPage),
  }),
  Schema.Struct({
    formatVersion: Schema.Literal(1),
    outcome: Schema.Literal("failed"),
    sha256: Sha256,
    byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    extractor: Extractor,
    failedAt: Schema.String,
    reason: Schema.Literals(["unreadable", "too-large"]),
  }),
]);
export type ScientSourceFullText = typeof ScientSourceFullText.Type;
export type ScientSourceExtractedFullText = Extract<
  ScientSourceFullText,
  { readonly outcome: "extracted" }
>;

export function fullTextHasText(text: ScientSourceExtractedFullText): boolean {
  return text.pages.some((page) => page.text.trim().length > 0);
}

/**
 * Folded text with, for each UTF-16 unit, the index of the source unit it came
 * from. `search` lowercases and strips accents and punctuation; `quote` keeps
 * case and punctuation but evens out spacing, ligatures, quote marks, dashes
 * and line-end hyphenation, which PDFs encode in many ways.
 */
export interface FoldedText {
  readonly text: string;
  readonly origin: ReadonlyArray<number>;
}

export type FoldMode = "search" | "quote";

const WHITESPACE = /\s/u;
const LETTER = /\p{L}/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const COMBINING_MARK = /\p{M}/gu;
const LINE_HYPHENS = new Set(["-", "­", "‐", "‑"]);
const DASHES = /[‐-―−﹘﹣－]/gu;
const SINGLE_QUOTES = /[‘’‚‛′´`]/gu;
const DOUBLE_QUOTES = /[“”„‟″«»]/gu;

function foldCharacter(character: string, mode: FoldMode): string {
  if (mode === "quote") {
    return character
      .normalize("NFKC")
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      .replace(DASHES, "-");
  }
  return character.normalize("NFKD").toLowerCase().replace(COMBINING_MARK, "");
}

/** The index after a line-end hyphen and its line break, or -1 when the hyphen is not one. */
function hyphenationEnd(source: string, at: number, previous: string | undefined): number {
  if (!LINE_HYPHENS.has(source[at]!) || previous === undefined || !LETTER.test(previous)) return -1;
  let next = at + 1;
  let lineBreak = false;
  while (next < source.length && WHITESPACE.test(source[next]!)) {
    if (source[next] === "\n" || source[next] === "\r") lineBreak = true;
    next += 1;
  }
  return lineBreak && next < source.length && LOWERCASE_LETTER.test(source[next]!) ? next : -1;
}

export function foldText(source: string, mode: FoldMode): FoldedText {
  const units: string[] = [];
  const origin: number[] = [];
  let pendingSpace = -1;
  const last = () => units.at(-1);
  const emit = (value: string, at: number) => {
    if (value.length === 0) return;
    if (pendingSpace >= 0 && units.length > 0) {
      units.push(" ");
      origin.push(pendingSpace);
    }
    pendingSpace = -1;
    for (let index = 0; index < value.length; index += 1) {
      units.push(value[index]!);
      origin.push(at);
    }
  };
  const space = (at: number) => {
    if (pendingSpace < 0) pendingSpace = at;
  };

  let index = 0;
  while (index < source.length) {
    const codePoint = source.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    if (WHITESPACE.test(character)) {
      space(index);
      index += width;
      continue;
    }
    const joined = pendingSpace < 0 ? hyphenationEnd(source, index, last()) : -1;
    if (joined >= 0) {
      index = joined;
      continue;
    }
    if (character === "­") {
      index += width;
      continue;
    }
    const folded = foldCharacter(character, mode);
    if (mode === "search") {
      for (const unit of folded) {
        if (ALPHANUMERIC.test(unit)) emit(unit, index);
        else space(index);
      }
    } else if (
      folded === "-" &&
      pendingSpace < 0 &&
      ALPHANUMERIC.test(last() ?? "") &&
      ALPHANUMERIC.test(source[index + width] ?? "")
    ) {
      // Intra-word hyphens are dropped on both sides, so "well-known" matches a
      // line-broken "well-\nknown" whose hyphen was joined away.
    } else {
      emit(folded, index);
    }
    index += width;
  }
  return { text: units.join(""), origin };
}

export interface FullTextPageText {
  readonly page: number;
  readonly text: string;
}

export interface FullTextRange {
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

function unitWidth(text: string, at: number): number {
  const codePoint = text.codePointAt(at);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function occurrences(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
    if (found.length >= limit) break;
  }
  return found;
}

export type FullTextQuoteLocation =
  | {
      readonly _tag: "Found";
      /** `exact` matched the stored characters; `normalized` matched after folding spacing, ligatures, quote marks, dashes and hyphenation. */
      readonly match: "exact" | "normalized";
      readonly ranges: ReadonlyArray<FullTextRange>;
      readonly text: string;
      readonly prefix: string;
      readonly suffix: string;
    }
  | { readonly _tag: "Ambiguous"; readonly match: "exact" | "normalized" }
  | { readonly _tag: "NotFound" };

interface JoinedPages {
  readonly pages: ReadonlyArray<FullTextPageText>;
  readonly text: string;
  readonly starts: ReadonlyArray<number>;
}

// Joins consecutive pages with a line break, which is not a stored character:
// a match that spans it is never exact.
const PAGE_BREAK = "\n";

/**
 * Pages a quote may span: consecutive page numbers, each with text. A missing,
 * unread or empty page ends a run, so text on either side never becomes adjacent.
 */
function pageRuns(pages: ReadonlyArray<FullTextPageText>): ReadonlyArray<JoinedPages> {
  const runs: FullTextPageText[][] = [];
  let previous: number | null = null;
  for (const page of pages) {
    if (page.text.trim().length === 0) {
      previous = null;
      continue;
    }
    if (previous === null || page.page !== previous + 1) runs.push([]);
    runs.at(-1)!.push(page);
    previous = page.page;
  }
  return runs.map((run) => {
    const starts: number[] = [];
    let text = "";
    for (const page of run) {
      if (starts.length > 0) text += PAGE_BREAK;
      starts.push(text.length);
      text += page.text;
    }
    return { pages: run, text, starts };
  });
}

function rangesFor(joined: JoinedPages, start: number, end: number): FullTextRange[] {
  const ranges: FullTextRange[] = [];
  for (const [index, page] of joined.pages.entries()) {
    const pageStart = joined.starts[index]!;
    const pageEnd = pageStart + page.text.length;
    const from = Math.max(start, pageStart);
    const to = Math.min(end, pageEnd);
    if (from < to) ranges.push({ page: page.page, start: from - pageStart, end: to - pageStart });
  }
  return ranges;
}

function found(
  joined: JoinedPages,
  match: "exact" | "normalized",
  start: number,
  end: number,
): FullTextQuoteLocation {
  const { context } = SCIENT_SOURCE_FULL_TEXT_LIMITS;
  const ranges = rangesFor(joined, start, end);
  return {
    _tag: "Found",
    match: ranges.length > 1 ? "normalized" : match,
    ranges,
    text: joined.text.slice(start, end),
    prefix: joined.text.slice(Math.max(0, start - context), start),
    suffix: joined.text.slice(end, end + context),
  };
}

/**
 * Finds a quote in stored page text, across the boundary of consecutive
 * readable pages. A verbatim match within a page is exact; otherwise both
 * sides are folded. A repeated quote is ambiguous, never guessed.
 */
export function locateFullTextQuote(
  input: ReadonlyArray<FullTextPageText>,
  quote: string,
): FullTextQuoteLocation {
  if (quote.trim().length === 0) return { _tag: "NotFound" };
  const runs = pageRuns(input.toSorted((left, right) => left.page - right.page));
  const exact = runs.flatMap((run) => occurrences(run.text, quote, 2).map((at) => ({ run, at })));
  if (exact.length > 1) return { _tag: "Ambiguous", match: "exact" };
  if (exact.length === 1) {
    const [{ run, at }] = exact as [(typeof exact)[number]];
    return found(run, "exact", at, at + quote.length);
  }

  // A run is folded as one text so spacing and hyphenation that cross a page
  // boundary fold the same way they would inside a page.
  const needle = foldText(quote, "quote").text;
  const matches = runs.flatMap((run) => {
    const folded = foldText(run.text, "quote");
    return occurrences(folded.text, needle, 2).map((at) => ({ run, folded, at }));
  });
  if (matches.length > 1) return { _tag: "Ambiguous", match: "normalized" };
  if (matches.length === 0) return { _tag: "NotFound" };
  const { run, folded, at } = matches[0]!;
  const start = folded.origin[at]!;
  const lastOrigin = folded.origin[at + needle.length - 1]!;
  return found(run, "normalized", start, lastOrigin + unitWidth(run.text, lastOrigin));
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have in into is it its of on or that the their " +
    "this to was were which with we our not no than then there these those been being can"
  ).split(" "),
);

export interface FullTextQuery {
  readonly terms: ReadonlyArray<string>;
  readonly phrases: ReadonlyArray<string>;
}

export function parseFullTextQuery(query: string): FullTextQuery {
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]*)"/gu, (_, phrase: string) => {
    const folded = foldText(phrase, "search").text;
    if (folded.includes(" ")) phrases.push(folded);
    else if (folded) return ` ${folded} `;
    return " ";
  });
  const words = [...new Set(foldText(rest, "search").text.split(" ").filter(Boolean))];
  const meaningful = words.filter((word) => !STOPWORDS.has(word));
  return {
    terms: meaningful.length > 0 || phrases.length > 0 ? meaningful : words,
    phrases: [...new Set(phrases)],
  };
}

export interface FullTextSearchDocument {
  readonly key: string;
  /** Each page folded with `foldText(text, "search")`. */
  readonly pages: ReadonlyArray<{ readonly page: number; readonly folded: string }>;
}

export interface FullTextSearchHit {
  readonly key: string;
  readonly page: number;
  /** The text to reveal, as offsets into the page's folded search text; map them with `fullTextPassage`. */
  readonly foldedStart: number;
  readonly foldedEnd: number;
  /** The ranked passage around it, shown as context. */
  readonly contextStart: number;
  readonly contextEnd: number;
  readonly score: number;
  readonly matchedTerms: ReadonlyArray<string>;
}

const PASSAGE_WINDOW = 360;
const PREFIX_TERM_LENGTH = 4;

interface Occurrence {
  readonly at: number;
  readonly end: number;
  /** Index into terms, or terms.length + phrase index. */
  readonly needle: number;
}

function isWordUnit(value: string | undefined): boolean {
  return value !== undefined && value !== " ";
}

function needleOccurrences(text: string, needle: string, prefix: boolean, index: number) {
  const found: Occurrence[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (isWordUnit(text[at - 1])) continue;
    let end = at + needle.length;
    if (isWordUnit(text[end])) {
      if (!prefix) continue;
      while (isWordUnit(text[end])) end += 1;
    }
    found.push({ at, end, needle: index });
  }
  return found;
}

/**
 * The occurrence to reveal inside a ranked window: the query's terms in order as a contiguous
 * phrase when the window holds one that covers every needle the window matched, else the
 * shortest run of occurrences covering them all (terms and quoted phrases), the earliest on a tie.
 */
function tightestReveal(
  folded: string,
  window: ReadonlyArray<Occurrence>,
  terms: ReadonlyArray<string>,
): { readonly start: number; readonly end: number } {
  const windowStart = window[0]!.at;
  const windowEnd = window.at(-1)!.end;
  const needles = new Set(window.map((entry) => entry.needle));
  if (terms.length > 1) {
    const phrase = terms.join(" ");
    const at = needleOccurrences(folded, phrase, false, 0).find(
      (entry) =>
        entry.at >= windowStart &&
        entry.end <= windowEnd &&
        [...needles].every((needle) =>
          window.some(
            (inside) =>
              inside.needle === needle && inside.at >= entry.at && inside.end <= entry.end,
          ),
        ),
    );
    if (at) return { start: at.at, end: at.end };
  }
  const wanted = needles.size;
  const counts = new Map<number, number>();
  let best = { start: windowStart, end: windowEnd };
  let left = 0;
  for (let right = 0; right < window.length; right += 1) {
    const entry = window[right]!;
    counts.set(entry.needle, (counts.get(entry.needle) ?? 0) + 1);
    while (counts.size === wanted) {
      const first = window[left]!;
      let end = first.end;
      for (let index = left + 1; index <= right; index += 1) {
        end = Math.max(end, window[index]!.end);
      }
      if (end - first.at < best.end - best.start) best = { start: first.at, end };
      const remaining = counts.get(first.needle)! - 1;
      if (remaining === 0) counts.delete(first.needle);
      else counts.set(first.needle, remaining);
      left += 1;
    }
  }
  return best;
}

/**
 * Ranks passages across documents: each query term scores by its rarity across
 * documents and by repetition inside a window; quoted phrases must all appear
 * in the window. Terms of four or more characters also match as word prefixes.
 */
export function searchFullText(
  documents: ReadonlyArray<FullTextSearchDocument>,
  query: FullTextQuery,
  options: { readonly limit: number; readonly perDocument: number },
): ReadonlyArray<FullTextSearchHit> {
  const needles = [...query.terms, ...query.phrases];
  if (needles.length === 0) return [];
  const perDocument = documents.map((document) =>
    document.pages.map((page) => ({
      page: page.page,
      folded: page.folded,
      occurrences: needles
        .flatMap((needle, index) =>
          needleOccurrences(
            page.folded,
            needle,
            index < query.terms.length && needle.length >= PREFIX_TERM_LENGTH,
            index,
          ),
        )
        .toSorted((left, right) => left.at - right.at),
    })),
  );
  const documentFrequency = needles.map(
    (_, needle) =>
      perDocument.filter((pages) =>
        pages.some((page) => page.occurrences.some((entry) => entry.needle === needle)),
      ).length,
  );
  const total = documents.length;
  const weight = needles.map(
    (_, needle) =>
      Math.log(
        1 + (total - documentFrequency[needle]! + 0.5) / (documentFrequency[needle]! + 0.5),
      ) * (needle >= query.terms.length ? 2 : 1),
  );
  const requiredPhrases = query.phrases.map((_, index) => query.terms.length + index);

  const hits: FullTextSearchHit[] = [];
  perDocument.forEach((pages, documentIndex) => {
    const documentHits: FullTextSearchHit[] = [];
    for (const page of pages) {
      const { occurrences: entries } = page;
      let best: FullTextSearchHit | null = null;
      for (let first = 0; first < entries.length; first += 1) {
        const start = entries[first]!.at;
        const counts = new Map<number, number>();
        let last = first;
        for (let next = first; next < entries.length; next += 1) {
          const entry = entries[next]!;
          if (entry.end - start > PASSAGE_WINDOW) break;
          counts.set(entry.needle, (counts.get(entry.needle) ?? 0) + 1);
          last = next;
        }
        if (!requiredPhrases.every((needle) => counts.has(needle))) continue;
        let score = 0;
        for (const [needle, count] of counts) score += weight[needle]! * (1 + Math.log(count));
        if (counts.size === needles.length && needles.length > 1) score *= 1.5;
        if (best === null || score > best.score) {
          const reveal = tightestReveal(page.folded, entries.slice(first, last + 1), query.terms);
          best = {
            key: documents[documentIndex]!.key,
            page: page.page,
            foldedStart: reveal.start,
            foldedEnd: reveal.end,
            contextStart: start,
            contextEnd: entries[last]!.end,
            score,
            matchedTerms: [...counts.keys()]
              .toSorted((a, b) => a - b)
              .map((needle) => needles[needle]!),
          };
        }
      }
      if (best) documentHits.push(best);
    }
    hits.push(
      ...documentHits
        .toSorted((left, right) => right.score - left.score || left.page - right.page)
        .slice(0, options.perDocument),
    );
  });
  return hits
    .toSorted(
      (left, right) =>
        right.score - left.score || left.key.localeCompare(right.key) || left.page - right.page,
    )
    .slice(0, options.limit);
}

const PASSAGE_MAXIMUM = 480;

/**
 * The stored page text around a hit: the reveal's offsets into the page, and a readable one-line
 * passage around the hit's context.
 */
export function fullTextPassage(
  pageText: string,
  hit: Pick<FullTextSearchHit, "foldedStart" | "foldedEnd" | "contextStart" | "contextEnd">,
): { readonly start: number; readonly end: number; readonly passage: string } {
  const folded = foldText(pageText, "search");
  const toPage = (foldedStart: number, foldedEnd: number) => {
    const lastUnit = Math.max(foldedStart, foldedEnd - 1);
    const from = folded.origin[foldedStart] ?? 0;
    const lastOrigin = folded.origin[lastUnit] ?? from;
    return { from, to: lastOrigin + unitWidth(pageText, lastOrigin) };
  };
  const reveal = toPage(hit.foldedStart, hit.foldedEnd);
  const context = toPage(
    Math.min(hit.contextStart, hit.foldedStart),
    Math.max(hit.contextEnd, hit.foldedEnd),
  );
  const matchStart = context.from;
  const matchEnd = context.to;
  const spare = Math.max(0, PASSAGE_MAXIMUM - (matchEnd - matchStart));
  let start = Math.max(0, matchStart - Math.floor(spare / 3));
  let end = Math.min(pageText.length, matchEnd + spare - (matchStart - start));
  while (start > 0 && !WHITESPACE.test(pageText[start - 1]!) && matchStart - start < spare)
    start -= 1;
  while (end < pageText.length && !WHITESPACE.test(pageText[end]!) && end - matchEnd < spare)
    end += 1;
  const body = pageText.slice(start, end).replace(/\s+/gu, " ").trim();
  return {
    start: reveal.from,
    end: reveal.to,
    passage: `${start > 0 ? "…" : ""}${body}${end < pageText.length ? "…" : ""}`,
  };
}
