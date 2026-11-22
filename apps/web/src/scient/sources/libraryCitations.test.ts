import { pandocCitationItems } from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveCitationEntries } from "./citationNavigationModel";
import {
  filterLibraryCitations,
  libraryCitationCandidates,
  libraryLatexCitationChoices,
  type LibraryCitationCandidate,
} from "./libraryCitations";

const candidates: ReadonlyArray<LibraryCitationCandidate> = [
  { sourceId: "a", citationKey: "lovelace1843notes", label: "Lovelace 1843", title: "Notes" },
  {
    sourceId: "b",
    citationKey: "turing1950computing",
    label: "Turing 1950",
    title: "Computing machinery and intelligence",
  },
  {
    sourceId: "c",
    citationKey: "hopper1952education",
    label: "Hopper 1952",
    title: "The education of a computer",
  },
];

describe("Library citations", () => {
  it("ranks a key prefix first, then author, year and title matches", () => {
    expect(filterLibraryCitations(candidates, "tur").map((item) => item.sourceId)).toEqual(["b"]);
    expect(filterLibraryCitations(candidates, "1952").map((item) => item.sourceId)).toEqual(["c"]);
    expect(filterLibraryCitations(candidates, "machinery").map((item) => item.sourceId)).toEqual([
      "b",
    ]);
    expect(filterLibraryCitations(candidates, "")).toHaveLength(3);
    expect(filterLibraryCitations(candidates, "zzz")).toEqual([]);
  });

  it("opens a source by a key it kept after a merge, offering the source once", () => {
    // Only the fields the candidates read; an overview record has many more.
    const record = {
      sourceId: "soil",
      citationKey: "soil2021",
      alsoCitedAs: ["oldsoil", "soil2021"],
      creators: [{ creatorType: "author", familyName: "Ng", givenName: null, literalName: null }],
      issuedYear: 2021,
      title: "Soil carbon",
      attachments: [{ attachmentId: "pdf_soil", kind: "pdf", fileName: "soil.pdf" }],
    } as unknown as ScientSourcesOverviewResult["records"][number];
    const library = libraryCitationCandidates([record]);

    const [alias] = resolveCitationEntries(library, pandocCitationItems("@oldsoil, p. 3"));
    expect(alias?.candidate).toMatchObject({
      sourceId: "soil",
      citationKey: "oldsoil",
      label: "Ng 2021",
      pdf: { attachmentId: "pdf_soil", fileName: "soil.pdf" },
    });
    expect(alias?.item.locator).toBe("p. 3");
    expect(
      resolveCitationEntries(library, pandocCitationItems("@soil2021; @oldsoil")).map(
        (entry) => entry.candidate.sourceId,
      ),
    ).toEqual(["soil"]);

    // A new citation is offered the source's first key only.
    expect(filterLibraryCitations(library, "").map((item) => item.citationKey)).toEqual([
      "soil2021",
    ]);
    expect(filterLibraryCitations(library, "old")).toEqual([]);
    expect(libraryLatexCitationChoices(library, new Set()).map((item) => item.key)).toEqual([
      "soil2021",
    ]);
  });
});
