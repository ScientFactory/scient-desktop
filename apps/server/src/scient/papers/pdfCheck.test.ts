import { expect, it } from "@effect/vitest";
import { pdfVerdict } from "./pdfCheck.ts";

const paper = {
  doi: "10.1000/abc",
  title: "Volumetric medical image segmentation with transformers",
  pages: 12,
};
const body = "x".repeat(300);

it("accepts the paper by its DOI or most of its title", () => {
  expect(
    pdfVerdict(paper, { pages: 12, text: `${body} 10.1000/ABC`, firstPage: "Volumetric" }),
  ).toBe("the-paper");
  expect(
    pdfVerdict(paper, {
      pages: 12,
      text: `${body} volumetric image segmentation transformers`,
      firstPage: "Volumetric",
    }),
  ).toBe("the-paper");
});

it("refuses a first-page preview of a longer paper", () => {
  expect(pdfVerdict(paper, { pages: 1, text: `${body} 10.1000/abc`, firstPage: "" })).toBe(
    "preview",
  );
});

it("refuses a readable PDF that is about something else", () => {
  expect(
    pdfVerdict(paper, { pages: 12, text: `${body} journal subscription terms`, firstPage: "" }),
  ).toBe("another-paper");
});

it("refuses a supplement, which shares the paper's title", () => {
  expect(
    pdfVerdict(paper, {
      pages: 12,
      text: `${body} volumetric image segmentation transformers`,
      firstPage: "Supplementary Materials for Volumetric medical image segmentation",
    }),
  ).toBe("supplement");
});

it("keeps a scan, which has no text to judge it by", () => {
  expect(pdfVerdict(paper, { pages: 12, text: "", firstPage: "" })).toBe("the-paper");
});
