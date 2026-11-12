// @effect-diagnostics nodeBuiltinImport:off -- Merge tests exercise the real library files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { organizeScientSources, readScientSourcesOrganization } from "./collections.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import {
  clearScientLibrarySourcesDistinct,
  markScientLibrarySourcesDistinct,
  mergeScientLibraryDuplicates,
  mergeScientLibrarySources,
  readScientLibraryDuplicates,
  undoScientLibraryMerge,
} from "./libraryMerge.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceRecord } from "./model.ts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  restoreScientSource,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "./store.ts";
import { editableMetadataFromRecord } from "./editable.ts";

const fixtures: string[] = [];
const originalRename = NodeFS.promises.rename;
const originalUnlink = NodeFS.promises.unlink;

function restoreFileOperations(): void {
  NodeFS.promises.rename = originalRename;
  NodeFS.promises.unlink = originalUnlink;
  NodeModule.syncBuiltinESMExports();
}

/** Fails the next rename onto, or unlink of, a matching path, as a crash at that write would. */
function failNext(operation: "rename" | "unlink", target: RegExp): void {
  const fail = (path: unknown) => {
    if (!target.test(String(path))) return;
    restoreFileOperations();
    throw new Error("Injected file failure.");
  };
  if (operation === "rename") {
    NodeFS.promises.rename = async (from, to) => {
      fail(to);
      return originalRename(from, to);
    };
  } else {
    NodeFS.promises.unlink = async (path) => {
      fail(path);
      return originalUnlink(path);
    };
  }
  NodeModule.syncBuiltinESMExports();
}

afterEach(async () => {
  restoreFileOperations();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function newLibrary() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-merge-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "scient", "library");
  await ensureScientLibrary(root);
  return { root, library: scientLibraryLocation(root) };
}

const BOOK_PDF = "a".repeat(64);

function record(sourceId: string, fields: Partial<ScientSourceRecord> = {}): ScientSourceRecord {
  return {
    formatVersion: 2,
    sourceId,
    revision: 1,
    citationKey: sourceId.replace("_", ""),
    type: "article",
    title: `Title of ${sourceId}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

const pdf = (sha256: string) => ({
  attachmentId: `attachment_${sha256.slice(0, 8)}`,
  kind: "pdf" as const,
  fileName: "book.pdf",
  mediaType: "application/pdf" as const,
  sha256,
  byteLength: 10,
  relativePath: `files/sha256/${sha256.slice(0, 2)}/${sha256}.pdf`,
  importedAt: "2026-01-01T00:00:00.000Z",
});

async function seed(root: string, records: ReadonlyArray<ScientSourceRecord>) {
  await NodeFSP.mkdir(NodePath.join(root, "records"), { recursive: true });
  for (const entry of records) {
    await NodeFSP.writeFile(
      NodePath.join(root, "records", `${entry.sourceId}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
  }
}

const liveIds = async (library: ReturnType<typeof scientLibraryLocation>) =>
  (await listScientSourceRecords(library)).map((entry) => entry.sourceId).toSorted();

describe("library merge engine", () => {
  it("keeps two chapters of one book apart though they share an ISBN and the book's PDF", async () => {
    const { root, library } = await newLibrary();
    const chapter = (sourceId: string, title: string, doi: string) =>
      record(sourceId, {
        type: "book-chapter",
        title,
        containerTitle: "The Handbook",
        identifiers: [
          { scheme: "isbn", value: "978-0-00-000000-2" },
          { scheme: "doi", value: doi },
        ],
        attachments: [pdf(BOOK_PDF)],
      });
    await seed(root, [
      chapter("source_ch1", "Methods", "10.1000/handbook.1"),
      chapter("source_ch2", "Results", "10.1000/handbook.2"),
    ]);

    const result = await mergeScientLibraryDuplicates({ library });

    expect(result.mergedCount).toBe(0);
    expect(result.possibleDuplicates).toEqual([]);
    expect(await liveIds(library)).toEqual(["source_ch1", "source_ch2"]);
  });

  it.each([
    {
      kind: "same-zotero-item",
      shared: {
        externalReferences: [
          {
            system: "zotero",
            libraryId: "users/1",
            itemKey: "ABCD1234",
            itemVersion: 3,
            rawItemType: "journalArticle",
          },
        ],
      },
      titles: ["Zotero copy", "Another title"],
    },
    {
      kind: "same-identifier",
      shared: { identifiers: [{ scheme: "doi", value: "10.1000/Shared" }] },
      titles: ["Identifier copy", "Different title"],
    },
    {
      kind: "same-pdf",
      shared: { attachments: [pdf("b".repeat(64))] },
      titles: ["Deep learning, revisited", "Deep Learning — Revisited"],
    },
  ] as const)("merges on $kind", async ({ kind, shared, titles }) => {
    const { root, library } = await newLibrary();
    await seed(root, [
      record("source_old", { ...shared, title: titles[0], creators: [] }),
      record("source_new", {
        ...shared,
        title: titles[1],
        importedAt: "2026-02-01T00:00:00.000Z",
        identifiers: [
          ...("identifiers" in shared ? shared.identifiers : []),
          { scheme: "pmid", value: "123" },
        ],
      }),
    ]);

    const result = await mergeScientLibraryDuplicates({ library });

    expect(result.merges.map((merge) => [merge.kind, merge.survivorId, merge.loserId])).toEqual([
      [kind, "source_old", "source_new"],
    ]);
    expect(await liveIds(library)).toEqual(["source_old"]);
    const survivor = await readScientSourceRecord(library, "source_old");
    expect(survivor?.creators).toEqual(record("x").creators);
    expect(survivor?.identifiers).toContainEqual({ scheme: "pmid", value: "123" });
    const [trashed] = await readScientSourceTrashEntries(library);
    expect(trashed?.mergedInto).toEqual({
      sourceId: "source_old",
      mergeId: result.merges[0]?.mergeId,
    });
  });

  it("only lists possible duplicates and never merges a pair marked distinct", async () => {
    const { root, library } = await newLibrary();
    await seed(root, [
      record("source_meta1", { title: "Same study" }),
      record("source_meta2", { title: "Same study", importedAt: "2026-03-01T00:00:00.000Z" }),
      record("source_book1", {
        type: "book",
        title: "Atlas",
        creators: [],
        identifiers: [{ scheme: "isbn", value: "9780000000019" }],
      }),
      record("source_book2", {
        type: "book",
        title: "Atlas",
        issuedYear: 2021,
        identifiers: [{ scheme: "isbn", value: "978-0-00-000001-9" }],
      }),
      record("source_kept1", { identifiers: [{ scheme: "doi", value: "10.1000/kept" }] }),
      record("source_kept2", { identifiers: [{ scheme: "doi", value: "10.1000/kept" }] }),
    ]);
    await markScientLibrarySourcesDistinct({
      library,
      sourceIds: ["source_kept2", "source_kept1"],
    });

    const result = await mergeScientLibraryDuplicates({ library });

    expect(result.mergedCount).toBe(0);
    expect(result.possibleDuplicates).toEqual([
      { sourceIds: ["source_meta1", "source_meta2"], kind: "possible-metadata-match" },
      { sourceIds: ["source_book1", "source_book2"], kind: "possible-container-match" },
    ]);
    expect(await liveIds(library)).toHaveLength(6);

    const requested = await mergeScientLibrarySources({
      library,
      sourceIds: ["source_meta2", "source_meta1"],
      actor: "agent",
    });
    expect(requested).toMatchObject({
      outcome: "merged",
      merge: { kind: "requested", survivorId: "source_meta1", loserId: "source_meta2" },
    });
    await clearScientLibrarySourcesDistinct({
      library,
      sourceIds: ["source_kept1", "source_kept2"],
    });
    expect((await mergeScientLibraryDuplicates({ library })).mergedCount).toBe(1);
    expect(await liveIds(library)).toEqual([
      "source_book1",
      "source_book2",
      "source_kept1",
      "source_meta1",
    ]);
  });

  it("reports kept values, and Undo keeps a later edit, restores the loser and tombstones the alias", async () => {
    const { root, library } = await newLibrary();
    const doi = { scheme: "doi", value: "10.1000/merge" };
    await seed(root, [
      record("source_keep", {
        identifiers: [doi],
        title: "Kept title",
        note: "Read for chapter 2.",
        tags: ["Methods"],
        verification: { state: "verified", identifier: doi, checkedAt: "2026-05-01T00:00:00Z" },
        importedAt: "2026-04-01T00:00:00.000Z",
      }),
      record("source_gone", {
        identifiers: [doi],
        title: "Other title",
        publisher: "Press",
        note: "Cited in the grant.",
        tags: ["methods", "Grant"],
      }),
    ]);
    const collection = await organizeScientSources({
      root: library,
      change: { action: "create-collection", name: "Grant", sourceIds: ["source_gone"] },
      actor: "user",
    });

    const result = await mergeScientLibraryDuplicates({
      library,
      noteLabels: new Map([
        ["source_keep", "Thesis"],
        ["source_gone", "Grant"],
      ]),
    });

    expect([result.mergedCount, result.keptDifferentCount]).toEqual([1, 1]);
    const [merge] = result.merges;
    expect(merge?.conflicts).toEqual([
      { field: "title", kept: "Kept title", other: "Other title" },
    ]);
    const merged = await readScientSourceRecord(library, "source_keep");
    expect(merged).toMatchObject({
      title: "Kept title",
      publisher: "Press",
      tags: ["Methods", "Grant"],
      note: "From Thesis:\nRead for chapter 2.\n\nFrom Grant:\nCited in the grant.",
    });
    const membership = async () =>
      (await readScientSourcesOrganization(library)).collections.find(
        (entry) => entry.collectionId === collection.collection?.collectionId,
      )?.sourceIds;
    expect(await membership()).toEqual(["source_keep"]);
    expect(resolveScientLibraryAlias(await readScientLibraryAliases(library), "source_gone")).toBe(
      "source_keep",
    );
    expect(await restoreScientSource({ root: library, sourceId: "source_gone" })).toMatchObject({
      outcome: "duplicate",
      matchingSourceIds: ["source_keep"],
    });

    const edited = await updateScientSourceMetadata({
      root: library,
      sourceId: "source_keep",
      expectedRevision: merged!.revision,
      metadata: { ...editableMetadataFromRecord(merged!), publisher: "Edited press" },
    });
    expect(edited.outcome).toBe("updated");

    const undone = await undoScientLibraryMerge({ library, mergeId: merge!.mergeId });

    expect(undone).toMatchObject({ outcome: "undone", unrevertedFields: ["publisher"] });
    expect(await readScientSourceRecord(library, "source_keep")).toMatchObject({
      publisher: "Edited press",
      tags: ["Methods"],
      note: "Read for chapter 2.",
    });
    expect(await readScientSourceRecord(library, "source_gone")).toMatchObject({
      title: "Other title",
      citationKey: "sourcegone",
    });
    expect(await membership()).toEqual(["source_gone"]);
    const aliases = await readScientLibraryAliases(library);
    expect(aliases.get("source_gone")?.undoneAt).toBeDefined();
    expect(resolveScientLibraryAlias(aliases, "source_gone")).toBe("source_gone");
    expect(await undoScientLibraryMerge({ library, mergeId: merge!.mergeId })).toEqual({
      outcome: "already-undone",
    });
  });

  it("keeps a merged source read and starred if either was, and Undo restores each one's own", async () => {
    const { root, library } = await newLibrary();
    const doi = { scheme: "doi", value: "10.1000/reading" };
    const withState = (sourceId: string, readingStatus: string, starred: boolean) =>
      ({
        ...record(sourceId, { identifiers: [doi] }),
        readingStatus,
        starred,
      }) as ScientSourceRecord;
    await seed(root, [
      withState("source_keep", "unread", true),
      withState("source_gone", "read", false),
    ]);

    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: ["source_keep", "source_gone"],
      survivorId: "source_keep",
    });

    expect(merged.outcome).toBe("merged");
    expect(await readScientSourceRecord(library, "source_keep")).toMatchObject({
      readingStatus: "read",
      starred: true,
    });
    const mergeId = merged.outcome === "merged" ? merged.merge.mergeId : "";
    expect(await undoScientLibraryMerge({ library, mergeId })).toMatchObject({
      outcome: "undone",
      survivor: { readingStatus: "unread", starred: true },
      loser: { readingStatus: "read", starred: false },
    });
  });

  it("lists a shared ISBN or ISSN for one title or two whole books, never across different DOIs", async () => {
    const { root, library } = await newLibrary();
    const issn = { scheme: "issn", value: "1234-5679" };
    const isbn = { scheme: "isbn", value: "9780000000026" };
    const editorial = (sourceId: string, issuedYear: number, doi?: string) =>
      record(sourceId, {
        title: "Editorial",
        issuedYear,
        identifiers: [issn, ...(doi ? [{ scheme: "doi", value: doi }] : [])],
      });
    await seed(root, [
      editorial("source_a1", 2020, "10.1000/editorial.1"),
      editorial("source_a2", 2021),
      editorial("source_a3", 2022, "10.1000/editorial.3"),
      record("source_b1", { type: "book", title: "Atlas", identifiers: [isbn] }),
      record("source_b2", {
        type: "book",
        title: "Atlas of the world, second edition",
        issuedYear: 2021,
        identifiers: [isbn],
      }),
    ]);

    const result = await mergeScientLibraryDuplicates({ library });

    expect(result.mergedCount).toBe(0);
    expect(result.possibleDuplicates).toEqual([
      { sourceIds: ["source_a1", "source_a2"], kind: "possible-container-match" },
      { sourceIds: ["source_a2", "source_a3"], kind: "possible-container-match" },
      { sourceIds: ["source_b1", "source_b2"], kind: "possible-container-match" },
    ]);
  });

  it.each([
    { edited: false, live: ["source_old"], resolvesTo: "source_old", trashed: 1 },
    { edited: true, live: ["source_new", "source_old"], resolvesTo: "source_new", trashed: 0 },
  ])(
    "settles a merge whose loser stayed live beside its trash entry (edited since: $edited)",
    async ({ edited, live, resolvesTo, trashed }) => {
      const { root, library } = await newLibrary();
      const doi = { scheme: "doi", value: "10.1000/stuck" };
      await seed(root, [
        record("source_old", { identifiers: [doi] }),
        record("source_new", {
          identifiers: [doi],
          publisher: "Press",
          importedAt: "2026-02-01T00:00:00.000Z",
        }),
      ]);
      failNext("unlink", /records[\\/]source_new\.json$/u);
      expect((await mergeScientLibraryDuplicates({ library })).failures).toHaveLength(1);
      expect(await liveIds(library)).toEqual(["source_new", "source_old"]);
      if (edited) {
        const update = await updateScientSourceNote({
          root: library,
          sourceId: "source_new",
          expectedRevision: 1,
          note: "Written after the failure.",
        });
        expect(update.outcome).toBe("updated");
      }

      // Any merge write settles what the failure left.
      expect(await undoScientLibraryMerge({ library, mergeId: "merge_none" })).toEqual({
        outcome: "not-found",
      });

      expect(await liveIds(library)).toEqual(live);
      expect(resolveScientLibraryAlias(await readScientLibraryAliases(library), "source_new")).toBe(
        resolvesTo,
      );
      expect(await readScientSourceTrashEntries(library)).toHaveLength(trashed);
    },
  );

  it("keeps collection membership for Undo when a crash follows the collection rewrite", async () => {
    const { root, library } = await newLibrary();
    const doi = { scheme: "doi", value: "10.1000/crash" };
    await seed(root, [
      record("source_keep", { identifiers: [doi] }),
      record("source_gone", { identifiers: [doi], importedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    const created = await organizeScientSources({
      root: library,
      change: { action: "create-collection", name: "Grant", sourceIds: ["source_gone"] },
      actor: "user",
    });
    const membership = async () =>
      (await readScientSourcesOrganization(library)).collections.find(
        (entry) => entry.collectionId === created.collection?.collectionId,
      )?.sourceIds;
    failNext("rename", /merges[\\/]merge_[^\\/]+\.json$/u);
    await expect(mergeScientLibraryDuplicates({ library })).rejects.toThrow("Injected");
    expect(await membership()).toEqual(["source_keep"]);
    const [entry] = await readScientSourceTrashEntries(library);

    const undone = await undoScientLibraryMerge({
      library,
      mergeId: entry!.mergedInto!.mergeId,
    });

    expect(undone.outcome).toBe("undone");
    expect(await membership()).toEqual(["source_gone"]);
  });

  it("reads possible pairs and undoable merges without merging anything", async () => {
    const { root, library } = await newLibrary();
    const doi = { scheme: "doi", value: "10.1000/auto" };
    await seed(root, [
      record("source_auto1", { identifiers: [doi] }),
      record("source_auto2", { identifiers: [doi], importedAt: "2026-02-01T00:00:00.000Z" }),
      record("source_pair1", { title: "Same study", publisher: "North Press" }),
      record("source_pair2", {
        title: "Same study",
        publisher: "South Press",
        importedAt: "2026-03-01T00:00:00.000Z",
      }),
      record("source_apart1", { title: "Apart" }),
      record("source_apart2", { title: "Apart", importedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    await markScientLibrarySourcesDistinct({
      library,
      sourceIds: ["source_apart1", "source_apart2"],
    });
    const read = () => readScientLibraryDuplicates({ library, mergeLimit: 10 });

    const before = await read();
    expect(before.possibleDuplicates).toEqual([
      {
        sourceIds: ["source_pair1", "source_pair2"],
        kind: "possible-metadata-match",
        survivorId: "source_pair1",
      },
    ]);
    expect(before.merges).toEqual([]);
    expect(await liveIds(library)).toHaveLength(6);

    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: ["source_pair1", "source_pair2"],
      survivorId: "source_pair2",
    });
    const mergeId = merged.outcome === "merged" ? merged.merge.mergeId : "";
    const after = await read();
    expect(after.possibleDuplicates).toEqual([]);
    expect(after.mergesTotal).toBe(1);
    expect(after.merges.map(({ merge, merged: away }) => [merge.mergeId, away.sourceId])).toEqual([
      [mergeId, "source_pair1"],
    ]);
    expect(after.merges[0]?.merge.conflicts).toEqual([
      { field: "publisher", kept: "South Press", other: "North Press" },
    ]);

    await undoScientLibraryMerge({ library, mergeId });
    const undone = await read();
    expect(undone.merges).toEqual([]);
    expect(undone.possibleDuplicates).toEqual(before.possibleDuplicates);
    expect(await liveIds(library)).toHaveLength(6);
  });
});
