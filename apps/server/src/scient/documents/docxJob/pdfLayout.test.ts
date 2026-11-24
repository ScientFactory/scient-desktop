import { describe, expect, it } from "@effect/vitest";

import { checkPdfPlacement, type PdfLayout, type PdfTextItem } from "./pdfLayout.ts";

const item = (str: string, x: number, y: number, width = str.length * 6): PdfTextItem => ({
  str,
  x,
  y,
  width,
  size: 12,
});

const layout = (pages: ReadonlyArray<ReadonlyArray<PdfTextItem>>, unembedded: string[] = []) =>
  ({
    pages,
    fonts: ["AAAAAA+Body"],
    unembeddedFonts: unembedded,
    producer: "LibreOffice 26.2",
  }) satisfies PdfLayout;

const cover = [item("Title", 50, 800)];
const table = [item("Table", 50, 800), item("1.5%", 300, 780)];
const source = layout([
  cover,
  [item("before", 300, 600), item("QC-1", 240, 600, 40), item("after", 150, 600)],
  table,
]);
const candidate = (edited: ReadonlyArray<PdfTextItem>, rest = table) =>
  layout([cover, edited, rest]);
const failed = (result: ReturnType<typeof checkPdfPlacement>) =>
  result.checks.filter((check) => !check.passed).map((check) => check.id);

describe("PDF placement of a tracked replacement", () => {
  it("accepts the insertion beside the deletion, even when the line rewraps", () => {
    const result = checkPdfPlacement(
      source,
      candidate([
        item("before", 300, 600),
        item("QC-1", 200, 600, 40),
        item("QC-2", 240, 600, 40),
        item("after", 300, 585),
      ]),
      "QC-1",
      "QC-2",
    );
    expect(failed(result)).toEqual([]);
    expect(result).toMatchObject({ passed: true, pageCount: 3, editPage: 2 });
  });

  it("accepts an insertion wrapped onto the next line", () => {
    const result = checkPdfPlacement(
      source,
      candidate([
        item("before", 300, 600),
        item("QC-1", 240, 600, 40),
        item("QC-2", 400, 585, 40),
        item("after", 350, 585),
      ]),
      "QC-1",
      "QC-2",
    );
    expect(failed(result)).toEqual([]);
  });

  it("checks the edited span when one revision contains the other", () => {
    const original = layout([[item("trial", 60, 600)]]);
    const edit = (x: number) => layout([[item("trial", x, 600), item("trials", x + 30, 600)]]);
    expect(failed(checkPdfPlacement(original, edit(60), "trial", "trials"))).toEqual([]);
    expect(failed(checkPdfPlacement(original, edit(420), "trial", "trials"))).toEqual([
      "pdf-edit-placement",
    ]);
  });

  it("refuses blank search and replacement text", () => {
    expect(checkPdfPlacement(source, source, " ", "QC-2").passed).toBe(false);
    expect(checkPdfPlacement(source, source, "QC-1", " ").passed).toBe(false);
  });

  it("flags search text that also appears in a running header", () => {
    const repeated = layout([[...source.pages[1]!, item("QC-1", 60, 790)]]);
    expect(checkPdfPlacement(repeated, repeated, "QC-1", "QC-2")).toMatchObject({
      passed: false,
      ambiguousSourceText: true,
    });
  });

  it("names each way the render can disagree with the source", () => {
    const edited = [
      item("before", 300, 600),
      item("QC-1", 200, 600, 40),
      item("QC-2", 240, 600, 40),
      item("after", 150, 600),
    ];
    expect(failed(checkPdfPlacement(source, layout([cover, edited]), "QC-1", "QC-2"))).toEqual([
      "pdf-page-count",
      "pdf-text-sequence-preserved",
    ]);
    // Hidden or dropped insertion.
    expect(
      failed(
        checkPdfPlacement(
          source,
          candidate([
            item("before", 300, 600),
            item("QC-1", 240, 600, 40),
            item("after", 150, 600),
          ]),
          "QC-1",
          "QC-2",
        ),
      ),
    ).toEqual(["pdf-tracked-text-shown", "pdf-edit-placement", "pdf-text-sequence-preserved"]);
    // The insertion lands far from the deleted text.
    expect(
      failed(
        checkPdfPlacement(
          source,
          candidate([
            item("before", 300, 600),
            item("QC-1", 240, 600, 40),
            item("QC-2", 50, 100, 40),
            item("after", 150, 600),
          ]),
          "QC-1",
          "QC-2",
        ),
      ),
    ).toEqual(["pdf-edit-placement"]);
    // An earlier page moved.
    expect(
      failed(
        checkPdfPlacement(
          source,
          layout([[item("Title", 50, 790)], edited, table]),
          "QC-1",
          "QC-2",
        ),
      ),
    ).toEqual(["pdf-earlier-pages-unchanged"]);
    // Text elsewhere changed.
    expect(
      failed(
        checkPdfPlacement(source, candidate(edited, [item("Table", 50, 800)]), "QC-1", "QC-2"),
      ),
    ).toEqual(["pdf-text-sequence-preserved"]);
    // A font is not embedded.
    expect(
      failed(checkPdfPlacement(source, layout([cover, edited, table], ["Body"]), "QC-1", "QC-2")),
    ).toEqual(["pdf-fonts-embedded"]);
    // The source render does not show the text at all.
    expect(failed(checkPdfPlacement(source, candidate(edited), "QC-9", "QC-2"))).toContain(
      "pdf-source-text-located",
    );
  });
});
