import { describe, expect, it } from "@effect/vitest";

import type { PdfPageText } from "../annotations/pdfQuoteAnchor.ts";
import { placeZoteroAnnotations } from "./ZoteroAnnotations.ts";
import type { ZoteroPdfAnnotation } from "./ZoteroItems.ts";

const page = (number: number, lines: ReadonlyArray<string>): PdfPageText => ({
  page: number,
  text: lines.join("\n"),
  viewBox: [0, 0, 612, 792],
  rotation: 0,
  userUnit: 1,
});

// Constructed: no public Zotero library hands out the PDFs its highlights were made on.
const lines = [
  "Results were strong in the first trial.",
  "The effect held in every group we tested.",
  "It was strong, and it held over two years of follow up in all of the sites.",
  "Later work found the same: the effect held in every group we tested.",
];
const text = { extractorVersion: "test", pages: [page(1, lines), page(2, ["Methods."])] };
const nonSpace = (value: string) => value.replace(/\s/gu, "").length;

const annotation = (
  key: string,
  fields: Partial<ZoteroPdfAnnotation> & Pick<ZoteroPdfAnnotation, "text">,
): ZoteroPdfAnnotation => ({
  key,
  attachmentKey: "PDFA2345",
  kind: "highlight",
  page: 1,
  comment: "",
  color: "#ffd400",
  offset: null,
  addedAt: "2024-01-24T04:36:20Z",
  ...fields,
});

describe("placing Zotero's highlights", () => {
  it("places a quote found once on its page, or singled out by Zotero's position, and keeps the rest", () => {
    const repeated = "the effect held in every group we tested";
    const second = nonSpace(lines.slice(0, 3).join("") + "Later work found the same:");
    const { placed, unplaced } = placeZoteroAnnotations(
      [
        annotation("ONCE2345", { text: "strong in the first", comment: "Key", color: "#ff6666" }),
        annotation("NEAR2345", { kind: "underline", text: repeated, offset: second + 3 }),
        // Halfway between the two: Zotero's position decides nothing, so it is not guessed.
        annotation("HALF2345", { text: repeated, offset: Math.round(second / 2) }),
        annotation("NONE2345", { text: repeated }),
        annotation("GONE2345", { text: "Not in the text", page: 2 }),
        annotation("IMAG2345", { kind: "image", text: "", comment: "Figure 2" }),
      ],
      text,
      "2026-11-15T09:00:00.000Z",
    );

    expect(
      placed.map((entry) => ({
        id: entry.annotationId,
        at: entry.anchor.selector.pages[0]?.start,
        note: entry.note,
        color: entry.color,
        underline: entry.underline,
        dated: entry.at,
      })),
    ).toEqual([
      {
        id: "ann_zotero_ONCE2345",
        at: lines[0]!.indexOf("strong"),
        note: "Key",
        color: "#ff6666",
        underline: undefined,
        dated: "2024-01-24T04:36:20Z",
      },
      {
        id: "ann_zotero_NEAR2345",
        at: text.pages[0]!.text.lastIndexOf(repeated),
        note: "",
        color: "#ffd400",
        underline: true,
        dated: "2024-01-24T04:36:20Z",
      },
    ]);
    expect(
      unplaced.map(({ annotationId, kind, page: on, quote, comment }) => [
        annotationId,
        kind,
        on,
        quote,
        comment,
      ]),
    ).toEqual([
      ["ann_zotero_HALF2345", "highlight", 1, repeated, ""],
      ["ann_zotero_NONE2345", "highlight", 1, repeated, ""],
      ["ann_zotero_GONE2345", "highlight", 2, "Not in the text", ""],
      ["ann_zotero_IMAG2345", "image", 1, "", "Figure 2"],
    ]);
  });

  it("keeps every one of a PDF without text, with its page, quote and comment", () => {
    const { placed, unplaced } = placeZoteroAnnotations(
      [annotation("SCAN2345", { text: "strong in the first", comment: "Scanned" })],
      null,
      "2026-11-15T09:00:00.000Z",
    );

    expect(placed).toEqual([]);
    expect(unplaced).toEqual([
      {
        annotationId: "ann_zotero_SCAN2345",
        revision: 1,
        kind: "highlight",
        page: 1,
        quote: "strong in the first",
        comment: "Scanned",
        color: "#ffd400",
        createdAt: "2024-01-24T04:36:20Z",
        deletedAt: null,
      },
    ]);
  });
});
