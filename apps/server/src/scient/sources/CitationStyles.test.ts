// @effect-diagnostics nodeBuiltinImport:off -- Citation style tests exercise real project files and recorded responses.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { formatSourceReference } from "@scientfactory/scient-citations";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  readProjectCitationStyle,
  resetCitationStyleCatalogue,
  searchCitationStyles,
  setProjectCitationStyle,
} from "./CitationStyles.ts";
import type { MetadataRequest } from "./metadataHttp.ts";

// Recorded from zotero.org on 2026-11-11: a slice of the style index and two style files.
const recorded = (name: string) =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "fixtures", "citation-styles", name),
    "utf8",
  );
const RESPONSES: Record<string, string> = {
  "https://www.zotero.org/styles-files/styles.json": recorded("styles-index.json"),
  "https://www.zotero.org/styles/scientific-reports": recorded("scientific-reports.csl"),
  "https://www.zotero.org/styles/nature-brackets": recorded("nature-brackets.csl"),
};

const recordedRequest = () =>
  vi.fn<MetadataRequest>(async (url) => {
    const body = RESPONSES[url.href];
    return body === undefined ? { status: 404, body: "", url } : { status: 200, body, url };
  });

const article = {
  formatVersion: 1,
  sourceId: "source_ioannidis",
  projectId: "project_test",
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
  importedAt: "2026-08-12T12:00:00.000Z",
} satisfies ScientSourceRecord;

const roots: string[] = [];
afterEach(async () => {
  resetCitationStyleCatalogue();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-citation-styles-"));
  roots.push(root);
  return root;
}

describe("searchCitationStyles", () => {
  it("searches the downloaded catalogue by journal and style name", async () => {
    const root = await project();
    const request = recordedRequest();
    const deps = { request, cacheRoot: NodePath.join(root, "state") };

    const journal = await searchCitationStyles({ root, query: "Scientific Reports" }, deps);
    expect(journal.current).toEqual({ _tag: "none" });
    expect(journal.results[0]).toMatchObject({ id: "scientific-reports", dependent: true });
    const style = await searchCitationStyles({ root, query: "harvard" }, deps);
    expect(style.results.map((entry) => entry.id)).toEqual([
      "harvard-cite-them-right",
      "harvard-anglia-ruskin-university",
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("says when the catalogue cannot be reached and searches the bundled styles", async () => {
    const root = await project();
    const request = vi.fn<MetadataRequest>(async () => {
      throw new Error("offline");
    });

    const found = await searchCitationStyles(
      { root, query: "nature" },
      { request, cacheRoot: null },
    );

    expect(found.results.map((entry) => entry.id)).toEqual(["nature"]);
    expect(found.catalogueMessage).toContain("could not be reached");
  });
});

describe("setProjectCitationStyle", () => {
  it("saves a dependent style with its parent, and references render in it", async () => {
    const root = await project();
    const request = recordedRequest();

    const set = await setProjectCitationStyle(
      { root, styleId: "scientific-reports", actor: "user" },
      { request, cacheRoot: null },
    );

    expect(set.error).toBeNull();
    const styles = NodePath.join(root, ".scient", "citations", "styles");
    expect((await NodeFSP.readdir(styles)).toSorted()).toEqual([
      "nature-brackets.csl",
      "scientific-reports.csl",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(styles, "nature-brackets.csl"), "utf8")).toBe(
      RESPONSES["https://www.zotero.org/styles/nature-brackets"],
    );
    const current = await readProjectCitationStyle(root);
    expect(current).toMatchObject({
      _tag: "ready",
      id: "scientific-reports",
      title: "Scientific Reports",
      parent: { id: "nature-brackets" },
    });
    if (current._tag !== "ready") throw new Error("expected a ready style");
    expect(formatSourceReference(article, { xml: current.xml })).toBe(
      "1. Ioannidis, J. P. A. Why Most Published Research Findings Are False. PLOS Medicine 2, e124 (2005).",
    );
  });

  it("names a style whose file went missing instead of using another", async () => {
    const root = await project();
    await setProjectCitationStyle(
      { root, styleId: "nature", actor: "agent" },
      { request: recordedRequest(), cacheRoot: null },
    );
    expect((await readProjectCitationStyle(root))._tag).toBe("ready");

    await NodeFSP.rm(NodePath.join(root, ".scient", "citations", "styles", "nature.csl"));
    expect(await readProjectCitationStyle(root)).toEqual({
      _tag: "unavailable",
      id: "nature",
      title: "Nature",
      message: "Nature is missing from this project (.scient/citations/styles/nature.csl).",
    });
  });

  it("reports an unknown style and keeps the project's style", async () => {
    const root = await project();
    const set = await setProjectCitationStyle(
      { root, styleId: "no-such-journal", actor: "user" },
      { request: recordedRequest(), cacheRoot: null },
    );

    expect(set).toEqual({
      style: { _tag: "none" },
      error: "No citation style has the ID no-such-journal.",
    });
  });
});
