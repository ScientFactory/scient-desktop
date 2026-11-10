// @effect-diagnostics nodeBuiltinImport:off -- Collection tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  bulkUpdateScientSources,
  changeScientSourceCollectionMembers,
  createScientSourceCollection,
  deleteScientSourceCollection,
  deleteScientSourceSearch,
  organizeScientSources,
  readScientSourcesOrganization,
  renameScientSourceCollection,
  restoreScientSourceCollection,
  saveScientSourceSearch,
  SCIENT_SOURCE_COLLECTIONS_FILE,
} from "./collections.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import type { ScientSourceCandidate, ScientSourceType } from "./model.ts";
import {
  importScientSource,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function candidate(sourceKey: string, title: string): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
    abstract: null,
    containerTitle: "Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

async function project(titles: ReadonlyArray<string>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-collections-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  const sourceIds: string[] = [];
  for (const [index, title] of titles.entries()) {
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(`S${index}`, title),
    });
    if (!imported.record) throw new Error("Expected an imported source.");
    sourceIds.push(imported.record.sourceId);
  }
  return { root, sourceIds };
}

describe("Scient source collections", () => {
  it("adds sources to several collections without rewriting their records", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const before = await readScientSourceRecord(root, first);

    const methods = await createScientSourceCollection({
      root,
      name: "Methods",
      sourceIds: [first, "source_missing"],
      actor: "user",
    });
    const chapter = await createScientSourceCollection({
      root,
      name: "Chapter 2",
      sourceIds: [first, second],
      actor: "agent",
    });

    expect(methods).toMatchObject({ outcome: "created", unknownSourceIds: ["source_missing"] });
    expect(chapter.outcome).toBe("created");
    const organization = await readScientSourcesOrganization(root);
    expect(organization.issue).toBeUndefined();
    expect(organization.collections.map((entry) => [entry.name, entry.sourceIds])).toEqual([
      ["Methods", [first]],
      ["Chapter 2", [first, second]],
    ]);
    expect(organization.collections[1]?.updatedBy).toBe("agent");
    expect(await readScientSourceRecord(root, first)).toEqual(before);
  });

  it("treats a repeated create as the same collection and reports what it added", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const created = await createScientSourceCollection({
      root,
      name: "Reading list",
      sourceIds: [first],
      actor: "agent",
    });
    const repeated = await createScientSourceCollection({
      root,
      name: " reading LIST ",
      sourceIds: [first, second],
      actor: "agent",
    });

    expect(repeated.outcome).toBe("existing");
    if (created.outcome !== "created" || repeated.outcome !== "existing") throw new Error();
    expect(repeated.collection.collectionId).toBe(created.collection.collectionId);
    expect(repeated.addedSourceIds).toEqual([second]);
    expect((await readScientSourcesOrganization(root)).collections).toHaveLength(1);
  });

  it("keeps membership of a removed source hidden, not lost", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const created = await createScientSourceCollection({
      root,
      name: "Methods",
      sourceIds: [first, second],
      actor: "user",
    });
    const record = await readScientSourceRecord(root, second);
    await removeScientSource({ root, sourceId: second, expectedRevision: record?.revision ?? 1 });

    const organization = await readScientSourcesOrganization(root);
    expect(organization.collections[0]?.sourceIds).toEqual([first]);
    const stored = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, SCIENT_SOURCE_COLLECTIONS_FILE), "utf8"),
    );
    if (created.outcome !== "created") throw new Error();
    expect(stored.collections[0].sourceIds).toEqual([first, second]);
  });

  it("renames, deletes and restores a collection, refusing names already used", async () => {
    const { root, sourceIds } = await project(["First"]);
    const methods = await createScientSourceCollection({
      root,
      name: "Methods",
      sourceIds,
      actor: "user",
    });
    await createScientSourceCollection({ root, name: "Results", actor: "user" });
    if (methods.outcome !== "created") throw new Error();
    const collectionId = methods.collection.collectionId;

    expect(
      (await renameScientSourceCollection({ root, collectionId, name: "results", actor: "user" }))
        .outcome,
    ).toBe("name-taken");
    expect(
      (await renameScientSourceCollection({ root, collectionId, name: "Design", actor: "user" }))
        .outcome,
    ).toBe("renamed");
    expect(
      (await deleteScientSourceCollection({ root, collectionId, actor: "agent" })).outcome,
    ).toBe("deleted");
    expect(
      (await readScientSourcesOrganization(root)).collections.map((entry) => entry.name),
    ).toEqual(["Results"]);

    const restored = await restoreScientSourceCollection({ root, collectionId, actor: "user" });
    expect(restored.outcome).toBe("restored");
    const collections = (await readScientSourcesOrganization(root)).collections;
    expect(collections.find((entry) => entry.collectionId === collectionId)?.sourceIds).toEqual(
      sourceIds,
    );
  });

  it("adds and removes members and reports an unknown collection", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const created = await createScientSourceCollection({
      root,
      name: "Methods",
      sourceIds: [first],
      actor: "user",
    });
    if (created.outcome !== "created") throw new Error();

    const changed = await changeScientSourceCollectionMembers({
      root,
      collectionId: created.collection.collectionId,
      add: [second],
      remove: [first],
      actor: "agent",
    });
    expect(changed).toMatchObject({
      outcome: "updated",
      addedSourceIds: [second],
      removedSourceIds: [first],
    });
    expect(
      (
        await changeScientSourceCollectionMembers({
          root,
          collectionId: created.collection.collectionId,
          add: [second],
          actor: "agent",
        })
      ).outcome,
    ).toBe("unchanged");
    expect(
      (
        await changeScientSourceCollectionMembers({
          root,
          collectionId: "collection_missing",
          add: [second],
          actor: "agent",
        })
      ).outcome,
    ).toBe("not-found");
  });

  it("saves a search by name, replaces its filter and deletes it", async () => {
    const { root } = await project([]);
    const saved = await saveScientSourceSearch({
      root,
      name: "Trials with PDFs",
      filter: { text: "trial", hasPdf: true },
      actor: "user",
    });
    const replaced = await saveScientSourceSearch({
      root,
      name: "trials with pdfs",
      filter: { text: "trial", tags: ["rct"] },
      actor: "agent",
    });
    expect(saved.outcome).toBe("created");
    expect(replaced.outcome).toBe("updated");
    const searches = (await readScientSourcesOrganization(root)).savedSearches;
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      name: "trials with pdfs",
      filter: { text: "trial", tags: ["rct"] },
      updatedBy: "agent",
    });
    if (!replaced.savedSearch) throw new Error();
    await deleteScientSourceSearch({
      root,
      searchId: replaced.savedSearch.searchId,
      actor: "user",
    });
    expect((await readScientSourcesOrganization(root)).savedSearches).toEqual([]);
  });

  it("reports a damaged collections file on read and refuses to overwrite it", async () => {
    const { root } = await project(["First"]);
    const filePath = NodePath.join(root, SCIENT_SOURCE_COLLECTIONS_FILE);
    await NodeFSP.writeFile(filePath, "{ not json", "utf8");

    const read = await readScientSourcesOrganization(root);
    expect(read.collections).toEqual([]);
    expect(read.issue).toContain("could not be read");
    await expect(
      createScientSourceCollection({ root, name: "Methods", actor: "user" }),
    ).rejects.toThrow();
    expect(await NodeFSP.readFile(filePath, "utf8")).toBe("{ not json");
  });

  it("bulk edits tags, type and collections, crediting a revision to the actor per source", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const collection = await organizeScientSources({
      root,
      change: { action: "create-collection", name: "Methods" },
      actor: "user",
    });
    const collectionId = collection.collection?.collectionId ?? "";

    const result = await bulkUpdateScientSources({
      root,
      change: {
        sourceIds: [first, second, "source_missing"],
        addTags: ["RCT", "sepsis"],
        type: "preprint",
        addToCollectionIds: [collectionId],
      },
      actor: "agent",
    });

    expect(result.sources.map((entry) => [entry.sourceId, entry.outcome, entry.revision])).toEqual([
      [first, "updated", 2],
      [second, "updated", 2],
      ["source_missing", "not-found", null],
    ]);
    expect(result.collections).toEqual([{ collectionId, outcome: "updated" }]);
    const updated = await readScientSourceRecord(root, first);
    expect(updated).toMatchObject({
      tags: ["RCT", "sepsis"],
      type: "preprint",
      updatedBy: "agent",
    });
    const organization = await readScientSourcesOrganization(root);
    expect(organization.collections[0]?.sourceIds).toEqual([first, second]);

    const removal = await bulkUpdateScientSources({
      root,
      change: { sourceIds: [first], removeTags: ["rct"], removeFromCollectionIds: [collectionId] },
      actor: "user",
    });
    expect(removal.sources[0]).toMatchObject({ outcome: "updated", revision: 3 });
    expect((await readScientSourceRecord(root, first))?.tags).toEqual(["sepsis"]);
    const repeat = await bulkUpdateScientSources({
      root,
      change: { sourceIds: [first], removeTags: ["rct"] },
      actor: "user",
    });
    expect(repeat.sources[0]).toMatchObject({ outcome: "unchanged", revision: 3 });
  });

  it("reports a bulk type change that a source cannot take instead of stopping", async () => {
    const { root, sourceIds } = await project(["First"]);
    const result = await bulkUpdateScientSources({
      root,
      change: { sourceIds, type: "other" },
      actor: "user",
    });
    expect(result.sources[0]).toMatchObject({
      outcome: "failed",
      message: "Enter the source type.",
    });
  });
  it("undoes a whole bulk edit, keeping a later change and reporting it", async () => {
    const { root, sourceIds } = await project(["First", "Second", "Third"]);
    const [first, second, third] = sourceIds as [string, string, string];
    const edit = async (
      sourceId: string,
      fields: { readonly type?: ScientSourceType; readonly tags?: ReadonlyArray<string> },
    ) => {
      const record = await readScientSourceRecord(root, sourceId);
      if (!record) throw new Error("Expected a source.");
      await updateScientSourceMetadata({
        root,
        sourceId,
        expectedRevision: record.revision,
        metadata: { ...editableMetadataFromRecord(record), ...fields },
        actor: "user",
      });
    };
    await edit(first, { tags: ["RCT", "Adults"] });
    await edit(second, { type: "book" });
    await edit(third, { tags: ["Pilot", "RCT"] });
    const collection = async (name: string, members: ReadonlyArray<string>) =>
      (await createScientSourceCollection({ root, name, sourceIds: members, actor: "user" }))
        .collection?.collectionId ?? "";
    const kept = await collection("Kept", [first, third]);
    const reading = await collection("Reading", [second]);
    const members = async () =>
      Object.fromEntries(
        (await readScientSourcesOrganization(root)).collections.map((entry) => [
          entry.name,
          entry.sourceIds.toSorted(),
        ]),
      );
    const fields = async (sourceId: string) => {
      const record = await readScientSourceRecord(root, sourceId);
      return [record?.type, record?.tags];
    };

    const bulk = await bulkUpdateScientSources({
      root,
      change: {
        sourceIds,
        addTags: ["Screened"],
        removeTags: ["rct"],
        type: "report",
        addToCollectionIds: [reading],
        removeFromCollectionIds: [kept],
      },
      actor: "user",
    });
    expect(bulk.undo?.sourceCount).toBe(3);
    await edit(third, { type: "thesis", tags: ["Pilot", "Screened", "Later"] });

    const undone = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "agent",
    });
    expect(await fields(first)).toEqual(["article", ["RCT", "Adults"]]);
    expect(await fields(second)).toEqual(["book", []]);
    expect(await fields(third)).toEqual(["thesis", ["Pilot", "Later", "RCT"]]);
    expect((await readScientSourceRecord(root, first))?.updatedBy).toBe("agent");
    expect(await members()).toEqual({
      Kept: [first, third].toSorted(),
      Reading: [second],
    });
    expect(undone.conflicts).toEqual([
      {
        sourceId: third,
        message: "Its type was changed after the bulk edit, so the newer type was kept.",
      },
    ]);
    const again = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "agent",
    });
    expect(again.conflicts).toEqual([{ message: "This bulk edit was already undone." }]);
  });
});
