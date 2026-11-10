import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import type { ScientPdfAnnotation } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { annotationRangeOnPage } from "./annotationPlacement";

const storedText = "Intro. Sleep doubled recall. Later, sleep doubled recall again.";

function annotation(quote: string, at: number): ScientPdfAnnotation {
  return {
    annotationId: "ann_placement1",
    revision: 1,
    anchor: {
      extractor: { profile: PDF_TEXT_PROFILE, version: "1" },
      selector: {
        type: "text",
        pages: [
          {
            page: 3,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "0".repeat(64),
            start: at,
            end: at + quote.length,
            quote,
            prefix: storedText.slice(Math.max(0, at - 64), at),
            suffix: storedText.slice(at + quote.length, at + quote.length + 64),
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
    deletedAt: null,
  };
}

describe("annotationRangeOnPage", () => {
  const second = annotation("sleep doubled recall", storedText.indexOf("sleep doubled recall"));

  it("keeps stored offsets that still select the quote", () => {
    expect(annotationRangeOnPage(second, 3, storedText)).toEqual({
      start: second.anchor.selector.pages[0]!.start,
      end: second.anchor.selector.pages[0]!.end,
    });
    expect(annotationRangeOnPage(second, 4, storedText)).toBeNull();
  });

  it("finds a repeated quote by its context when the page text shifted", () => {
    const shifted = `Header line. ${storedText}`;
    const range = annotationRangeOnPage(second, 3, shifted);
    expect(range && shifted.slice(range.start, range.end)).toBe("sleep doubled recall");
    expect(range!.start).toBe(shifted.indexOf("sleep doubled recall"));
  });

  it("shows nothing rather than guess between repeats without context", () => {
    const changed = "sleep doubled recall / sleep doubled recall";
    expect(annotationRangeOnPage(second, 3, changed)).toBeNull();
  });
});
