import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import { pandocCitationItems } from "@scientfactory/scient-sources";
import type { ScientPdfAnnotation, ScientSourceCitationKeyResolution } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PdfPageLabels } from "../annotations/pdfQuotePageLabels";
import {
  checkedCitationEntries,
  citationLabelsNeeded,
  citationOpenStep,
  citationReveal,
  resolveCitationEntries,
  type CitationEntry,
  type CitationOpenStep,
} from "./citationNavigationModel";
import type { LibraryCitationCandidate } from "./libraryCitations";

const NO_LABELS: PdfPageLabels = { _tag: "None" };
const UNREAD: PdfPageLabels = { _tag: "Unread" };
const labelled = (...labels: ReadonlyArray<string>): PdfPageLabels => ({
  _tag: "Labels",
  labels,
});

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

  it("narrows highlights sharing the words by the cited page, in a PDF without labels", () => {
    const first = annotation("first", 2, "Same words.");
    const second = annotation("second", 5, "Same words.");
    const highlights = [{ attachmentId: "pdf_1", annotations: [first, second] }];
    const labels = new Map([["pdf_1", NO_LABELS]]);
    expect(citationLabelsNeeded(step("p. 5", "Same words."), highlights)).toEqual(["pdf_1"]);
    expect(citationReveal(step("p. 5", "Same words."), highlights, labels)).toEqual({
      _tag: "Highlight",
      attachmentId: "pdf_1",
      annotation: second,
    });
    expect(citationReveal(step("p. v", "Same words."), highlights, labels)).toEqual({
      _tag: "Page",
      pageLabel: "v",
      notice: "repeated",
    });
    expect(citationLabelsNeeded(step(null, "Same words."), highlights)).toEqual([]);
    expect(citationReveal(step(null, "Same words."), highlights)).toEqual({
      _tag: "Details",
      notice: "repeated",
    });
  });

  it("compares the cited page with each highlight's printed page, never its PDF page", () => {
    // Printed "i, 1, 2": the quote from PDF page 3 cites p. 2.
    const printedOne = annotation("printed1", 2, "Same words.");
    const printedTwo = annotation("printed2", 3, "Same words.");
    const highlights = [{ attachmentId: "pdf_1", annotations: [printedOne, printedTwo] }];
    const labels = new Map([["pdf_1", labelled("i", "1", "2")]]);
    expect(citationReveal(step("p. 2", "Same words."), highlights, labels)).toEqual({
      _tag: "Highlight",
      attachmentId: "pdf_1",
      annotation: printedTwo,
    });
    // Labels not read: no pick, the cited page instead.
    for (const unread of [new Map([["pdf_1", UNREAD]]), new Map()]) {
      expect(citationReveal(step("p. 2", "Same words."), highlights, unread)).toEqual({
        _tag: "Page",
        pageLabel: "2",
        notice: "repeated",
      });
    }
    // A label two pages share leaves both.
    expect(
      citationReveal(
        step("p. 1", "Same words."),
        [{ attachmentId: "pdf_1", annotations: [annotation("one", 1, "Same words."), printedOne] }],
        new Map([["pdf_1", labelled("1", "1", "2")]]),
      ),
    ).toEqual({ _tag: "Page", pageLabel: "1", notice: "repeated" });
  });

  it("reads each PDF's own labels when the words are highlighted in two", () => {
    const labelledPdf = annotation("labelled", 2, "Same words.");
    const plainPdf = annotation("plain", 2, "Same words.");
    const highlights = [
      { attachmentId: "pdf_1", annotations: [labelledPdf] },
      { attachmentId: "pdf_2", annotations: [plainPdf] },
    ];
    expect(citationLabelsNeeded(step("p. 2", "Same words."), highlights)).toEqual([
      "pdf_1",
      "pdf_2",
    ]);
    const labels = new Map([
      ["pdf_1", labelled("i", "1", "2")],
      ["pdf_2", NO_LABELS],
    ]);
    // PDF page 2 is printed "1" in the first and "2" in the second.
    expect(citationReveal(step("p. 2", "Same words."), highlights, labels)).toEqual({
      _tag: "Highlight",
      attachmentId: "pdf_2",
      annotation: plainPdf,
    });
    expect(citationReveal(step("p. 1", "Same words."), highlights, labels)).toEqual({
      _tag: "Highlight",
      attachmentId: "pdf_1",
      annotation: labelledPdf,
    });
    // One PDF unread: no pick even where the other would decide.
    expect(
      citationReveal(
        step("p. 2", "Same words."),
        highlights,
        new Map<string, PdfPageLabels>([
          ["pdf_1", UNREAD],
          ["pdf_2", NO_LABELS],
        ]),
      ),
    ).toEqual({ _tag: "Page", pageLabel: "2", notice: "repeated" });
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

describe("checkedCitationEntries", () => {
  const smith: LibraryCitationCandidate = { ...turing, sourceId: "s", citationKey: "smith2020" };
  const entriesOf = (source: string) =>
    resolveCitationEntries([lovelace, smith], pandocCitationItems(source));
  const key = (
    name: string,
    status: ScientSourceCitationKeyResolution["status"],
    sourceIds: ReadonlyArray<string>,
    bibliography: string | null = null,
  ): ScientSourceCitationKeyResolution => ({ key: name, status, sourceIds, bibliography });
  const ids = (entries: ReadonlyArray<CitationEntry>) =>
    entries.map((entry) => entry.candidate.sourceId);

  it("leaves out a key the document defines as another work, and opens the Library one", () => {
    const checked = checkedCitationEntries(entriesOf("@lovelace1843notes; @smith2020"), [
      key("lovelace1843notes", "library", ["a"]),
      key("smith2020", "other-work", [], "refs.bib"),
    ]);
    expect(ids(checked.entries)).toEqual(["a"]);
    expect(checked.notices).toEqual([
      { title: "In this document, smith2020 is another work (refs.bib), not the Library source." },
    ]);
  });

  it("opens nothing when every key is another work here", () => {
    const checked = checkedCitationEntries(entriesOf("@smith2020"), [
      key("smith2020", "other-work", [], "paper/refs.bib"),
    ]);
    expect(checked.entries).toEqual([]);
    expect(checked.notices).toHaveLength(1);
  });

  it("keeps a key not confirmed to be the Library source, and says so", () => {
    const checked = checkedCitationEntries(entriesOf("@smith2020, p. 4"), [
      key("smith2020", "unconfirmed", ["s"], "refs.bib"),
    ]);
    expect(ids(checked.entries)).toEqual(["s"]);
    expect(checked.notices).toEqual([
      {
        title:
          "Not confirmed to be the Library source: refs.bib defines smith2020 without an identifier to compare.",
      },
    ]);
  });

  it("opens only the sources a shared key names in this document", () => {
    const twin = { ...smith, sourceId: "t" };
    const entries = resolveCitationEntries([smith, twin], pandocCitationItems("@smith2020"));
    expect(ids(entries)).toEqual(["s", "t"]);
    const checked = checkedCitationEntries(entries, [key("smith2020", "library", ["t"])]);
    expect(ids(checked.entries)).toEqual(["t"]);
    expect(checked.notices).toEqual([]);
  });

  it("opens as before when the check failed, and says it could not check", () => {
    const entries = entriesOf("@lovelace1843notes; @smith2020");
    const checked = checkedCitationEntries(entries, null);
    expect(checked.entries).toEqual(entries);
    expect(checked.notices).toEqual([
      {
        title: "Couldn't check this citation in the document's bibliography",
        description: "Opening the Library source it names in this project.",
      },
    ]);
  });
});
