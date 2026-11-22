import { describe, expect, it } from "vite-plus/test";

import { publisherMark } from "./publisherMarks";

type Evidence = {
  type?: string;
  doi?: string;
  containerTitle?: string | null;
  publisher?: string | null;
  url?: string | null;
};

function markFor(evidence: Evidence) {
  return publisherMark({
    type: evidence.type ?? "article",
    containerTitle: evidence.containerTitle ?? null,
    publisher: evidence.publisher ?? null,
    identifiers: evidence.doi ? [{ scheme: "doi", value: evidence.doi }] : [],
    url: evidence.url ?? null,
  });
}

const nameOf = (evidence: Evidence) => markFor(evidence)?.name ?? null;

describe("publisherMark", () => {
  it("names the publisher from the DOI before the publisher field or the link", () => {
    expect(nameOf({ doi: "10.1136/bmjopen-2020-1", publisher: "Wiley" })).toBe("BMJ");
    expect(nameOf({ doi: "https://doi.org/10.1016/j.diabres.2020.1" })).toBe("Elsevier");
    expect(nameOf({ doi: "doi:10.7759/cureus.123" })).toBe("Cureus");
    expect(markFor({ doi: "10.1136/x" })?.url).toMatch(/bmj[^/]*\.png/u);
  });

  it("falls back to the publisher field, then to the article's website", () => {
    expect(nameOf({ publisher: "Springer Science and Business Media LLC" })).toBe("Springer");
    expect(nameOf({ publisher: "Mary Ann Liebert, Inc." })).toBe("Mary Ann Liebert");
    expect(nameOf({ url: "https://www.nature.com/articles/s41586-020-1" })).toBe(
      "Nature Portfolio",
    );
    expect(nameOf({ type: "preprint", url: "https://arxiv.org/abs/2401.00001" })).toBe("arXiv");
  });

  // regression: PubMed imports link to pubmed.gov, which is an index, not the journal
  it("never shows an index such as PubMed in place of the journal", () => {
    expect(nameOf({ url: "https://pubmed.ncbi.nlm.nih.gov/32098899/" })).toBeNull();
    expect(
      nameOf({ doi: "10.20471/acc.2020.1", url: "https://pubmed.ncbi.nlm.nih.gov/32098899/" }),
    ).toBeNull();
  });

  it("uses a journal family's own icon only when its owner publishes the record", () => {
    expect(nameOf({ doi: "10.1016/S0140-6736(20)1", containerTitle: "The Lancet" })).toBe(
      "The Lancet",
    );
    expect(nameOf({ doi: "10.1016/j.cmet.2020.1", containerTitle: "Cell metabolism" })).toBe(
      "Cell Press",
    );
    expect(nameOf({ doi: "10.1038/s41591-020-1", containerTitle: "Nature medicine" })).toBe(
      "Nature Portfolio",
    );
    // A same-named journal from another publisher keeps its own publisher.
    expect(nameOf({ doi: "10.1002/x", containerTitle: "Lancet Respiratory Notes" })).toBe("Wiley");
    expect(nameOf({ doi: "10.5811/westjem.2022.1", containerTitle: "WestJEM" })).toBe(
      "Western Journal of Emergency Medicine",
    );
  });

  it("tells medRxiv from bioRxiv on their shared DOI prefix", () => {
    expect(
      nameOf({ type: "preprint", doi: "10.1101/2020.01.01.1", containerTitle: "medRxiv" }),
    ).toBe("medRxiv");
    expect(nameOf({ type: "preprint", doi: "10.1101/2020.01.01.1" })).toBe("bioRxiv");
    expect(nameOf({ type: "preprint", doi: "10.1101/123456" })).toBe("bioRxiv");
    expect(nameOf({ type: "preprint", doi: "10.1101/2024.01.02.123456V2" })).toBe("bioRxiv");
    expect(nameOf({ doi: "DOI: 10.1136/bmj.n71" })).toBe("BMJ");
  });

  // regression: Cold Spring Harbor's journals share bioRxiv's DOI prefix
  it("does not give bioRxiv's icon to Cold Spring Harbor journal articles", () => {
    expect(
      nameOf({ doi: "10.1101/gad.353379.125", containerTitle: "Genes & Development" }),
    ).toBeNull();
    expect(nameOf({ doi: "10.1101/gr.278000.123" })).toBeNull();
  });

  it("leaves sources that are not publications, or have no evidence, to their type icon", () => {
    expect(nameOf({})).toBeNull();
    expect(nameOf({ type: "web", doi: "10.1136/x" })).toBeNull();
    expect(nameOf({ type: "dataset", url: "https://arxiv.org/abs/1" })).toBeNull();
    expect(nameOf({ url: "not a url" })).toBeNull();
  });

  it("does not match a publisher name inside another word", () => {
    expect(nameOf({ publisher: "Sagebrush Press" })).toBeNull();
    expect(nameOf({ publisher: "Bmjx Publishing" })).toBeNull();
  });
});
