import { describe, expect, it } from "@effect/vitest";

import { readWordReferences, type WordCode, type WordParagraph } from "./wordReferences.ts";

// The codes follow what each plug-in writes (Zotero and Mendeley Desktop as in pandoc's public
// sample files, Mendeley Cite and EndNote as publicly described); the works are made up.
const code = (instruction: string, data: string | null = null): WordCode => ({ instruction, data });
const paragraph = (text: string, more: Partial<WordParagraph> = {}): WordParagraph => ({
  text,
  superscripts: [],
  heading: false,
  inTable: false,
  ...more,
});
const read = (input: {
  readonly codes?: ReadonlyArray<WordCode>;
  readonly paragraphs?: ReadonlyArray<WordParagraph>;
  readonly notes?: ReadonlyArray<WordParagraph>;
}) => readWordReferences({ paragraphs: [], notes: [], codes: [], ...input });

const zoteroItem = (key: string, title: string, doi: string) => ({
  id: 7,
  uris: [`http://zotero.org/users/40613/items/${key}`],
  itemData: {
    id: 7,
    type: "article-journal",
    title,
    DOI: doi,
    author: [{ family: "Smith", given: "Doug M." }],
    issued: { "date-parts": [["2013", 12]] },
  },
});
const zotero = (...items: ReadonlyArray<unknown>) =>
  code(
    ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({ citationID: "CCwugFas", properties: { plainCitation: "(Smith {2013})" }, citationItems: items })} `,
  );

const ENDNOTE = `<EndNote><Cite><Author>Bronk Ramsey</Author><Year>2009</Year><RecNum>19</RecNum><Pages>12</Pages><DisplayText>(Bronk Ramsey 2009)</DisplayText><record><rec-number>19</rec-number><foreign-keys><key app="EN" db-id="z2asfrdsndpezaeta27x5ff5d022r5x9x9x0" timestamp="1483621777">19</key></foreign-keys><ref-type name="Journal Article">17</ref-type><contributors><authors><author><style face="normal" font="default" size="100%">Bronk Ramsey, Christopher</style></author></authors><secondary-authors><author>Editor, An</author></secondary-authors></contributors><titles><title>Bayesian Analysis of Radiocarbon Dates &amp; more</title><secondary-title>Radiocarbon</secondary-title></titles><pages>337-360</pages><volume>51</volume><dates><year>2009</year></dates><electronic-resource-num>https://doi.org/10.1017/S0033822200033865</electronic-resource-num></record></Cite></EndNote>`;

describe("Word references", () => {
  it("reads each work Zotero cites once, and what its list was told to add or leave out", () => {
    const sleep = zoteroItem("3GKMD43T", "Light and sleep", "10.1000/sleep");
    const reef = zoteroItem("EIZFK2E5", "Reef fish", "10.1000/reef");
    const references = read({
      codes: [
        zotero(sleep),
        zotero(reef, sleep),
        // In bookmark mode the same code is kept in document properties, without ADDIN.
        code(`ZOTERO_ITEM CSL_CITATION ${JSON.stringify({ citationItems: [reef] })}`),
        code(
          ` ADDIN ZOTERO_BIBL {"uncited":[["http://zotero.org/users/40613/items/AAAA1111"]],"omitted":[["http://zotero.org/users/40613/items/EIZFK2E5"]],"custom":[]} CSL_BIBLIOGRAPHY `,
        ),
        code(' HYPERLINK "https://doi.org/10.1000/sleep" '),
      ],
      paragraphs: [paragraph("Typed by hand (Jones, 2020)."), paragraph("References")],
    });
    expect(references).toMatchObject({
      kind: "managed",
      citations: 4,
      hasList: true,
      listedOnly: 1,
      unreadable: 0,
      works: [
        { id: "http://zotero.org/users/40613/items/3GKMD43T", listed: true },
        { id: "http://zotero.org/users/40613/items/EIZFK2E5", listed: false },
      ],
    });
  });

  it("reads Mendeley's fields and Mendeley Cite's content controls", () => {
    // Mendeley Desktop numbers a citation's items; Mendeley Cite gives each its item's ID.
    const item = (title: string, id = "ITEM-1") => ({
      id,
      itemData: {
        id,
        title,
        type: "article-journal",
        issued: { "date-parts": [["2019"]] },
      },
    });
    const dinosaurs = item("Dinosaur eggs", "6b0d8d0d-3f1e-4a3c-9a0e-2c5f1d7b9e41");
    const references = read({
      codes: [
        code(
          `ADDIN CSL_CITATION ${JSON.stringify({ citationItems: [{ ...item("Maker movement"), uris: ["http://www.mendeley.com/documents/?uuid=bdfc0dee"] }], mendeley: { formattedCitation: "(Seo, 2019)" } })}`,
        ),
        code(
          `MENDELEY_CITATION_v3_${btoa(JSON.stringify({ citationID: "MENDELEY_CITATION_1de18c13", citationItems: [dinosaurs] }))}`,
        ),
        code(
          `MENDELEY_CITATION_v3_${btoa(JSON.stringify({ citationID: "MENDELEY_CITATION_77aa01c2", citationItems: [dinosaurs] }))}`,
        ),
        code("MENDELEY_BIBLIOGRAPHY"),
      ],
    });
    expect(references).toMatchObject({ kind: "managed", citations: 3, hasList: true });
    expect(references.kind === "managed" && references.works.map(({ id }) => id)).toEqual([
      "http://www.mendeley.com/documents/?uuid=bdfc0dee",
      `mendeley:${dinosaurs.id}`,
    ]);
  });

  it("reads an EndNote record from the field or its data, counting a nested data field once", () => {
    const references = read({
      codes: [
        code(` ADDIN EN.CITE ${ENDNOTE}`),
        code(" ADDIN EN.CITE.DATA ", btoa(ENDNOTE)),
        code(" ADDIN EN.CITE ", btoa(ENDNOTE)),
        code(" ADDIN EN.REFLIST "),
      ],
    });
    expect(references).toEqual({
      kind: "managed",
      citations: 2,
      hasList: true,
      listedOnly: 0,
      unreadable: 0,
      works: [
        {
          id: "endnote:z2asfrdsndpezaeta27x5ff5d022r5x9x9x0:19",
          listed: true,
          item: {
            title: "Bayesian Analysis of Radiocarbon Dates & more",
            "container-title": "Radiocarbon",
            volume: "51",
            page: "337-360",
            DOI: "10.1017/S0033822200033865",
            author: [{ family: "Bronk Ramsey" }],
            issued: { raw: "2009" },
          },
        },
      ],
    });
  });

  it("counts a citation whose details cannot be read instead of dropping it", () => {
    const references = read({
      codes: [
        zotero({ uri: ["http://zotero.org/users/1/items/OLDSTYLE"] }),
        code("ADDIN CSL_CITATION {not json"),
        code(" ADDIN EN.CITE "),
      ],
    });
    expect(references).toMatchObject({ kind: "managed", citations: 3, unreadable: 3, works: [] });
  });

  it("reads numbered citations against the list after the last References heading", () => {
    const references = read({
      paragraphs: [
        paragraph("References are discussed below."),
        paragraph("Sleep changes with light [1, 3] and age.", { superscripts: ["2", "9"] }),
        paragraph("In 2020 (2) of (2020) patients; see [7]."),
        paragraph("References", { heading: true }),
        paragraph("Smith J. Light and sleep. J Sleep Res. 2020. doi:10.1000/smith"),
        paragraph("  "),
        paragraph("Doe A. Shift work. Sleep. 2019."),
        paragraph("[5]\tRoe B. Reef fish. Nature. 2018."),
        paragraph("Appendix", { heading: true }),
        paragraph("Not a reference [4]."),
      ],
      notes: [paragraph("A footnote citing [5].")],
    });
    expect(references).toMatchObject({
      kind: "text",
      entries: [
        { key: "1", raw: "Smith J. Light and sleep. J Sleep Res. 2020. doi:10.1000/smith" },
        { key: "2", raw: "Doe A. Shift work. Sleep. 2019." },
        { key: "5", raw: "Roe B. Reef fish. Nature. 2018." },
      ],
    });
    expect(references.kind === "text" && references.entries[0]!.identifiers).toEqual([
      { scheme: "doi", value: "10.1000/smith" },
    ]);
    // Superscripts and parentheses count only for entries the list has; brackets always.
    expect(references.kind === "text" && references.citations.map(({ key }) => key)).toEqual([
      "1",
      "3",
      "2",
      "7",
      "2",
      "4",
      "5",
    ]);
  });

  it("reads author and year citations against a list without numbers", () => {
    const references = read({
      paragraphs: [
        paragraph(
          "As Smith and Lee (2020) showed, light matters (see Bronk Ramsey, 2009a, 2009b; Müller et al., 2019).",
        ),
        paragraph(
          "Measured in (June 2021) by WHO (2020); Van Dijk’s (2018) method (Okafor, Roe, & Fay 2015).",
        ),
        paragraph("References"),
        paragraph("Smith JA, Lee K. (2020). Light and sleep. Journal of Sleep Research."),
        paragraph("Bronk Ramsey, C. (2009a). Bayesian analysis. Radiocarbon, 51."),
        paragraph("Muller, W. A., & Eade, R. (2019). Decadal prediction."),
        paragraph("van Dijk, T. 2018. Discourse."),
        paragraph("Okafor, N., Roe, B., & Fay, D. (2015). Reef fish."),
        paragraph("Never cited, A. (2001). Nothing."),
      ],
    });
    expect(references.kind === "text" && references.entries.map(({ key }) => key)).toEqual([
      "Smith 2020",
      "Bronk Ramsey 2009a",
      "Muller 2019",
      "van Dijk 2018",
      "Okafor 2015",
      "Never cited 2001",
    ]);
    expect(references.kind === "text" && references.citations.map(({ key }) => key)).toEqual([
      "Smith 2020",
      "Bronk Ramsey 2009a",
      "Ramsey 2009b",
      "Muller 2019",
      "WHO 2020",
      "van Dijk 2018",
      "Okafor 2015",
    ]);
  });
});
