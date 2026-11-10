// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "@scientfactory/scient-sources/store";
import { editableMetadataFromRecord } from "@scientfactory/scient-sources";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { advanceSourceImport, beginZoteroScopedImport } from "./ScientSourcesCoordinator.ts";
import { fakeZoteroAccess, fakeZoteroTransport, zoteroItem } from "./Zotero.testkit.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import { refreshZoteroSources } from "./ZoteroSync.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function importedFromZotero(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem> = [],
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-refresh-"));
  roots.push(root);
  await initializeScientProject({ root });
  const library = { items: new Map([[item.key, { item, children }]]) };
  const zotero = fakeZoteroAccess(fakeZoteroTransport(library));
  await beginZoteroScopedImport({
    root,
    operationId: "import",
    scope: { kind: "library" },
    zotero,
  });
  await advanceSourceImport({ root, operationId: "import", zotero });
  const [record] = await listScientSourceRecords(root);
  if (!record) throw new Error("The fixture source was not imported.");
  return { root, library, zotero, record };
}

const original = zoteroItem("ABCD2345", {
  version: 3,
  title: "Original title",
  abstractNote: "Original abstract.",
  publicationTitle: "Journal A",
  date: "2020",
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

  it("leaves a source alone when its item is gone from Zotero", async () => {
    const { root, library, zotero, record } = await importedFromZotero(original);
    library.items.delete("ABCD2345");

    const result = await refreshZoteroSources({ root, actor: "user", zotero });

    expect(result.items[0]).toMatchObject({ outcome: "missing", message: "No longer in Zotero." });
    expect(await readScientSourceRecord(root, record.sourceId)).toMatchObject({
      title: "Original title",
    });
  });
});
