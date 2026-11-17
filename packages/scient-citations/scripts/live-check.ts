/**
 * Opt-in live check, never part of the test suite: downloads the Zotero style index and two
 * styles that are not bundled (one independent, one dependent), and renders one reference with
 * each. Run with `pnpm run styles:live-check` from this package.
 */
import type { ScientSourceRecord } from "@scientfactory/scient-sources";

import { parseCslStyleIndex, searchCslCatalog } from "../src/catalog.ts";
import { formatSourceReference, readCslStyle, renderableCslStyle } from "../src/index.ts";

const article: ScientSourceRecord = {
  formatVersion: 1,
  sourceId: "source_live",
  projectId: "project_live",
  revision: 1,
  type: "article",
  title: "Why Most Published Research Findings Are False",
  creators: [
    { creatorType: "author", givenName: "John P. A.", familyName: "Ioannidis", literalName: null },
  ],
  issuedRaw: "2005",
  issuedYear: 2005,
  identifiers: [{ scheme: "doi", value: "10.1371/journal.pmed.0020124" }],
  abstract: null,
  containerTitle: "PLOS Medicine",
  publisher: null,
  volume: "2",
  issue: "8",
  pages: "e124",
  language: "en",
  url: null,
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-11-11T00:00:00.000Z",
};

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "Scient live check" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.text();
}

const index = parseCslStyleIndex(
  JSON.parse(await download("https://www.zotero.org/styles-files/styles.json")),
);
if (index === null) throw new Error("The style index had no styles.");
console.log(`Index: ${index.length} styles.`);
for (const query of ["Scientific Reports", "Acta Materialia", "IEEE"]) {
  const found = searchCslCatalog(index, query, 3).map(
    (entry) => `${entry.id}${entry.dependent ? " (dependent)" : ""}`,
  );
  console.log(`Search “${query}”: ${found.join(", ")}`);
}

for (const id of ["elsevier-with-titles", "scientific-reports"]) {
  const style = await download(`https://www.zotero.org/styles/${id}`);
  const info = readCslStyle(style);
  if (info === null) throw new Error(`${id} is not a CSL style.`);
  const parent =
    info.parentId === null
      ? null
      : await download(`https://www.zotero.org/styles/${info.parentId}`);
  const reference = formatSourceReference(article, { xml: renderableCslStyle(style, parent) });
  console.log(`${info.title}${info.parentId ? ` (parent ${info.parentId})` : ""}:\n  ${reference}`);
}
