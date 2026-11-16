// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  detachScientSourcePdf,
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceZoteroSync,
  updateScientSourceMetadata,
  updateScientSourceNote,
  writeScientSourceZoteroSync,
} from "@scientfactory/scient-sources/store";
import { editableMetadataFromRecord } from "@scientfactory/scient-sources";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { advanceSourceImport, beginZoteroScopedImport } from "./ScientSourcesCoordinator.ts";
import {
  mutateScientAnnotations,
  readScientAnnotationFile,
} from "../annotations/annotationStore.ts";
import { readerAnchor, textPdf } from "../annotations/annotationTestUtils.ts";
import {
  fakeZoteroAccess,
  fakeZoteroAccessWithGroup,
  fakeZoteroTransport,
  zoteroGroupItem,
  zoteroItem as rawZoteroItem,
  type FakeZoteroLibrary,
} from "./Zotero.testkit.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import { refreshZoteroSources } from "./ZoteroSync.ts";

const roots: string[] = [];

// Ordinary refresh fixtures represent a signed-in local library, not an unbound library "0".
const zoteroItem: typeof rawZoteroItem = (key, data = {}, libraryId = 475425) =>
  rawZoteroItem(key, data, libraryId);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function importedFromZotero(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem> = [],
  more: Omit<FakeZoteroLibrary, "items"> = {},
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-refresh-"));
  roots.push(root);
  await initializeScientProject({ root });
  const library = { items: new Map([[item.key, { item, children }]]), ...more };
  const zotero = fakeZoteroAccess(fakeZoteroTransport(library));
  await beginZoteroScopedImport({
    root,
    operationId: "import",
    scope: { kind: "library" },
    zotero,
  });
  const operation = await advanceSourceImport({ root, operationId: "import", zotero });
  const [record] = await listScientSourceRecords(root);
  if (!record) throw new Error("The fixture source was not imported.");
  return { root, library, zotero, record, operation };
}

const original = zoteroItem("ABCD2345", {
  version: 3,
  title: "Original title",
  abstractNote: "Original abstract.",
  publicationTitle: "Journal A",
  date: "2020",
  DOI: "10.1000/refresh-original",
  tags: [{ tag: "kept" }, { tag: "dropped" }],
});

async function editHere(
  root: string,
  sourceId: string,
  change: { title?: string; tags?: string[] },
) {
  const record = await readScientSourceRecord(root, sourceId);
  if (!record) throw new Error("missing");
  const result = await updateScientSourceMetadata({
    root,
    sourceId,
    expectedRevision: record.revision,
    metadata: { ...editableMetadataFromRecord(record), ...change },
  });
  return result.record;
}

describe("Zotero refresh", () => {
  it("refuses a legacy unbound link when another local work has its key after an account switch", async () => {
    const initial = rawZoteroItem("ABCD2345", {
      title: "Original offline work",
      DOI: "10.1000/offline-original",
      version: 3,
    });
    const { root, record, library, zotero } = await importedFromZotero(initial);
    library.items.set(initial.key, {
      item: rawZoteroItem(
        initial.key,
        {
          title: "Unrelated signed-in work",
          DOI: "10.1000/unrelated",
          version: 3,
        },
        475425,
      ),
      children: [],
    });
    const before = await readScientSourceRecord(root, record.sourceId);
    const base = await readScientSourceZoteroSync(root, record.sourceId);

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      message: "This Zotero library's owner could not be verified. No source was refreshed.",
    });
    expect(await readScientSourceRecord(root, record.sourceId)).toEqual(before);
    expect(await readScientSourceZoteroSync(root, record.sourceId)).toEqual(base);
  });

  it("leaves an unbound offline library unchanged when its owner cannot be verified", async () => {
    const unbound = rawZoteroItem("ABCD2345", { title: "Offline original", version: 3 });
    const { root, record, library, zotero } = await importedFromZotero(unbound);
    library.items.set(unbound.key, {
      item: rawZoteroItem(unbound.key, { title: "Offline changed", version: 4 }),
      children: [],
    });
    const before = await readScientSourceRecord(root, record.sourceId);
    const base = await readScientSourceZoteroSync(root, record.sourceId);

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      message: "This Zotero library's owner could not be verified. No source was refreshed.",
    });
    expect(await readScientSourceRecord(root, record.sourceId)).toEqual(before);
    expect(await readScientSourceZoteroSync(root, record.sourceId)).toEqual(base);
  });

  it("does not refresh a personal source from another local owner with the same item key", async () => {
    const { root, record, library, zotero } = await importedFromZotero(original);
    library.items.set(original.key, {
      item: rawZoteroItem(original.key, { ...original.data, title: "Another owner" }, 99999),
      children: [],
    });
    const before = await readScientSourceRecord(root, record.sourceId);
    const result = await refreshZoteroSources({ root, actor: "user", zotero });
    expect(result.items[0]?.outcome).toBe("failed");
    expect(await readScientSourceRecord(root, record.sourceId)).toEqual(before);
  });

  it("reads a large Library again in batches, and of a project's sources only Zotero's", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-refresh-"));
    roots.push(root);
    await initializeScientProject({ root });
    const keys = ["AAAA2345", "BBBB2345", "CCCC2345"];
    const items = new Map(
      keys.map((key, index) => [
        key,
        {
          item: zoteroItem(key, {
            title: `Batch reference ${key}`,
            abstractNote: "A.",
            creators: [{ creatorType: "author", lastName: `Writer${key}` }],
            date: String(1700 + index),
          }),
          children: [],
        },
      ]),
    );
    const zotero = fakeZoteroAccess(fakeZoteroTransport({ items }));
    await beginZoteroScopedImport({
      root,
      operationId: "import",
      scope: { kind: "library" },
      zotero,
    });
    let operation = await advanceSourceImport({ root, operationId: "import", zotero });
    while (operation.state === "running") {
      operation = await advanceSourceImport({ root, operationId: "import", zotero });
    }
    const sourceIds = (await listScientSourceRecords(root))
      .map((record) => record.sourceId)
      .toSorted();
    expect(sourceIds).toHaveLength(3);

    const batch = (after: string | null) =>
      refreshZoteroSources({ root, actor: "user", zotero, after, batchSize: 2 });
    const first = await batch(null);
    expect(first.items.map((item) => item.sourceId)).toEqual(sourceIds.slice(0, 2));
    expect(first).toMatchObject({ total: 3, next: sourceIds[1] });
    // The batch after a source, not after a count: one removed meanwhile skips no other.
    const last = await batch(sourceIds[0] ?? "");
    expect(last.items.map((item) => item.sourceId)).toEqual(sourceIds.slice(1));
    expect(last.total).toBe(3);
    expect(last.next).toBeUndefined();

    // A project's sources: the two of them that came from Zotero, and no failure for others.
    const among = await refreshZoteroSources({
      root,
      actor: "user",
      zotero,
      among: [sourceIds[2] ?? "", sourceIds[0] ?? "", "source_not_from_zotero"],
    });
    expect(among.items.map((item) => [item.sourceId, item.outcome])).toEqual([
      [sourceIds[0], "unchanged"],
      [sourceIds[2], "unchanged"],
    ]);
  });

  it("takes Zotero's changes and keeps edits made here, reporting the clash", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original);
    await editHere(root, record.sourceId, { title: "My corrected title" });
    library.items.set("ABCD2345", {
      item: zoteroItem("ABCD2345", {
        ...original.data,
        version: 4,
        title: "Zotero's new title",
        publicationTitle: "Journal B",
        tags: [{ tag: "kept" }, { tag: "added" }],
      }),
      children: [],
    });

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    const refreshed = await readScientSourceRecord(root, record.sourceId);
    expect(refreshed?.title).toBe("My corrected title");
    expect(refreshed?.containerTitle).toBe("Journal B");
    expect(refreshed?.tags).toEqual(["kept", "added"]);
    expect(refreshed?.externalReferences[0]?.itemVersion).toBe(4);
    expect(result.items[0]).toMatchObject({
      outcome: "updated",
      conflicts: [{ field: "title", local: "My corrected title", zotero: "Zotero's new title" }],
    });
    expect(result.items[0]?.changedFields).toEqual(
      expect.arrayContaining(["containerTitle", "tags"]),
    );
  });

  it("compares each further detail on its own: takes a new one, keeps an edited one, reports it", async () => {
    const book = zoteroItem("ABCD2345", {
      itemType: "book",
      version: 3,
      title: "A book",
      abstractNote: "A.",
      ...({ edition: "2nd", place: "Leiden" } as object),
    });
    const { root, library, zotero, record } = await importedFromZotero(book);
    expect(record.more).toEqual({ edition: "2nd", "publisher-place": "Leiden" });
    // The edition is corrected here, and the place is removed here on purpose.
    const edited = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: { ...editableMetadataFromRecord(record), more: { edition: "2nd revised" } },
    });
    expect(edited.record?.more).toEqual({ edition: "2nd revised" });
    // In Zotero the edition changes too, and a series and a page count are added.
    library.items.set("ABCD2345", {
      item: zoteroItem("ABCD2345", {
        ...book.data,
        version: 4,
        ...({ edition: "3rd", place: "Leiden", series: "Methods", numPages: "412" } as object),
      }),
      children: [],
    });

    const result = await refreshZoteroSources({ root, actor: "user", zotero });
    const refreshed = await readScientSourceRecord(root, record.sourceId);
    // New details arrive; the edit here stands; the place stays removed (Zotero's is unchanged).
    expect(refreshed?.more).toEqual({
      edition: "2nd revised",
      "collection-title": "Methods",
      "number-of-pages": "412",
    });
    expect(result.items[0]).toMatchObject({
      outcome: "updated",
      changedFields: expect.arrayContaining(["more"]),
      conflicts: [{ field: "more", local: "Edition: 2nd revised", zotero: "Edition: 3rd" }],
    });
    // Only what was taken is Zotero's; the edition is still the person's.
    expect(
      refreshed?.fieldProvenance
        .filter((entry) => entry.field.startsWith("more."))
        .map((entry) => [entry.field, entry.origin])
        .toSorted(),
    ).toEqual([
      ["more.collection-title", "zotero"],
      ["more.edition", "user"],
      ["more.number-of-pages", "zotero"],
      ["more.publisher-place", "user"],
    ]);

    // The clash is said again until a side is picked; "Use Zotero's" takes the edition.
    const again = await refreshZoteroSources({ root, actor: "user", zotero });
    expect(again.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["more"]);
    await refreshZoteroSources({
      root,
      actor: "user",
      zotero,
      sourceIds: [record.sourceId],
      choices: { useZotero: new Set(["more"]) },
    });
    // The edition that clashed is Zotero's now; the place removed here stays removed.
    expect((await readScientSourceRecord(root, record.sourceId))?.more).toEqual({
      edition: "3rd",
      "collection-title": "Methods",
      "number-of-pages": "412",
    });
    expect(
      (await refreshZoteroSources({ root, actor: "user", zotero })).items[0]?.conflicts,
    ).toEqual([]);
  });

  it("brings the further details to a source that was imported before they were kept", async () => {
    const book = zoteroItem("ABCD2345", {
      itemType: "book",
      version: 3,
      title: "A book",
      abstractNote: "A.",
      ...({ edition: "2nd", place: "Leiden" } as object),
    });
    const { root, zotero, record } = await importedFromZotero(book);
    // As an import made before this: the record has none, and neither has what was last read.
    const { more: _more, ...without } = record;
    const recordFile = NodePath.join(
      root,
      ".scient",
      "sources",
      "records",
      `${record.sourceId}.json`,
    );
    await NodeFSP.writeFile(
      recordFile,
      JSON.stringify({
        ...without,
        fieldProvenance: without.fieldProvenance.filter(
          (entry) => !entry.field.startsWith("more."),
        ),
      }),
    );
    const baseFile = NodePath.join(
      root,
      ".scient",
      "sources",
      "sync",
      "zotero",
      `${record.sourceId}.json`,
    );
    const base = JSON.parse(await NodeFSP.readFile(baseFile, "utf8")) as {
      metadata: Record<string, unknown>;
    };
    delete base.metadata.more;
    await NodeFSP.writeFile(baseFile, JSON.stringify(base));

    const result = await refreshZoteroSources({ root, actor: "user", zotero });
    expect(result.items[0]).toMatchObject({ outcome: "updated", changedFields: ["more"] });
    expect((await readScientSourceRecord(root, record.sourceId))?.more).toEqual({
      edition: "2nd",
      "publisher-place": "Leiden",
    });
  });

  it("keeps reporting an open clash until the user picks a side", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original);
    await editHere(root, record.sourceId, { title: "Mine" });
    library.items.set("ABCD2345", {
      item: zoteroItem("ABCD2345", { ...original.data, version: 4, title: "Theirs" }),
      children: [],
    });

    await refreshZoteroSources({ root, actor: "user", zotero });
    const again = await refreshZoteroSources({ root, actor: "user", zotero });
    expect(again.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["title"]);

    const resolved = await refreshZoteroSources({
      root,
      actor: "agent",
      zotero,
      sourceIds: [record.sourceId],
      choices: { useZotero: new Set(["title"]) },
    });
    expect(resolved.items[0]).toMatchObject({ outcome: "updated", conflicts: [] });
    const after = await readScientSourceRecord(root, record.sourceId);
    expect(after?.title).toBe("Theirs");
    expect(after?.updatedBy).toBe("agent");
    expect(
      (await refreshZoteroSources({ root, actor: "user", zotero })).items[0]?.conflicts,
    ).toEqual([]);
  });

  it("does not undo an edit here when Zotero did not change that field", async () => {
    const { root, zotero, record } = await importedFromZotero(original);
    await editHere(root, record.sourceId, { title: "Edited here", tags: ["kept"] });

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({ outcome: "unchanged", conflicts: [] });
    const after = await readScientSourceRecord(root, record.sourceId);
    expect(after?.title).toBe("Edited here");
    expect(after?.tags).toEqual(["kept"]);
  });

  it("brings new notes and PDFs, but keeps a note edited here", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original, [
      zoteroItem("NOTE2345", { itemType: "note", note: "<p>First</p>" }),
    ]);
    const pdfPath = NodePath.join(root, "new.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nnew\n", "utf8");
    library.items.set("ABCD2345", {
      item: original,
      children: [
        zoteroItem("NOTE2345", { itemType: "note", note: "<p>First, revised</p>" }),
        zoteroItem("PDFA2345", {
          itemType: "attachment",
          contentType: "application/pdf",
          filename: "new.pdf",
        }),
      ],
    });
    const withFile = fakeZoteroAccess(
      fakeZoteroTransport({ ...library, files: new Map([["PDFA2345", pdfPath]]) }),
    );

    const first = await refreshZoteroSources({ root, actor: "user", zotero: withFile });
    expect(first.items[0]).toMatchObject({ addedPdfCount: 1 });
    expect((await readScientSourceRecord(root, record.sourceId))?.note).toBe("First, revised");

    const current = await readScientSourceRecord(root, record.sourceId);
    await updateScientSourceNote({
      root,
      sourceId: record.sourceId,
      expectedRevision: current?.revision ?? 0,
      note: "My own note",
    });
    library.items.set("ABCD2345", {
      item: original,
      children: [zoteroItem("NOTE2345", { itemType: "note", note: "<p>Third version</p>" })],
    });
    const second = await refreshZoteroSources({ root, actor: "user", zotero });
    expect(second.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["note"]);
    expect((await readScientSourceRecord(root, record.sourceId))?.note).toBe("My own note");
  });

  it("keeps a note cleared here when Zotero changes it", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original, [
      zoteroItem("NOTE2345", { itemType: "note", note: "<p>First</p>" }),
    ]);
    await updateScientSourceNote({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      note: null,
    });
    library.items.set("ABCD2345", {
      item: original,
      children: [zoteroItem("NOTE2345", { itemType: "note", note: "<p>Second</p>" })],
    });

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["note"]);
    expect((await readScientSourceRecord(root, record.sourceId))?.note ?? null).toBeNull();
  });

  // The same Zotero note, as an import wrote it before notes became Markdown and as it is now.
  const noteHtml = '<h1>Aims</h1><p>See <a href="https://example.org">the errata</a>.</p>';
  const earlierText = "Aims\n\nSee the errata.";
  const markdown = "# Aims\n\nSee [the errata](https://example.org).";
  const revisedHtml = "<h1>Aims</h1><p>Revised in Zotero.</p>";
  const revisedMarkdown = "# Aims\n\nRevised in Zotero.";
  const kept = (html: string) => ({
    itemKey: "NOTE2345",
    sha256: NodeCrypto.createHash("sha256").update(html).digest("hex"),
    html,
  });

  it.each([
    // [the import, edited here, changed in Zotero] → the note after, and whether it clashes
    { imported: "earlier", edited: false, changed: false, note: markdown, clash: false },
    { imported: "earlier", edited: true, changed: false, note: "My own words", clash: false },
    { imported: "earlier", edited: false, changed: true, note: revisedMarkdown, clash: false },
    { imported: "earlier", edited: true, changed: true, note: "My own words", clash: true },
    { imported: "before-bases", edited: false, changed: false, note: markdown, clash: false },
    // With no base nothing tells an earlier import's text from an edit once Zotero changed.
    { imported: "before-bases", edited: false, changed: true, note: earlierText, clash: true },
    { imported: "before-bases", edited: true, changed: false, note: "My own words", clash: true },
    { imported: "before-bases", edited: true, changed: true, note: "My own words", clash: true },
    { imported: "now", edited: false, changed: false, note: markdown, clash: false },
    { imported: "now", edited: true, changed: false, note: "My own words", clash: false },
    { imported: "now", edited: false, changed: true, note: revisedMarkdown, clash: false },
    { imported: "now", edited: true, changed: true, note: "My own words", clash: true },
    // Only a colour changed in Zotero, which Markdown does not show: nothing to choose between.
    { imported: "now", edited: true, changed: "colour", note: "My own words", clash: false },
  ] as const)(
    "refreshes the note of a source imported $imported (edited here: $edited, changed in Zotero: $changed)",
    async ({ imported, edited, changed, note, clash }) => {
      const { root, library, zotero, record } = await importedFromZotero(original, [
        zoteroItem("NOTE2345", { itemType: "note", note: noteHtml }),
      ]);
      const { sourceId } = record;
      const setNote = async (text: string) => {
        const current = await readScientSourceRecord(root, sourceId);
        await updateScientSourceNote({
          root,
          sourceId,
          expectedRevision: current?.revision ?? 0,
          note: text,
        });
      };
      if (imported !== "now") {
        // As the earlier import left it: plain text in the note, and no HTML kept.
        await setNote(earlierText);
        const base = await readScientSourceZoteroSync(root, sourceId);
        if (!base) throw new Error("The import wrote no base.");
        const { notes: _notes, ...earlier } = base;
        if (imported === "earlier") {
          await writeScientSourceZoteroSync(root, { ...earlier, note: earlierText });
        } else {
          await NodeFSP.rm(
            NodePath.join(root, ".scient", "sources", "sync", "zotero", `${sourceId}.json`),
          );
        }
      }
      if (edited) await setNote("My own words");
      const zoteroHtml =
        changed === "colour"
          ? noteHtml.replace("<h1>", '<h1 style="color: red">')
          : changed
            ? revisedHtml
            : noteHtml;
      library.items.set("ABCD2345", {
        item: original,
        children: [zoteroItem("NOTE2345", { itemType: "note", note: zoteroHtml })],
      });

      // Twice: a clash stays a clash, and nothing changes the second time.
      for (const _round of [1, 2]) {
        const result = await refreshZoteroSources({ root, actor: "user", zotero });
        expect(result.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(
          clash ? ["note"] : [],
        );
        expect((await readScientSourceRecord(root, sourceId))?.note).toBe(note);
      }
      // Zotero's own HTML is kept from the first refresh on; an open clash keeps the base it had.
      expect((await readScientSourceZoteroSync(root, sourceId))?.notes).toEqual(
        clash ? (imported === "now" ? [kept(noteHtml)] : undefined) : [kept(zoteroHtml)],
      );
    },
  );

  it("says a note too long to keep as Zotero wrote it, and still sees it change in Zotero", async () => {
    // Formatting makes the HTML pass what is kept while the note itself is short.
    const long = (letter: string) =>
      `<p>${`<span style="color: #ff2020">${letter}</span>`.repeat(40_000)}</p>`;
    const { root, library, zotero, record, operation } = await importedFromZotero(original, [
      zoteroItem("NOTE2345", { itemType: "note", note: long("a") }),
    ]);
    expect(operation.items[0]?.notBrought).toEqual([
      { kind: "note-cut", name: "original", count: 1 },
    ]);
    await updateScientSourceNote({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      note: "My own words",
    });
    library.items.set("ABCD2345", {
      item: original,
      children: [zoteroItem("NOTE2345", { itemType: "note", note: long("b") })],
    });

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["note"]);
    expect((await readScientSourceRecord(root, record.sourceId))?.note).toBe("My own words");
  });

  it("leaves a source alone when its item is gone from Zotero", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original);
    library.items.delete("ABCD2345");

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({ outcome: "missing", message: "No longer in Zotero." });
    expect(await readScientSourceRecord(root, record.sourceId)).toMatchObject({
      title: "Original title",
    });
  });

  it("reads a group item again from its group", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-refresh-"));
    roots.push(root);
    await initializeScientProject({ root });
    const groupItem = (title: string, version: number) => ({
      item: zoteroGroupItem("ABCD2345", { ...original.data, title, version }, "4321"),
      children: [],
    });
    const group = { items: new Map([["ABCD2345", groupItem("Lab title", 3)]]) };
    const mine = { items: new Map([["ABCD2345", { item: original, children: [] }]]) };
    const zotero = fakeZoteroAccessWithGroup(
      fakeZoteroTransport(mine),
      "4321",
      fakeZoteroTransport(group),
    );
    const operation = { root, operationId: "lab", zotero };
    await beginZoteroScopedImport({ ...operation, scope: { kind: "library" }, groupId: "4321" });
    await advanceSourceImport(operation);
    group.items.set("ABCD2345", groupItem("Lab title, revised", 4));

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    const [record] = await listScientSourceRecords(root);
    expect(record?.title).toBe("Lab title, revised");
    expect(record?.externalReferences[0]).toMatchObject({
      libraryId: "groups/4321",
      itemVersion: 4,
    });
    expect(result.items.map((item) => item.outcome)).toEqual(["updated"]);
  });

  // Constructed in Zotero's documented item format: public libraries do not hand out the PDFs.
  const mark = (key: string, text: string, parentItem = "PDFA2345", comment = `On ${key}`) =>
    zoteroItem(key, {
      itemType: "annotation",
      parentItem,
      annotationType: "highlight",
      annotationText: text,
      annotationComment: comment,
      annotationColor: "#FF6666",
      annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[72, 700, 300, 712]] }),
      dateAdded: "2024-01-24T04:36:20Z",
    });

  async function withHighlightedPdf(annotations: ReadonlyArray<ZoteroRawItem>, libraryId = 475425) {
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-pdf-"));
    roots.push(folder);
    const pdfPath = NodePath.join(folder, "paper.pdf");
    await NodeFSP.writeFile(pdfPath, textPdf([["Results were strong in the first trial."]]));
    const onFiles = new Map<string, ReadonlyArray<ZoteroRawItem>>([
      [
        "PDFA2345",
        annotations.map((entry) => ({
          ...entry,
          library: { type: "user", id: libraryId },
        })),
      ],
      [
        "EPUB2345",
        [
          {
            ...mark("EPUBMARK", "On the book", "EPUB2345"),
            library: { type: "user", id: libraryId },
          },
        ],
      ],
    ]);
    const imported = await importedFromZotero(
      { ...original, library: { type: "user", id: libraryId } },
      [
        zoteroItem("PDFA2345", {
          itemType: "attachment",
          contentType: "application/pdf",
          filename: "paper.pdf",
        }),
        zoteroItem("EPUB2345", {
          itemType: "attachment",
          contentType: "application/epub+zip",
          filename: "paper.epub",
        }),
      ].map((entry) => ({ ...entry, library: { type: "user", id: libraryId } })),
      { files: new Map([["PDFA2345", pdfPath]]), annotations: onFiles },
    );
    const home = await NodeFSP.realpath(imported.root);
    const [pdf] = imported.record.attachments;
    if (!pdf) throw new Error("The PDF was not imported.");
    const material = { sha256: pdf.sha256, byteLength: pdf.byteLength };
    const addInZotero = (entry: ZoteroRawItem) =>
      onFiles.set("PDFA2345", [...(onFiles.get("PDFA2345") ?? []), entry]);
    const marks = async () => {
      const file = await readScientAnnotationFile(home, pdf.sha256);
      return {
        placed: file?.annotations.map((entry) => ({
          id: entry.annotationId,
          note: entry.note,
          color: entry.color,
          by: entry.createdBy,
          at: entry.createdAt,
          removed: entry.deletedAt !== null,
        })),
        unplaced: file?.unplaced?.map((entry) => [entry.annotationId, entry.quote, entry.comment]),
      };
    };
    return { ...imported, home, material, marks, addInZotero, onFiles };
  }

  it("places Zotero's highlights on the PDF, keeps the others in its list, and brings each once", async () => {
    const { root, zotero, operation, home, material, marks, addInZotero } =
      await withHighlightedPdf([
        mark("HIGH2345", "strong in the first"),
        mark("GONE2345", "Not in the text"),
      ]);
    const imported = await marks();
    expect(imported.placed).toEqual([
      {
        id: expect.any(String),
        note: "On HIGH2345",
        color: "#ff6666",
        by: "user",
        at: "2024-01-24T04:36:20Z",
        removed: false,
      },
    ]);
    const placed = imported.placed?.[0];
    if (!placed) throw new Error("The fixture highlight was not imported.");
    const kept = imported.unplaced;
    expect(kept?.map(([_id, quote, comment]) => [quote, comment])).toEqual([
      ["Not in the text", "On GONE2345"],
    ]);
    expect(operation.items[0]?.notBrought).toEqual(
      expect.arrayContaining([
        { kind: "highlights", name: "unplaced", count: 1 },
        { kind: "highlights", name: "no-file", count: 1 },
      ]),
    );

    // Removed here, and a new one made in Zotero: a refresh brings the new one only.
    await mutateScientAnnotations({
      canonicalRoot: home,
      material,
      relativePath: null,
      command: { action: "remove", annotationId: placed.id, expectedRevision: 1 },
      actor: "user",
      now: "2026-11-15T10:00:00.000Z",
    });
    addInZotero(mark("NEWW2345", "Results were"));
    const first = await refreshZoteroSources({ root, actor: "user", zotero });
    const refreshed = await marks();
    const second = await refreshZoteroSources({ root, actor: "user", zotero });

    expect([first.items[0]?.changedFields, second.items[0]?.changedFields]).toEqual([
      ["highlights"],
      [],
    ]);
    expect(refreshed).toEqual({
      placed: [
        { ...placed, removed: true },
        { ...placed, id: expect.any(String), note: "On NEWW2345" },
      ],
      unplaced: kept,
    });
    expect(refreshed.placed?.[1]?.id).not.toBe(placed.id);
    expect(await marks()).toEqual(refreshed);
  });

  it("brings the highlights of a source imported before Scient knew which PDF here is Zotero's", async () => {
    const { root, zotero, record, marks, addInZotero } = await withHighlightedPdf([]);
    const base = await readScientSourceZoteroSync(root, record.sourceId);
    if (!base) throw new Error("The import wrote no base.");
    const { pdfs: _pdfs, ...earlier } = base;
    await writeScientSourceZoteroSync(root, earlier);
    addInZotero(mark("HIGH2345", "strong in the first"));

    await refreshZoteroSources({ root, actor: "user", zotero });

    const refreshed = await marks();
    expect(refreshed.placed).toEqual([
      expect.objectContaining({ note: "On HIGH2345", removed: false }),
    ]);
    await refreshZoteroSources({ root, actor: "user", zotero });
    expect(await marks()).toEqual(refreshed);
  });

  it("preserves highlight identities and removals when an initially unbound library signs in", async () => {
    const { root, record, zotero, library, home, material, marks, onFiles } =
      await withHighlightedPdf(
        [mark("HIGH2345", "strong in the first"), mark("GONE2345", "first trial")],
        0,
      );
    expect(record.externalReferences[0]?.libraryId).toBe("0");
    const base = await readScientSourceZoteroSync(root, record.sourceId);
    if (!base) throw new Error("The import wrote no base.");
    const { annotationLibraryId: _namespace, ...legacyBase } = base;
    await writeScientSourceZoteroSync(root, legacyBase);
    const imported = await marks();
    const edited = imported.placed?.find((entry) => entry.note === "On HIGH2345");
    if (!edited) throw new Error("The editable fixture highlight was not imported.");
    await mutateScientAnnotations({
      canonicalRoot: home,
      material,
      relativePath: null,
      command: {
        action: "update",
        annotationId: edited.id,
        expectedRevision: 1,
        note: "My revised highlight note",
      },
      actor: "user",
      now: "2026-11-15T10:00:00.000Z",
    });
    const removed = imported.placed?.find((entry) => entry.note === "On GONE2345");
    if (!removed) throw new Error("The removable fixture highlight was not imported.");
    await mutateScientAnnotations({
      canonicalRoot: home,
      material,
      relativePath: null,
      command: { action: "remove", annotationId: removed.id, expectedRevision: 1 },
      actor: "user",
      now: "2026-11-15T10:00:00.000Z",
    });
    const beforeSignIn = await marks();
    const entry = library.items.get(original.key);
    if (!entry) throw new Error("The fixture source was not imported.");
    library.items.set(original.key, {
      item: { ...entry.item, library: { type: "user", id: 475425 } },
      children: entry.children.map((child) => ({
        ...child,
        library: { type: "user", id: 475425 },
      })),
    });
    for (const [key, annotations] of onFiles) {
      onFiles.set(
        key,
        annotations.map((annotation) => ({
          ...annotation,
          library: { type: "user", id: 475425 },
        })),
      );
    }

    const first = await refreshZoteroSources({ root, actor: "user", zotero });
    const second = await refreshZoteroSources({ root, actor: "user", zotero });

    expect([first.items[0]?.outcome, second.items[0]?.outcome]).toEqual(["unchanged", "unchanged"]);
    expect(
      (await readScientSourceRecord(root, record.sourceId))?.externalReferences[0]?.libraryId,
    ).toBe("475425");
    expect(await readScientSourceZoteroSync(root, record.sourceId)).toMatchObject({
      libraryId: "475425",
      annotationLibraryId: "0",
    });
    expect(await marks()).toEqual(beforeSignIn);
  });

  it("keeps a long Zotero comment whole beside the person's own highlights, and says what it could not keep", async () => {
    const { root, zotero, home, material, addInZotero } = await withHighlightedPdf([]);
    const mine = await mutateScientAnnotations({
      canonicalRoot: home,
      material,
      relativePath: null,
      command: {
        action: "create",
        annotationId: "ann_00000001",
        anchor: readerAnchor({
          text: "Results were strong in the first trial.",
          quote: "first trial",
        }),
        highlighted: true,
        note: "Mine",
      },
      actor: "user",
      now: "2026-11-15T10:00:00.000Z",
    });
    // Past what a highlight's note holds, and past what the list of the others holds.
    const long = "x".repeat(8_001);
    addInZotero(mark("LONG2345", "strong in the first", "PDFA2345", long));
    addInZotero(mark("HUGE2345", "strong in the first", "PDFA2345", "x".repeat(100_001)));

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    const file = await readScientAnnotationFile(home, material.sha256);
    expect(file?.annotations).toEqual([mine.annotation]);
    expect(file?.unplaced?.map((entry) => entry.comment)).toEqual([long]);
    // Said in the refresh's result, as an import says it; the book's highlight is on no PDF.
    expect(result.items[0]?.notBrought).toEqual([
      { kind: "highlights", name: "unplaced", count: 1 },
      { kind: "highlights", name: "no-file", count: 1 },
      { kind: "highlights", name: "too-long", count: 1 },
    ]);
  });

  it("says which highlights it could not bring when their PDF was removed here, and leaves it removed", async () => {
    const { root, zotero, record, addInZotero } = await withHighlightedPdf([
      mark("HIGH2345", "strong in the first"),
    ]);
    const [pdf] = record.attachments;
    await detachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      attachmentId: pdf!.attachmentId,
      expectedRevision: record.revision,
      actor: "user",
    });
    addInZotero(mark("NEWW2345", "Results were"));

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({
      outcome: "unchanged",
      addedPdfCount: 0,
      notBrought: [{ kind: "highlights", name: "no-file", count: 3 }],
    });
    expect((await readScientSourceRecord(root, record.sourceId))?.attachments).toEqual([]);
  });
});
