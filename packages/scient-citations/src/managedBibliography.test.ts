import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { formatBibliography } from "@scientfactory/scient-sources/bibliography";
import { describe, expect, it } from "vite-plus/test";

import {
  bibtexEntriesByKey,
  compareBibliographyEntries,
  cslJsonEntriesByKey,
  renderManagedBibliography,
} from "./managedBibliography.ts";

function record(overrides: Partial<ScientSourceRecord>): ScientSourceRecord {
  return {
    formatVersion: 1,
    sourceId: "source_a",
    projectId: "project",
    revision: 1,
    citationKey: "ioannidis2005why",
    type: "article",
    title: "Why Most Published Research Findings Are False",
    creators: [
      {
        creatorType: "author",
        givenName: "John P. A.",
        familyName: "Ioannidis",
        literalName: null,
      },
    ],
    issuedRaw: "2005",
    issuedYear: 2005,
    identifiers: [{ scheme: "doi", value: "10.1371/journal.pmed.0020124" }],
    abstract: "Long abstract.",
    containerTitle: "PLOS Medicine",
    publisher: null,
    volume: "2",
    issue: "8",
    pages: "e124",
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("managed bibliography", () => {
  // regression: managed files once had their own writers and lost what export keeps.
  it("writes the same entry as a Library export of the same source", () => {
    const thesis = record({
      type: "thesis",
      title: "DNA & mRNA in München",
      containerTitle: null,
      publisher: "Synthetic University",
      identifiers: [{ scheme: "pmid", value: "12345" }],
    });
    const rendered = renderManagedBibliography([thesis]);
    const items = [{ record: thesis, citationKey: "ioannidis2005why" }];
    const options = { includeNotes: false, includeAbstracts: false };

    expect(rendered.bibtex).toContain(formatBibliography(items, "bibtex", options));
    expect(rendered.bibtex).toContain("title = {{DNA} \\& {mRNA} in München}");
    expect(rendered.bibtex).toContain("school = {Synthetic University}");
    expect(rendered.cslJson).toBe(formatBibliography(items, "csl-json", options));
    expect(JSON.parse(rendered.cslJson)[0]).toMatchObject({ PMID: "12345" });
  });

  it("leaves abstracts out of the managed files and keeps them in an explicit export", () => {
    const source = record({});
    const rendered = renderManagedBibliography([source]);
    const items = [{ record: source, citationKey: "ioannidis2005why" }];
    const exported = { includeNotes: false };

    expect(rendered.bibtex).not.toContain("Long abstract.");
    expect(rendered.cslJson).not.toContain("Long abstract.");
    expect(formatBibliography(items, "bibtex", exported)).toContain("abstract = {Long abstract.}");
    expect(JSON.parse(formatBibliography(items, "csl-json", exported))[0]).toMatchObject({
      abstract: "Long abstract.",
    });
  });

  it("keys both files by citation key, sorted, and leaves out unkeyed sources", () => {
    const { citationKey: _key, ...unkeyed } = record({ sourceId: "source_c" });
    const rendered = renderManagedBibliography([
      record({ sourceId: "source_b", citationKey: "Zeta2001" }),
      record({}),
      unkeyed,
    ]);

    expect(rendered.keys).toEqual(["ioannidis2005why", "Zeta2001"]);
    expect([...bibtexEntriesByKey(rendered.bibtex).keys()]).toEqual(rendered.keys);
    const items = JSON.parse(rendered.cslJson) as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual(rendered.keys);
  });

  it("reports entries added, changed and removed by hand", () => {
    const written = renderManagedBibliography([
      record({}),
      record({ sourceId: "source_b", citationKey: "second2001" }),
    ]);
    const edited = written.bibtex
      .replace("{PLOS Medicine}", "{PLoS Med}")
      .replace(/@article\{second2001,[\s\S]*?\n\}\n/u, "")
      .concat("\n@book{added2020,\n  title = {New},\n}\n");

    expect(
      compareBibliographyEntries(bibtexEntriesByKey(written.bibtex), bibtexEntriesByKey(edited)),
    ).toEqual({ added: ["added2020"], changed: ["ioannidis2005why"], removed: ["second2001"] });
    expect(cslJsonEntriesByKey("{not json")).toBeNull();
    expect(cslJsonEntriesByKey(written.cslJson)?.size).toBe(2);
  });
});
