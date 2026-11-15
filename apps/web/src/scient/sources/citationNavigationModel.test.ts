import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import { pandocCitationItems } from "@scientfactory/scient-sources";
import type { ScientPdfAnnotation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  citationOpenStep,
  citationReveal,
  resolveCitationEntries,
  type CitationOpenStep,
} from "./citationNavigationModel";
import type { LibraryCitationCandidate } from "./libraryCitations";

const pdf = { attachmentId: "pdf_1", fileName: "notes.pdf" };
const lovelace: LibraryCitationCandidate = {
  sourceId: "a",
  citationKey: "lovelace1843notes",
  label: "Lovelace 1843",
  title: "Notes",
  pdf,
};
const turing: LibraryCitationCandidate = {
  sourceId: "b",
  citationKey: "Turing1950",
  label: "Turing 1950",
  title: "Computing machinery and intelligence",
};

function annotation(
  id: string,
  page: number,
  quote: string,
  deletedAt: string | null = null,
): ScientPdfAnnotation {
  return {
    annotationId: `ann_${id.padEnd(8, "0")}`,
    revision: 1,
    anchor: {
      extractor: { profile: PDF_TEXT_PROFILE, version: "1" },
      selector: {
        type: "text",
        pages: [
          {
            page,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "0".repeat(64),
            start: 0,
            end: quote.length,
            quote,
            prefix: "",
            suffix: "",
          },
        ],
      },
    },
    highlighted: true,
    note: "",
    createdAt: "t",
    createdBy: "user",
    updatedAt: "t",
    updatedBy: "user",
    deletedAt,
  };
}

function step(locator: string | null, quote: string | null) {
  const opened = citationOpenStep({ candidate: lovelace, item: { key: "x", locator } }, quote);
  if (opened._tag !== "Pdf") throw new Error("Expected the PDF to open.");
  return opened satisfies CitationOpenStep;
}

describe("resolveCitationEntries", () => {
  it("keeps every known source of a group, so several are offered, never the first", () => {
    const entries = resolveCitationEntries(
      [lovelace, turing],
      pandocCitationItems("@lovelace1843notes, p. 4; @turing1950; @unknown"),
    );
    expect(entries.map((entry) => [entry.candidate.sourceId, entry.item.locator])).toEqual([
      ["a", "p. 4"],
      ["b", null],
    ]);
    expect(resolveCitationEntries([lovelace], pandocCitationItems("@unknown"))).toEqual([]);
  });

  it("prefers an exact key and offers each source sharing a key", () => {
    const exact = { ...turing, sourceId: "c", citationKey: "turing1950" };
    expect(
      resolveCitationEntries([turing, exact], pandocCitationItems("@turing1950")).map(
        (entry) => entry.candidate.sourceId,
      ),
    ).toEqual(["c"]);
    const twin = { ...lovelace, sourceId: "d" };
    expect(
      resolveCitationEntries([lovelace, twin], pandocCitationItems("@lovelace1843notes")),
    ).toHaveLength(2);
  });
});

describe("citationOpenStep", () => {
  it("shows the details when there is no place to go, or no PDF to go to", () => {
    const entry = (candidate: LibraryCitationCandidate, locator: string | null) => ({
      candidate,
      item: { key: candidate.citationKey, locator },
    });
    expect(citationOpenStep(entry(lovelace, null), null)).toEqual({
      _tag: "Details",
      noPdf: false,
    });
    expect(citationOpenStep(entry(lovelace, "chap. 3"), null)).toEqual({
      _tag: "Details",
      noPdf: false,
    });
    expect(citationOpenStep(entry(turing, "p. 4"), null)).toEqual({ _tag: "Details", noPdf: true });
    expect(citationOpenStep(entry(turing, null), "A quoted passage.")).toEqual({
      _tag: "Details",
      noPdf: true,
    });
    expect(citationOpenStep(entry(lovelace, "pp. xii–xv"), null)).toEqual({
      _tag: "Pdf",
      pdf,
      quote: null,
      pageLabel: "xii",
    });
  });
});

describe("citationReveal", () => {
  it("reveals the one highlight with the quoted words, across line breaks", () => {
    const highlight = annotation("one", 7, "The engine might act upon other num-\nbers too.");
    expect(
      citationReveal(step("p. 7", "The engine might act upon other numbers too."), [
        { attachmentId: "pdf_2", annotations: [annotation("other", 1, "Elsewhere."), highlight] },
      ]),
    ).toEqual({ _tag: "Highlight", attachmentId: "pdf_2", annotation: highlight });
  });

  it("narrows highlights sharing the words by the cited page", () => {
    const first = annotation("first", 2, "Same words.");
    const second = annotation("second", 5, "Same words.");
    const highlights = [{ attachmentId: "pdf_1", annotations: [first, second] }];
    expect(citationReveal(step("p. 5", "Same words."), highlights)).toEqual({
      _tag: "Highlight",
      attachmentId: "pdf_1",
      annotation: second,
    });
    expect(citationReveal(step("p. v", "Same words."), highlights)).toEqual({
      _tag: "Page",
      pageLabel: "v",
      notice: "repeated",
    });
    expect(citationReveal(step(null, "Same words."), highlights)).toEqual({
      _tag: "Details",
      notice: "repeated",
    });
  });

  it("goes to the cited page, or the details, when the passage is not a highlight", () => {
    const deleted = [{ attachmentId: "pdf_1", annotations: [annotation("gone", 3, "Gone.", "t")] }];
    expect(citationReveal(step(null, "Gone."), deleted)).toEqual({
      _tag: "Details",
      notice: "not-found",
    });
    expect(citationReveal(step("p. 3", "Gone."), null)).toEqual({
      _tag: "Page",
      pageLabel: "3",
      notice: "unread",
    });
    expect(citationReveal(step("p. 4", null), [])).toEqual({
      _tag: "Page",
      pageLabel: "4",
      notice: null,
    });
  });
});
