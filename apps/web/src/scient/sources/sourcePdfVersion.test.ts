import { describe, expect, it } from "vite-plus/test";

import { pdfVersionLabel } from "./sourcePdfVersion";

describe("pdfVersionLabel", () => {
  it("names a PDF that is not the published version", () => {
    expect(pdfVersionLabel([{ retrieval: { version: "preprint" } }])).toBe(" · PDF is a preprint");
  });

  it("says nothing once any PDF is published or its version was never recorded", () => {
    expect(
      pdfVersionLabel([
        { retrieval: { version: "preprint" } },
        { retrieval: { version: "published" } },
      ]),
    ).toBe("");
    expect(pdfVersionLabel([{ retrieval: { version: "accepted" } }, {}])).toBe("");
    expect(pdfVersionLabel([])).toBe("");
  });
});
