import { describe, expect, it } from "@effect/vitest";

import {
  importScientAnnotations,
  readScientAnnotationFile,
} from "../annotations/annotationStore.ts";
import type { PdfPageText } from "../annotations/pdfQuoteAnchor.ts";
import { temporaryProject } from "../annotations/annotationTestUtils.ts";
import { zoteroItem } from "./Zotero.testkit.ts";
import { placeZoteroAnnotations } from "./ZoteroAnnotations.ts";
import { zoteroItemMaterial, type ZoteroPdfAnnotation } from "./ZoteroItems.ts";

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

const annotation = (
  key: string,
  fields: Partial<ZoteroPdfAnnotation> & Pick<ZoteroPdfAnnotation, "text">,
): ZoteroPdfAnnotation => ({
  key,
  libraryId: "475425",
  attachmentKey: "PDFA2345",
  kind: "highlight",
  page: 1,
  comment: "",
  color: "#ffd400",
  addedAt: "2024-01-24T04:36:20Z",
  ...fields,
});

describe("placing Zotero's highlights", () => {
  it("places a quote found once on its page and keeps the rest, a repeated one too", () => {
    const repeated = "the effect held in every group we tested";
    // As Zotero sends it, with its count of the characters before the second one: that
    // count comes from another reading of the page, so it decides nothing here.
    const before = (lines.slice(0, 3).join("") + "Later work found the same:").replace(/\s/gu, "");
    const sortIndex = { annotationSortIndex: `00000|${before.length + 3}|00100` };
    const [underline] = zoteroItemMaterial(zoteroItem("ABCD2345"), [
      zoteroItem("REPT2345", {
        itemType: "annotation",
        parentItem: "PDFA2345",
        annotationType: "underline",
        annotationText: repeated,
        annotationColor: "#ffd400",
        annotationPosition: JSON.stringify({ pageIndex: 0, rects: [] }),
        ...sortIndex,
      }),
    ]).annotations;
    const { placed, unplaced } = placeZoteroAnnotations(
      [
        annotation("ONCE2345", { text: "strong in the first", comment: "Key", color: "#ff6666" }),
        underline!,
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
        id: "ann_zotero_user_475425_ONCE2345",
        at: lines[0]!.indexOf("strong"),
        note: "Key",
        color: "#ff6666",
        underline: undefined,
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
      ["ann_zotero_user_0_REPT2345", "underline", 1, repeated, ""],
      ["ann_zotero_user_475425_GONE2345", "highlight", 2, "Not in the text", ""],
      ["ann_zotero_user_475425_IMAG2345", "image", 1, "", "Figure 2"],
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
        annotationId: "ann_zotero_user_475425_SCAN2345",
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

  it("keeps a group's highlight apart from one of My Library with the same key, on one PDF and on two", async () => {
    await using project = await temporaryProject();
    const mine = annotation("ABCD2345", { text: "strong in the first", comment: "Mine" });
    const lab = { ...mine, libraryId: "groups/4321", comment: "The lab's" };
    const bring = (sha256: string, entry: ZoteroPdfAnnotation) =>
      importScientAnnotations({
        canonicalRoot: project.root,
        material: { sha256, byteLength: 100 },
        ...placeZoteroAnnotations([entry], text, "2026-11-15T09:00:00.000Z"),
      });
    const marks = async (sha256: string) =>
      (await readScientAnnotationFile(project.root, sha256))?.annotations.map((entry) => [
        entry.annotationId,
        entry.note,
      ]);
    const [one, first, second] = ["a", "b", "c"].map((digit) => digit.repeat(64)) as [
      string,
      string,
      string,
    ];

    await bring(one, mine);
    await bring(one, lab);
    await bring(first, mine);
    await bring(second, lab);

    expect(await marks(one)).toEqual([
      ["ann_zotero_user_475425_ABCD2345", "Mine"],
      ["ann_zotero_group_4321_ABCD2345", "The lab's"],
    ]);
    // An agent finds a highlight by its ID alone, in the first file that has it.
    expect([await marks(first), await marks(second)]).toEqual([
      [["ann_zotero_user_475425_ABCD2345", "Mine"]],
      [["ann_zotero_group_4321_ABCD2345", "The lab's"]],
    ]);
  });
});
