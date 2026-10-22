import * as Schema from "effect/Schema";

import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
} from "./contracts.ts";

/**
 * A place in a PDF: which document, which exact bytes when they are known,
 * and which text on which pages. A chat quote is a target plus a comment; a
 * saved annotation will be a target plus its own identity and history. The
 * schema is neutral (no pdf.js), so the shared serializer, the server,
 * mobile and a later annotation store can all read it.
 */

/** PDF.js text-layer text: raw item strings, a newline after `hasEOL` items. */
export const PDF_TEXT_PROFILE = "pdfjs-text-layer-utf16-eol-v1";
export const PDF_TARGET_LIMITS = {
  pages: 4,
  characters: 8_000,
  context: 64,
} as const;

const Text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const NonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PageNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }));
const Coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }),
);
export const PdfRect = Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]);
export type PdfRect = typeof PdfRect.Type;

/** Where the PDF can be fetched again, scoped to its environment. */
export const PdfDocumentLocator = Schema.Union([
  Schema.TaggedStruct("workspace", {
    workspaceRoot: NonEmpty(4_096),
    relativePath: NonEmpty(4_096),
  }),
  Schema.TaggedStruct("generated", {
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
    bindingGeneration: BindingGeneration,
  }),
  Schema.TaggedStruct("source", {
    workspaceRoot: NonEmpty(4_096),
    sourceId: NonEmpty(256),
    attachmentId: NonEmpty(256),
    relativePath: NonEmpty(4_096),
  }),
  Schema.TaggedStruct("attachment", {
    threadId: NonEmpty(256),
    attachmentId: NonEmpty(256),
    sizeBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  Schema.TaggedStruct("environment", {
    path: NonEmpty(4_096),
  }),
]);
export type PdfDocumentLocator = typeof PdfDocumentLocator.Type;

export const PdfDocumentIdentity = Schema.Struct({
  authority: ArtifactAuthority,
  logicalDocumentKey: LogicalDocumentKey,
  title: NonEmpty(512),
  // The same rule as a reader descriptor, so a stored quote can always be reopened.
  fileName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[^/\\\x00]+\.pdf$/iu),
  ),
  locator: PdfDocumentLocator,
});
export type PdfDocumentIdentity = typeof PdfDocumentIdentity.Type;

/** Proven bytes. Present only when a producer recorded them; never inferred. */
export const PdfMaterial = Schema.Struct({
  sha256: Sha256,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type PdfMaterial = typeof PdfMaterial.Type;

export const PdfTextPageSelector = Schema.Struct({
  page: PageNumber,
  viewBox: PdfRect,
  rotation: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 359 })),
  userUnit: Schema.Finite.check(Schema.isBetween({ minimum: 0.000001, maximum: 75_000 })),
  pageTextHash: Sha256,
  start: Offset,
  end: Offset,
  quote: NonEmpty(PDF_TARGET_LIMITS.characters),
  prefix: Text(PDF_TARGET_LIMITS.context),
  suffix: Text(PDF_TARGET_LIMITS.context),
});
export type PdfTextPageSelector = typeof PdfTextPageSelector.Type;

export const PdfTarget = Schema.Struct({
  version: Schema.Literal(1),
  document: PdfDocumentIdentity,
  material: Schema.NullOr(PdfMaterial),
  extractor: Schema.Struct({
    profile: Schema.Literal(PDF_TEXT_PROFILE),
    version: NonEmpty(128),
  }),
  selector: Schema.Struct({
    type: Schema.Literal("text"),
    pages: Schema.Array(PdfTextPageSelector).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PDF_TARGET_LIMITS.pages),
    ),
  }),
}).check(
  Schema.makeFilter((target) => {
    let characters = 0;
    return target.selector.pages.every((page, index, pages) => {
      characters += page.quote.length;
      return (
        characters <= PDF_TARGET_LIMITS.characters &&
        page.end - page.start === page.quote.length &&
        page.quote.trim().length > 0 &&
        (index === 0 || page.page === pages[index - 1]!.page + 1) &&
        page.viewBox[0] < page.viewBox[2] &&
        page.viewBox[1] < page.viewBox[3]
      );
    });
  }),
);
export type PdfTarget = typeof PdfTarget.Type;

/** One page as the reader extracts it now. `textHash` is the caller's sha256 of `text`. */
export interface PdfCurrentPage {
  readonly page: number;
  readonly text: string;
  readonly textHash: string;
  readonly viewBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly userUnit: number;
}

export type PdfMaterialMatch = "match" | "differs" | "unknown";

export interface PdfTargetVerification {
  readonly material: PdfMaterialMatch;
  /** The stored offsets still select the stored text on the same pages. */
  readonly selectorValid: boolean;
}

/**
 * Material and selector validity stay separate: identical bytes read by a
 * different extractor can still shift offsets, so offsets are reused only
 * when the live page text proves them.
 */
export function verifyPdfTarget(
  target: PdfTarget,
  current: {
    readonly material: PdfMaterial | null;
    readonly extractorVersion: string;
    readonly page: (page: number) => PdfCurrentPage | undefined;
  },
): PdfTargetVerification {
  const material: PdfMaterialMatch =
    target.material === null || current.material === null
      ? "unknown"
      : target.material.sha256 === current.material.sha256 &&
          target.material.byteLength === current.material.byteLength
        ? "match"
        : "differs";
  const selectorValid =
    target.extractor.profile === PDF_TEXT_PROFILE &&
    target.extractor.version === current.extractorVersion &&
    target.selector.pages.every((stored) => {
      const page = current.page(stored.page);
      return (
        page !== undefined &&
        page.rotation === stored.rotation &&
        page.userUnit === stored.userUnit &&
        page.viewBox.every((value, index) => value === stored.viewBox[index]) &&
        page.textHash === stored.pageTextHash &&
        page.text.slice(stored.start, stored.end) === stored.quote &&
        page.text.slice(Math.max(0, stored.start - PDF_TARGET_LIMITS.context), stored.start) ===
          stored.prefix &&
        page.text.slice(stored.end, stored.end + PDF_TARGET_LIMITS.context) === stored.suffix
      );
    });
  return { material, selectorValid };
}

export interface PdfTextRange {
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

export type PdfRelocation =
  | { readonly _tag: "Found"; readonly ranges: ReadonlyArray<PdfTextRange> }
  | { readonly _tag: "Ambiguous" }
  | { readonly _tag: "NotFound" }
  /** The search could not read every page, so absence proves nothing. */
  | { readonly _tag: "Incomplete" };

function occurrences(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * Finds the quote again in a changed document. The pages are searched as one
 * ordered text, so a quote that crossed a page boundary is found across it.
 * Uniqueness is over the whole document: the quote with its context first,
 * then the quote alone; anything repeated is ambiguous, never guessed.
 */
export function relocatePdfText(
  target: PdfTarget,
  document: {
    readonly pages: ReadonlyArray<{ readonly page: number; readonly text: string }>;
    /** Every page of the document was read. */
    readonly complete: boolean;
  },
): PdfRelocation {
  const stored = target.selector.pages;
  const quote = stored.map((page) => page.quote).join("");
  const prefix = stored[0]!.prefix;
  const suffix = stored.at(-1)!.suffix;
  const pages = [...document.pages].toSorted((a, b) => a.page - b.page);
  const starts: number[] = [];
  let text = "";
  for (const page of pages) {
    starts.push(text.length);
    text += page.text;
  }

  const locate = (at: number): PdfTextRange[] => {
    const ranges: PdfTextRange[] = [];
    const end = at + quote.length;
    for (let index = 0; index < pages.length; index += 1) {
      const pageStart = starts[index]!;
      const pageEnd = pageStart + pages[index]!.text.length;
      const from = Math.max(at, pageStart);
      const to = Math.min(end, pageEnd);
      if (from < to)
        ranges.push({ page: pages[index]!.page, start: from - pageStart, end: to - pageStart });
    }
    return ranges;
  };

  const withContext = occurrences(text, prefix + quote + suffix, 2);
  // A repeat with its context is ambiguous whatever the unread pages hold.
  if (withContext.length > 1) return { _tag: "Ambiguous" };
  // Anything else depends on every page: an unread one could hold the unique
  // contextual match, or a repeat.
  if (!document.complete) return { _tag: "Incomplete" };
  if (withContext.length === 1) {
    return { _tag: "Found", ranges: locate(withContext[0]! + prefix.length) };
  }
  const bare = occurrences(text, quote, 2);
  if (bare.length > 1) return { _tag: "Ambiguous" };
  if (bare.length === 1) return { _tag: "Found", ranges: locate(bare[0]!) };
  return { _tag: "NotFound" };
}
