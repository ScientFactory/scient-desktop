import { citationLocatorPage, type CitationItem } from "@scientfactory/scient-sources";
import {
  liveScientAnnotations,
  scientAnnotationQuote,
  type ScientPdfAnnotation,
  type ScientSourceCitationKeyResolution,
} from "@t3tools/contracts";

import type { PdfPageLabels } from "../annotations/pdfQuotePageLabels";
import { quotePageLabels, quoteProse } from "../annotations/quoteFormat";
import type { LibraryCitationCandidate } from "./libraryCitations";

/** One work a citation names, as the Library source it resolves to. */
export interface CitationEntry {
  readonly candidate: LibraryCitationCandidate;
  readonly item: CitationItem;
}

/**
 * The Library sources a citation's items name, in citation order: by exact key, else by key
 * without regard to case. Every source a key matches is kept, so two sources sharing a key are
 * both offered rather than one picked. Unknown keys and non-Library entries are left out.
 */
export function resolveCitationEntries(
  candidates: ReadonlyArray<LibraryCitationCandidate>,
  items: ReadonlyArray<CitationItem>,
): ReadonlyArray<CitationEntry> {
  const library = candidates.filter((candidate) => candidate.sourceId !== "");
  const entries: CitationEntry[] = [];
  for (const item of items) {
    let found = library.filter((candidate) => candidate.citationKey === item.key);
    if (found.length === 0) {
      const folded = item.key.toLowerCase();
      found = library.filter((candidate) => candidate.citationKey.toLowerCase() === folded);
    }
    for (const candidate of found) {
      const listed = entries.some(
        (entry) =>
          entry.candidate.sourceId === candidate.sourceId && entry.item.locator === item.locator,
      );
      if (!listed) entries.push({ candidate, item });
    }
  }
  return entries;
}

export interface CitationNotice {
  readonly title: string;
  readonly description?: string;
}

/**
 * What a citation opens once its keys are checked in its document: a key the document's
 * bibliography defines as another work, or that is no Library key there, is left out; one not
 * confirmed to be the Library source is kept, and that is said. `keys` is null when the check
 * failed: every entry is kept, and that is said too.
 */
export function checkedCitationEntries(
  entries: ReadonlyArray<CitationEntry>,
  keys: ReadonlyArray<ScientSourceCitationKeyResolution> | null,
): {
  readonly entries: ReadonlyArray<CitationEntry>;
  readonly notices: ReadonlyArray<CitationNotice>;
} {
  if (keys === null) {
    return {
      entries,
      notices: [
        {
          title: "Couldn't check this citation in the document's bibliography",
          description: "Opening the Library source it names in this project.",
        },
      ],
    };
  }
  const kept: CitationEntry[] = [];
  const notices: CitationNotice[] = [];
  for (const key of new Set(entries.map((entry) => entry.item.key))) {
    const folded = key.toLowerCase();
    const resolved =
      keys.find((candidate) => candidate.key === key) ??
      keys.find((candidate) => candidate.key.toLowerCase() === folded);
    const named = entries.filter((entry) => entry.item.key === key);
    const status = resolved?.status ?? "unconfirmed";
    const bibliography = resolved?.bibliography ?? null;
    switch (status) {
      case "other-work":
        notices.push({
          title: bibliography
            ? `In this document, ${key} is another work (${bibliography}), not the Library source.`
            : `In this document, ${key} is another work, not the Library source.`,
        });
        continue;
      case "not-library":
        notices.push({ title: `In this document, ${key} is not a Library source.` });
        continue;
      case "unconfirmed":
        notices.push({
          title: bibliography
            ? `Not confirmed to be the Library source: ${bibliography} defines ${key} without an identifier to compare.`
            : `Not confirmed to be the Library source: what ${key} names in this document could not be checked.`,
        });
        break;
      case "library":
        break;
    }
    // Only the sources the key names here; all of them if the check names none this client knows.
    const sourceIds = new Set(resolved?.sourceIds ?? []);
    const namedHere = named.filter((entry) => sourceIds.has(entry.candidate.sourceId));
    kept.push(...(namedHere.length > 0 ? namedHere : named));
  }
  // Citation order, as the entries came.
  return { entries: entries.filter((entry) => kept.includes(entry)), notices };
}

const TITLE_LIMIT = 80;

/** How an entry reads where the writer chooses between several: "Lovelace 1843, p. 4", title. */
export function citationChoiceText(entry: CitationEntry): {
  readonly label: string;
  readonly detail: string | null;
} {
  const { candidate, item } = entry;
  const title = candidate.title?.trim() ?? "";
  return {
    label: item.locator ? `${candidate.label}, ${item.locator}` : candidate.label,
    detail:
      title === ""
        ? null
        : title.length > TITLE_LIMIT
          ? `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
          : title,
  };
}

export type CitationOpenStep =
  | {
      readonly _tag: "Details";
      /** The citation names a place to show, but the source has no PDF here. */
      readonly noPdf: boolean;
    }
  | {
      readonly _tag: "Pdf";
      readonly pdf: NonNullable<LibraryCitationCandidate["pdf"]>;
      /** The passage the citation closes, as prose; null when it closes none. */
      readonly quote: string | null;
      /** The printed page label its locator names. */
      readonly pageLabel: string | null;
    };

/** What opening one entry starts with, before any highlight is read. */
export function citationOpenStep(entry: CitationEntry, quote: string | null): CitationOpenStep {
  const passage = quote === null ? "" : quoteProse(quote);
  const pageLabel = citationLocatorPage(entry.item.locator);
  if (passage === "" && pageLabel === null) return { _tag: "Details", noPdf: false };
  const pdf = entry.candidate.pdf;
  if (!pdf) return { _tag: "Details", noPdf: true };
  return { _tag: "Pdf", pdf, quote: passage === "" ? null : passage, pageLabel };
}

/** Why a quoted passage is not shown as its highlight. */
export type CitationPassageNotice = "not-found" | "repeated" | "unread";

export type CitationReveal =
  | {
      readonly _tag: "Highlight";
      readonly attachmentId: string;
      readonly annotation: ScientPdfAnnotation;
    }
  | {
      readonly _tag: "Page";
      readonly pageLabel: string;
      readonly notice: CitationPassageNotice | null;
    }
  | { readonly _tag: "Details"; readonly notice: CitationPassageNotice | null };

/** A source's highlights, by PDF. */
export type CitationHighlights = ReadonlyArray<{
  readonly attachmentId: string;
  readonly annotations: ReadonlyArray<ScientPdfAnnotation>;
}>;

function quoteMatches(quote: string, highlights: CitationHighlights) {
  return highlights.flatMap((pdf) =>
    liveScientAnnotations(pdf.annotations)
      .filter((annotation) => quoteProse(scientAnnotationQuote(annotation)) === quote)
      .map((annotation) => ({ attachmentId: pdf.attachmentId, annotation })),
  );
}

/**
 * The PDFs whose page labels a quote needs to tell its highlights apart: those holding a highlight
 * with its words when several have them and the citation names a page. Empty when none is needed.
 */
export function citationLabelsNeeded(
  step: Extract<CitationOpenStep, { _tag: "Pdf" }>,
  highlights: CitationHighlights | null,
): ReadonlyArray<string> {
  if (step.quote === null || step.pageLabel === null || highlights === null) return [];
  const matches = quoteMatches(step.quote, highlights);
  return matches.length > 1 ? [...new Set(matches.map((match) => match.attachmentId))] : [];
}

/**
 * The printed page a highlight starts on, as "Quote in my document" writes it: its page label,
 * or its page number in a PDF without labels. Null when the PDF's labels could not be read.
 */
function printedPage(annotation: ScientPdfAnnotation, labels: PdfPageLabels | undefined) {
  const pages = annotation.anchor.selector.pages.map((page) => page.page);
  const [first] = pages;
  if (first === undefined || labels === undefined || labels._tag === "Unread") return null;
  if (labels._tag === "None") return String(first);
  return quotePageLabels(pages, labels.labels)?.[0] ?? String(first);
}

/**
 * Where in its PDF a citation opens: a quote as the one highlight with its words, several narrowed
 * by the cited page against each highlight's printed page (`pageLabels`, by attachment); none is
 * picked when several remain or labels are unread. `highlights` is null when unread.
 */
export function citationReveal(
  step: Extract<CitationOpenStep, { _tag: "Pdf" }>,
  highlights: CitationHighlights | null,
  pageLabels: ReadonlyMap<string, PdfPageLabels> = new Map(),
): CitationReveal {
  let notice: CitationPassageNotice | null = null;
  const { quote, pageLabel } = step;
  if (quote !== null) {
    if (highlights === null) {
      notice = "unread";
    } else {
      const matches = quoteMatches(quote, highlights);
      let narrowed = matches;
      if (matches.length > 1 && pageLabel !== null) {
        const printed = matches.map((match) =>
          printedPage(match.annotation, pageLabels.get(match.attachmentId)),
        );
        narrowed = printed.includes(null)
          ? matches
          : matches.filter((_, index) => printed[index] === pageLabel);
      }
      const [only] = narrowed;
      if (only && narrowed.length === 1) return { _tag: "Highlight", ...only };
      notice = matches.length === 0 ? "not-found" : "repeated";
    }
  }
  return pageLabel === null ? { _tag: "Details", notice } : { _tag: "Page", pageLabel, notice };
}
