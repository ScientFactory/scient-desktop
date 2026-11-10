// @effect-diagnostics nodeBuiltinImport:off -- Saved-page tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceWebPage } from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceRecord,
} from "@scientfactory/scient-sources/store";
import { describe, expect, it } from "@effect/vitest";

import type { ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";
import { saveWebPageSource } from "./SourceWebPage.ts";

async function project(): Promise<AsyncDisposable & { readonly root: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-web-page-"));
  await initializeScientProject({ root });
  return { root, [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }) };
}

const registry: ResolveSourceIdentifier = async (identifiers) => {
  const identifier = identifiers.find((entry) => entry.scheme === "doi");
  if (!identifier) return null;
  if (identifier.value !== "10.1000/cc.2024.42") return { status: "not-found", identifier };
  return {
    status: "found",
    identifier,
    retrievedAt: "2026-11-10T00:00:00.000Z",
    metadata: {
      type: "article",
      title: "Early antibiotics in sepsis: a randomised trial",
      creators: [
        { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
      ],
      issuedRaw: "2024-03-05",
      issuedYear: 2024,
      identifiers: [identifier],
      abstract: null,
      abstractSections: [],
      containerTitle: "Critical Care",
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
    },
  };
};

const articlePage = (selection: string | null): ScientSourceWebPage => ({
  url: "https://journal.example/articles/42",
  title: "Journal site",
  selection,
  meta: [
    { name: "citation_title", content: "Early antibiotics in sepsis" },
    { name: "citation_doi", content: "10.1000/CC.2024.42" },
  ],
});

describe("saving a browser page to the Library", () => {
  it("adds the work the page names with registry metadata and keeps each passage once", async () => {
    await using fixture = await project();
    const save = (page: ScientSourceWebPage) =>
      saveWebPageSource({
        root: fixture.root,
        page,
        actor: "user",
        resolveIdentifier: registry,
        enrich: false,
      });

    const first = await save(articlePage("Mortality fell\nby 12%."));
    expect(first).toMatchObject({ outcome: "added", passageSaved: true });
    if (first.outcome !== "added") return;
    await expect(readScientSourceRecord(fixture.root, first.sourceId)).resolves.toMatchObject({
      title: "Early antibiotics in sepsis: a randomised trial",
      note: "Mortality fell by 12%.",
      origin: { actor: "user", intake: "web" },
      verification: { state: "verified" },
    });

    await expect(save(articlePage("Mortality fell by 12%."))).resolves.toMatchObject({
      outcome: "existing",
      sourceId: first.sourceId,
      passageSaved: false,
    });
    await expect(save(articlePage("A second passage."))).resolves.toMatchObject({
      outcome: "existing",
      passageSaved: true,
    });
    await expect(readScientSourceRecord(fixture.root, first.sourceId)).resolves.toMatchObject({
      note: "Mortality fell by 12%.\n\nA second passage.",
    });
    await expect(listScientSourceRecords(fixture.root)).resolves.toHaveLength(1);
  });

  it("saves a page without an identifier as a web page, once per address", async () => {
    await using fixture = await project();
    const page: ScientSourceWebPage = {
      url: "https://blog.example/post",
      title: "Lab methods",
      selection: null,
      meta: [],
    };
    const first = await saveWebPageSource({ root: fixture.root, page, actor: "agent" });
    expect(first).toMatchObject({ outcome: "added", passageSaved: false });
    if (first.outcome !== "added") return;
    await expect(readScientSourceRecord(fixture.root, first.sourceId)).resolves.toMatchObject({
      type: "web",
      title: "Lab methods",
      url: "https://blog.example/post",
      origin: { actor: "agent", intake: "web" },
    });
    await expect(
      saveWebPageSource({ root: fixture.root, page, actor: "agent" }),
    ).resolves.toMatchObject({ outcome: "existing", sourceId: first.sourceId });
  });

  it("refuses a page whose stated DOI does not exist", async () => {
    await using fixture = await project();
    const page = {
      ...articlePage(null),
      meta: [{ name: "citation_doi", content: "10.1000/missing" }],
    };
    await expect(
      saveWebPageSource({ root: fixture.root, page, actor: "user", resolveIdentifier: registry }),
    ).resolves.toMatchObject({ outcome: "not-added", reason: "identifier-not-found" });
    await expect(listScientSourceRecords(fixture.root)).resolves.toEqual([]);
  });
});
