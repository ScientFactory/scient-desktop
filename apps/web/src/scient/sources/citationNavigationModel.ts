import { citationLocatorPage, type CitationItem } from "@scientfactory/scient-sources";
import {
  liveScientAnnotations,
  scientAnnotationQuote,
  type ScientPdfAnnotation,
} from "@t3tools/contracts";

import { quoteProse } from "../annotations/quoteFormat";
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

/**
 * Where in its PDF a citation opens. A quote is shown as the one highlight with the same words
 * (several are narrowed by the citation's page, compared with the highlight's page number);
 * otherwise the cited page is shown by its label. `highlights` is null when they could not be read.
 */
export function citationReveal(
  step: Extract<CitationOpenStep, { _tag: "Pdf" }>,
  highlights: ReadonlyArray<{
    readonly attachmentId: string;
    readonly annotations: ReadonlyArray<ScientPdfAnnotation>;
  }> | null,
): CitationReveal {
  let notice: CitationPassageNotice | null = null;
  const { quote, pageLabel } = step;
  if (quote !== null) {
    if (highlights === null) {
      notice = "unread";
    } else {
      const matches = highlights.flatMap((pdf) =>
        liveScientAnnotations(pdf.annotations)
          .filter((annotation) => quoteProse(scientAnnotationQuote(annotation)) === quote)
          .map((annotation) => ({ attachmentId: pdf.attachmentId, annotation })),
      );
      const narrowed =
        matches.length > 1 && pageLabel !== null
          ? matches.filter(
              (match) => String(match.annotation.anchor.selector.pages[0]?.page) === pageLabel,
            )
          : matches;
      const [only] = narrowed;
      if (only && narrowed.length === 1) return { _tag: "Highlight", ...only };
      notice = matches.length === 0 ? "not-found" : "repeated";
    }
  }
  return pageLabel === null ? { _tag: "Details", notice } : { _tag: "Page", pageLabel, notice };
}
