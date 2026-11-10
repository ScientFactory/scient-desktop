import { describe, expect, it } from "@effect/vitest";

import {
  detectSourceIdentifier,
  isbn13,
  isValidIsbn,
  parseSourceIdentifierList,
} from "./identifierInput.ts";

describe("detectSourceIdentifier", () => {
  it.each([
    ["10.1000/ABC.123", { scheme: "doi", value: "10.1000/abc.123" }],
    ["doi: 10.1000/abc.123.", { scheme: "doi", value: "10.1000/abc.123" }],
    ["https://doi.org/10.1000/a%2Fb", { scheme: "doi", value: "10.1000/a/b" }],
    ["10.1000/(abc)123)", { scheme: "doi", value: "10.1000/(abc)123" }],
    ["arXiv:1706.03762v7", { scheme: "arxiv", value: "1706.03762" }],
    ["https://arxiv.org/pdf/1706.03762v2.pdf", { scheme: "arxiv", value: "1706.03762" }],
    ["2401.01234", { scheme: "arxiv", value: "2401.01234" }],
    ["arXiv:math.GT/0309136", { scheme: "arxiv", value: "math.gt/0309136" }],
    ["PMID: 31452104", { scheme: "pmid", value: "31452104" }],
    ["https://pubmed.ncbi.nlm.nih.gov/31452104/", { scheme: "pmid", value: "31452104" }],
    ["31452104", { scheme: "pmid", value: "31452104" }],
    ["ISBN 978-0-262-03384-8", { scheme: "isbn", value: "9780262033848" }],
    ["0-262-03384-4", { scheme: "isbn", value: "9780262033848" }],
    ["080442957X", { scheme: "isbn", value: "9780804429573" }],
  ])("reads %s", (text, expected) => {
    expect(detectSourceIdentifier(text)).toEqual(expected);
  });

  it.each([
    "Attention is all you need",
    "arXiv:not-an-id",
    "ISBN 978-0-262-03384-9",
    "PMID 0123",
    "1234567890123",
  ])("rejects %s", (text) => {
    expect(detectSourceIdentifier(text)).toBeNull();
  });
});

describe("ISBN check digits", () => {
  it("accepts valid ISBN-10 and ISBN-13 and converts to ISBN-13", () => {
    expect(isValidIsbn("0262033844")).toBe(true);
    expect(isValidIsbn("0262033845")).toBe(false);
    expect(isbn13("0-262-03384-4")).toBe("9780262033848");
    expect(isbn13("9790000000001")).toBe("9790000000001");
    expect(isbn13("9790000000002")).toBeNull();
  });
});

describe("parseSourceIdentifierList", () => {
  it("splits a pasted list, drops repeats and keeps unreadable parts", () => {
    expect(
      parseSourceIdentifierList(
        [
          "10.1000/abc.123",
          "https://doi.org/10.1000/ABC.123",
          "PMID 31452104, arXiv:1706.03762; 0-262-03384-4",
          "2401.01234 2401.05678",
          "Smith et al. 2020",
          "Smith et al. 2020",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { input: "10.1000/abc.123", identifier: { scheme: "doi", value: "10.1000/abc.123" } },
      { input: "PMID 31452104", identifier: { scheme: "pmid", value: "31452104" } },
      { input: "arXiv:1706.03762", identifier: { scheme: "arxiv", value: "1706.03762" } },
      { input: "0-262-03384-4", identifier: { scheme: "isbn", value: "9780262033848" } },
      { input: "2401.01234", identifier: { scheme: "arxiv", value: "2401.01234" } },
      { input: "2401.05678", identifier: { scheme: "arxiv", value: "2401.05678" } },
      { input: "Smith et al. 2020", identifier: null },
    ]);
  });

  it("splits lists without spaces but keeps a DOI that contains a semicolon whole", () => {
    expect(
      parseSourceIdentifierList(
        [
          "10.1000/alpha,10.1000/beta",
          "10.1000/gamma;PMID:12345",
          "10.1002/(SICI)1097-4636(199706)35:4<487::AID-JBM9>3.0.CO;2-B",
          "10.1000/appendix;isbn:notes",
          "https://doi.org/10.1000/annex,isbn:notes",
        ].join("\n"),
      ).map((entry) => entry.identifier),
    ).toEqual([
      { scheme: "doi", value: "10.1000/alpha" },
      { scheme: "doi", value: "10.1000/beta" },
      { scheme: "doi", value: "10.1000/gamma" },
      { scheme: "pmid", value: "12345" },
      { scheme: "doi", value: "10.1002/(sici)1097-4636(199706)35:4<487::aid-jbm9>3.0.co;2-b" },
      { scheme: "doi", value: "10.1000/appendix;isbn:notes" },
      { scheme: "doi", value: "10.1000/annex,isbn:notes" },
    ]);
  });

  it("finds identifiers inside a reference line without reading its year as a PMID", () => {
    expect(
      parseSourceIdentifierList(
        "Vaswani A. Attention is all you need. 2017. doi:10.48550/arXiv.1706.03762",
      ),
    ).toEqual([
      {
        input: "doi:10.48550/arXiv.1706.03762",
        identifier: { scheme: "doi", value: "10.48550/arxiv.1706.03762" },
      },
    ]);
  });
});
