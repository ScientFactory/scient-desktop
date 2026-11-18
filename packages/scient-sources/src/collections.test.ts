// @effect-diagnostics nodeBuiltinImport:off -- Collection tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  bulkUpdateScientSources,
  changeScientSourceCollectionMembers,
  createScientSourceCollection,
  deleteScientSourceCollection,
  deleteScientSourceSearch,
  listScientSourcesBulkEdits,
  organizeScientSources,
  placeScientSourceCollections,
  readScientSourcesOrganization,
  renameScientSourceCollection,
  restoreScientSourceCollection,
  saveScientSourceSearch,
  SCIENT_SOURCE_COLLECTIONS_FILE,
  scientBulkEditChangedType,
} from "./collections.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import type { ScientSourceCandidate, ScientSourceType } from "./model.ts";
import {
  importScientSource,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

const fixtures: string[] = [];
const originalRename = NodeFS.promises.rename;
const originalReadFile = NodeFS.promises.readFile;

/** Fails the next bulk edit receipt write once `when` holds, as a full disk or a lock would. */
function failNextReceiptWrite(when: () => Promise<boolean>): void {
  NodeFS.promises.rename = async (from, to) => {
    if (String(to).includes("bulk-edits") && (await when())) {
      NodeFS.promises.rename = originalRename;
      NodeModule.syncBuiltinESMExports();
      throw new Error("Injected receipt write failure.");
    }
    return originalRename(from, to);
  };
  NodeModule.syncBuiltinESMExports();
}

/** Counts record file reads and bulk edit receipt writes until the returned function is called. */
function countStoreTraffic(): () => {
  readonly recordReads: number;
  readonly receiptWrites: number;
} {
  const counts = { recordReads: 0, receiptWrites: 0 };
  NodeFS.promises.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
    if (String(args[0]).includes(`${NodePath.sep}records${NodePath.sep}`)) counts.recordReads += 1;
    return originalReadFile(...args);
  }) as typeof originalReadFile;
  NodeFS.promises.rename = async (from, to) => {
    if (String(to).includes("bulk-edits")) counts.receiptWrites += 1;
    return originalRename(from, to);
  };
  NodeModule.syncBuiltinESMExports();
  return () => {
    NodeFS.promises.readFile = originalReadFile;
    NodeFS.promises.rename = originalRename;
    NodeModule.syncBuiltinESMExports();
    return counts;
  };
}

afterEach(async () => {
  vi.useRealTimers();
  NodeFS.promises.readFile = originalReadFile;
  NodeFS.promises.rename = originalRename;
  NodeModule.syncBuiltinESMExports();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function candidate(sourceKey: string, title: string): ScientSourceCandidate {
  return sourceCandidate({
    sourceKey,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
    containerTitle: "Journal",
  });
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

  it("nests ten levels deep and never puts a collection inside itself", async () => {
    const { root } = await project([]);
    const create = (name: string, parentCollectionId?: string) =>
      createScientSourceCollection({
        root,
        name,
        ...(parentCollectionId ? { parentCollectionId } : {}),
        actor: "user",
      });
    const id = (change: Awaited<ReturnType<typeof create>>) => change.collection!.collectionId;
    const move = (collectionId: string, parentCollectionId: string | null) =>
      organizeScientSources({
        root,
        change: { action: "move-collection", collectionId, parentCollectionId },
        actor: "agent",
      });
    const parentOf = async (collectionId: string) =>
      (await readScientSourcesOrganization(root)).collections.find(
        (entry) => entry.collectionId === collectionId,
      )?.parentCollectionId;
    const chain = [id(await create("Level 1"))];
    for (let level = 2; level <= 10; level += 1) {
      chain.push(id(await create(`Level ${level}`, chain.at(-1))));
    }
    const [top, second, third] = chain as [string, string, string];

    expect((await create("Level 11", chain.at(-1))).outcome).toBe("too-deep");
    expect((await move(top, third)).outcome).toBe("too-deep");
    // Two levels (Review with Methods under it) do not fit under the ninth.
    const review = id(await create("Review"));
    const methods = id(await create("Methods", review));
    expect((await move(review, chain[8]!)).outcome).toBe("too-deep");
    expect((await move(review, chain[7]!)).outcome).toBe("updated");
    expect(await parentOf(methods)).toBe(review);

    // Two parents can each have a "Methods"; one parent cannot be given a second by hand.
    expect((await create("Methods", top)).outcome).toBe("created");
    expect((await move(methods, top)).outcome).toBe("name-taken");

    // Deleting a collection moves what is under it one level up; restoring puts it back.
    await deleteScientSourceCollection({ root, collectionId: second, actor: "user" });
    expect(await parentOf(third)).toBe(top);
    // A sibling that took the name meanwhile does not stop the Undo.
    await create("Level 2", top);
    expect(
      (await restoreScientSourceCollection({ root, collectionId: second, actor: "user" })).outcome,
    ).toBe("restored");
    expect(await parentOf(third)).toBe(second);
  });

  it("keeps a collection under the one above when a deleted one between them is dropped for good", async () => {
    const { root } = await project([]);
    const create = async (name: string, parentCollectionId?: string) =>
      (
        await createScientSourceCollection({
          root,
          name,
          ...(parentCollectionId ? { parentCollectionId } : {}),
          actor: "user",
        })
      ).collection!.collectionId;
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.parse("2026-11-15T10:00:00.000Z");
    vi.setSystemTime(clock);
    const thesis = await create("Thesis");
    const methods = await create("Methods", thesis);
    const figures = await create("Figures", methods);
    await deleteScientSourceCollection({ root, collectionId: methods, actor: "user" });
    // Only the 50 newest deleted collections are kept.
    for (let index = 0; index < 50; index += 1) {
      vi.setSystemTime((clock += 1000));
      const collectionId = await create(`Scratch ${index}`);
      await deleteScientSourceCollection({ root, collectionId, actor: "user" });
    }

    expect(
      (await restoreScientSourceCollection({ root, collectionId: methods, actor: "user" })).outcome,
    ).toBe("not-found");
    const organization = await readScientSourcesOrganization(root);
    expect(
      organization.collections.find((entry) => entry.collectionId === figures)?.parentCollectionId,
    ).toBe(thesis);
  });

  it("places a tree from elsewhere: same-named siblings stay two, and a deleted one is never taken over", async () => {
    const { root } = await project([]);
    const byHand = await createScientSourceCollection({ root, name: "Thesis", actor: "user" });
    const node = (collectionId: string, name: string, parentCollectionId?: string) => ({
      collectionId,
      name,
      ...(parentCollectionId ? { parentCollectionId } : {}),
    });
    const tree = [
      node("collection_a", "Thesis"),
      node("collection_b", "thesis"),
      node("collection_c", "Chapter 2", "collection_b"),
      node("collection_d", "x".repeat(201)),
      node("collection_e", "Chapter 3", "collection_b"),
    ];
    const place = (wanted: ReadonlyArray<string>, remake = false) =>
      placeScientSourceCollections({ root, tree, wanted, remake, actor: "user" });
    const shape = async () =>
      new Map(
        (await readScientSourcesOrganization(root)).collections.map((entry) => [
          entry.collectionId,
          [entry.name, entry.parentCollectionId ?? null],
        ]),
      );

    // Only the second twin is wanted: the collection made by hand is still the first one's.
    const first = await place(["collection_c", "collection_d"]);
    expect(first.get("collection_b")).toMatchObject({ created: true });
    expect(first.get("collection_d")).toEqual({
      collection: null,
      why: "Its name is longer than 200 characters.",
    });
    expect((await place(["collection_a"])).get("collection_a")).toEqual({
      collection: { ...byHand.collection, outsideIds: ["collection_a"] },
      created: false,
    });
    const placed = new Map([
      [byHand.collection!.collectionId, ["Thesis", null]],
      ["collection_b", ["thesis", null]],
      ["collection_c", ["Chapter 2", "collection_b"]],
    ]);
    expect(await shape()).toEqual(placed);

    await deleteScientSourceCollection({ root, collectionId: "collection_b", actor: "user" });
    // Not made again unasked; a new one under it goes under it, as Chapter 2 is.
    const again = await place(["collection_b", "collection_e"]);
    expect(again.has("collection_b")).toBe(false);
    expect(again.get("collection_e")?.collection?.parentCollectionId).toBe("collection_b");
    const remade = (await place(["collection_b"], true)).get("collection_b")?.collection;
    expect(remade?.collectionId).not.toBe("collection_b");
    // The deleted one still comes back with what is under it.
    await restoreScientSourceCollection({ root, collectionId: "collection_b", actor: "user" });
    expect(await shape()).toEqual(
      new Map([
        ...placed,
        ["collection_e", ["Chapter 3", "collection_b"]],
        [remade!.collectionId, ["thesis", null]],
      ]),
    );
  });

  it("finds a collection again after a rename or a move, when it was found by name or made beside a deleted one", async () => {
    const { root } = await project([]);
    const byHand = await createScientSourceCollection({ root, name: "Thesis", actor: "user" });
    const tree = [
      { collectionId: "collection_a", name: "Thesis" },
      { collectionId: "collection_b", name: "Teaching" },
    ];
    const place = async (collectionId: string) =>
      (
        await placeScientSourceCollections({
          root,
          tree,
          wanted: [collectionId],
          remake: true,
          actor: "user",
        })
      ).get(collectionId);
    const names = async () =>
      (await readScientSourcesOrganization(root)).collections.map((entry) => entry.name).toSorted();

    // Found by name, then renamed here: the next import finds it, it does not make another.
    expect(await place("collection_a")).toMatchObject({
      collection: { collectionId: byHand.collection!.collectionId },
      created: false,
    });
    await renameScientSourceCollection({
      root,
      collectionId: byHand.collection!.collectionId,
      name: "Doctorate",
      actor: "user",
    });
    expect((await place("collection_a"))?.collection?.collectionId).toBe(
      byHand.collection!.collectionId,
    );

    // Made beside a deleted one, then moved under another collection here: found the same way.
    await place("collection_b");
    await deleteScientSourceCollection({ root, collectionId: "collection_b", actor: "user" });
    const remade = (await place("collection_b"))?.collection?.collectionId;
    await organizeScientSources({
      root,
      change: {
        action: "move-collection",
        collectionId: remade!,
        parentCollectionId: byHand.collection!.collectionId,
      },
      actor: "user",
    });
    expect((await place("collection_b"))?.collection?.collectionId).toBe(remade);
    expect(await names()).toEqual(["Doctorate", "Teaching"]);
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

  it("bulk tags many sources reading the store once and saving Undo a fixed number of times", async () => {
    const { root, sourceIds } = await project(["A", "B", "C", "D", "E", "F", "G", "H"]);
    const edited = sourceIds.slice(0, 6);
    const stop = countStoreTraffic();
    const result = await bulkUpdateScientSources({
      root,
      change: { sourceIds: edited, addTags: ["Screened"] },
      actor: "user",
    });
    const counts = stop();
    expect(result.undo?.sourceCount).toBe(6);
    // Each edited record is read before and while it is written; the other records once.
    expect(counts.recordReads).toBeLessThanOrEqual(sourceIds.length + 2 * edited.length);
    // The empty receipt, every write planned, every write finished.
    expect(counts.receiptWrites).toBe(3);

    const undoStop = countStoreTraffic();
    await bulkUpdateScientSources({
      root,
      change: { undoBatchId: result.undo?.batchId ?? "" },
      actor: "user",
    });
    const undoCounts = undoStop();
    expect(undoCounts.recordReads).toBeLessThanOrEqual(sourceIds.length + 3 * edited.length);
    // Every restore planned, every one done.
    expect(undoCounts.receiptWrites).toBe(2);
    expect((await readScientSourceRecord(root, edited[0] ?? ""))?.tags).toEqual([]);
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

    // Whether Undo has pin and review snapshots to refresh.
    expect(await scientBulkEditChangedType(root, bulk.undo?.batchId ?? "")).toBe(true);
    const tagsOnly = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addTags: ["Second look"] },
      actor: "user",
    });
    expect(await scientBulkEditChangedType(root, tagsOnly.undo?.batchId ?? "")).toBe(false);
  });
  it("lists past bulk edits: one sent in parts as one, and what a partial Undo left", async () => {
    const { root, sourceIds } = await project(["First", "Second", "Third"]);
    const [first, second, third] = sourceIds as [string, string, string];
    const tag = (ids: ReadonlyArray<string>, partNumber?: number) =>
      bulkUpdateScientSources({
        root,
        change: { sourceIds: [...ids], addTags: ["Screened"] },
        actor: "agent",
        ...(partNumber ? { partOf: "edit_tags", partNumber } : {}),
      });
    // The list is ordered by time: a clock set after the fixture moves a second per request.
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.UTC(2100, 0, 1);
    const later = () => vi.setSystemTime((clock += 1000));
    const firstPart = await tag([first, second], 1);
    later();
    await tag([third], 2);
    // Changes nothing, so it is not an edit to list.
    later();
    await tag([first]);
    later();
    const retyped = await bulkUpdateScientSources({
      root,
      change: { sourceIds: [first, second], type: "report" },
      actor: "user",
    });

    const listed = await listScientSourcesBulkEdits(root, 10);
    expect(listed).toMatchObject([
      { id: retyped.undo?.batchId, by: "user", typeChanged: 2, tagsAdded: [], undone: false },
      {
        by: "agent",
        tagsAdded: ["Screened"],
        typeChanged: 0,
        parts: [
          { sourceCount: 2, undone: false },
          { sourceCount: 1, undone: false },
        ],
        partsMissing: false,
        undone: false,
        left: 0,
      },
    ]);
    expect(listed[1]?.sourceIds.toSorted()).toEqual([first, second, third].toSorted());
    expect(await listScientSourcesBulkEdits(root, 1)).toHaveLength(1);

    // A later change to one source is kept by Undo, and the list remembers that it was.
    const record = await readScientSourceRecord(root, first);
    await updateScientSourceMetadata({
      root,
      sourceId: first,
      expectedRevision: record!.revision,
      metadata: { ...editableMetadataFromRecord(record!), type: "thesis" },
      actor: "user",
    });
    const undone = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: retyped.undo?.batchId ?? "" },
      actor: "user",
    });
    expect(undone.conflicts).toHaveLength(1);
    expect((await listScientSourcesBulkEdits(root, 10))[0]).toMatchObject({
      id: retyped.undo?.batchId,
      undone: true,
      left: 1,
    });

    // The edit's first request is gone, as after 250 newer ones: the row is the rest of it.
    await NodeFSP.rm(
      NodePath.join(root, ".scient", "sources", "bulk-edits", `${firstPart.undo?.batchId}.json`),
    );
    expect((await listScientSourcesBulkEdits(root, 10))[1]).toMatchObject({
      parts: [{ sourceCount: 1 }],
      partsMissing: true,
    });
  });
  it("leaves a tag alone when the paper's tag was changed after the bulk edit", async () => {
    const { root, sourceIds } = await project(["First", "Second", "Third"]);
    const [first, second, third] = sourceIds as [string, string, string];
    const setTags = async (sourceId: string, tags: ReadonlyArray<string>) => {
      const record = await readScientSourceRecord(root, sourceId);
      await updateScientSourceMetadata({
        root,
        sourceId,
        expectedRevision: record!.revision,
        metadata: { ...editableMetadataFromRecord(record!), tags: [...tags] },
        actor: "user",
      });
    };
    const tags = async (sourceId: string) => (await readScientSourceRecord(root, sourceId))?.tags;
    const bulk = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addTags: ["RCT"] },
      actor: "user",
    });
    // First: the tag was taken off and deliberately put back. Second: another tag was added.
    await setTags(first, []);
    await setTags(first, ["RCT"]);
    await setTags(second, ["RCT", "Later"]);

    const undone = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "user",
    });
    expect(await tags(first)).toEqual(["RCT"]);
    expect(await tags(second)).toEqual(["Later"]);
    expect(await tags(third)).toEqual([]);
    expect(undone.conflicts).toEqual([
      {
        sourceId: first,
        message:
          "Tags were added to it or removed from it after the bulk edit, so those tags were kept.",
      },
    ]);
    expect((await listScientSourcesBulkEdits(root, 10))[0]).toMatchObject({
      undone: true,
      left: 1,
    });
  });
  it("leaves a type that was changed away and back after the bulk edit", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const setType = async (sourceId: string, type: ScientSourceType) => {
      const record = await readScientSourceRecord(root, sourceId);
      await updateScientSourceMetadata({
        root,
        sourceId,
        expectedRevision: record!.revision,
        metadata: { ...editableMetadataFromRecord(record!), type },
        actor: "user",
      });
    };
    const type = async (sourceId: string) => (await readScientSourceRecord(root, sourceId))?.type;
    const bulk = await bulkUpdateScientSources({
      root,
      change: { sourceIds, type: "report" },
      actor: "user",
    });
    await setType(first, "book");
    await setType(first, "report");

    const undone = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "user",
    });
    expect(await type(first)).toBe("report");
    expect(await type(second)).toBe("article");
    expect(undone.conflicts).toEqual([
      {
        sourceId: first,
        message: "Its type was changed after the bulk edit, so the newer type was kept.",
      },
    ]);
  });
  // regression: review U1-b-1, the retry found the restore done and forgot what it had kept.
  it("remembers what an Undo kept when it stopped before marking the source done", async () => {
    const { root, sourceIds } = await project(["First"]);
    const first = sourceIds[0] ?? "";
    const edit = async (fields: {
      readonly type?: ScientSourceType;
      readonly tags?: ReadonlyArray<string>;
    }) => {
      const record = await readScientSourceRecord(root, first);
      await updateScientSourceMetadata({
        root,
        sourceId: first,
        expectedRevision: record!.revision,
        metadata: { ...editableMetadataFromRecord(record!), ...fields },
        actor: "user",
      });
    };
    const now = async () => {
      const record = await readScientSourceRecord(root, first);
      return [record?.type, record?.tags];
    };
    const bulk = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addTags: ["RCT"], type: "report" },
      actor: "user",
    });
    await edit({ tags: [] });
    await edit({ tags: ["RCT"] });
    const undo = () =>
      bulkUpdateScientSources({
        root,
        change: { undoBatchId: bulk.undo?.batchId ?? "" },
        actor: "user",
      });

    // The type is put back and the tag kept; the write that marks the source done fails.
    failNextReceiptWrite(async () => (await now())[0] === "article");
    await undo().catch(() => undefined);
    expect(await now()).toEqual(["article", ["RCT"]]);
    await undo();
    expect((await listScientSourcesBulkEdits(root, 10))[0]).toMatchObject({
      undone: true,
      left: 1,
    });
  });
  // regression: review U1-c-1, Undo judged a source on versions read before a later edit landed.
  it("keeps the edit's values on a source that was edited while Undo was reading its versions", async () => {
    const { root, sourceIds } = await project(["First"]);
    const first = sourceIds[0] ?? "";
    const edit = async (fields: {
      readonly type?: ScientSourceType;
      readonly tags?: ReadonlyArray<string>;
    }) => {
      const record = await readScientSourceRecord(root, first);
      await updateScientSourceMetadata({
        root,
        sourceId: first,
        expectedRevision: record!.revision,
        metadata: { ...editableMetadataFromRecord(record!), ...fields },
        actor: "user",
      });
    };
    const bulk = await bulkUpdateScientSources({
      root,
      change: { sourceIds, type: "report" },
      actor: "user",
    });
    // Two unrelated edits, so Undo has a version in between to read.
    await edit({ tags: ["One"] });
    await edit({ tags: ["One", "Two"] });
    // While Undo reads that version, the type is changed away and back.
    let landed = false;
    NodeFS.promises.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
      if (!landed && String(args[0]).includes(`${NodePath.sep}history${NodePath.sep}`)) {
        landed = true;
        NodeFS.promises.readFile = originalReadFile;
        NodeModule.syncBuiltinESMExports();
        await edit({ type: "book" });
        await edit({ type: "report" });
      }
      return originalReadFile(...args);
    }) as typeof originalReadFile;
    NodeModule.syncBuiltinESMExports();

    const undone = await bulkUpdateScientSources({
      root,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "user",
    });
    expect(landed).toBe(true);
    expect((await readScientSourceRecord(root, first))?.type).toBe("report");
    expect(undone.conflicts?.map((conflict) => conflict.sourceId)).toEqual([first]);
  });
  it("does not call an edit incomplete because its first request changed nothing", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const tag = (sourceId: string, partNumber: number) =>
      bulkUpdateScientSources({
        root,
        change: {
          sourceIds: [sourceId],
          removeTags: ["Absent"],
          ...(partNumber === 2 ? { addTags: ["RCT"] } : {}),
        },
        actor: "user",
        partOf: "edit_one",
        partNumber,
      });
    await tag(first, 1);
    await tag(second, 2);
    expect(await listScientSourcesBulkEdits(root, 10)).toMatchObject([
      { sourceIds: [second], parts: [{ sourceCount: 1 }], partsMissing: false },
    ]);
  });
  it("changes nothing when the bulk edit receipt folder is unsafe", async () => {
    const { root, sourceIds } = await project(["First"]);
    const collectionId =
      (await createScientSourceCollection({ root, name: "Methods", actor: "user" })).collection
        ?.collectionId ?? "";
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bulk-outside-"));
    fixtures.push(outside);
    await NodeFSP.symlink(outside, NodePath.join(root, ".scient/sources/bulk-edits"));

    await expect(
      bulkUpdateScientSources({
        root,
        change: { sourceIds, addTags: ["Bulk"], addToCollectionIds: [collectionId] },
        actor: "user",
      }),
    ).rejects.toThrow("bulk-edits");
    expect((await readScientSourceRecord(root, sourceIds[0] ?? ""))?.tags).toEqual([]);
    expect((await readScientSourcesOrganization(root)).collections[0]?.sourceIds).toEqual([]);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("retries a bulk undo that failed part way, leaving what it already restored", async () => {
    const { root, sourceIds } = await project(["First", "Second"]);
    const [first, second] = sourceIds as [string, string];
    const bulk = await bulkUpdateScientSources({
      root,
      change: { sourceIds, type: "book" },
      actor: "user",
    });
    const history = NodePath.join(root, ".scient/sources/history", second);
    await NodeFSP.rename(history, `${history}-aside`);
    await NodeFSP.writeFile(history, "");
    const undo = () =>
      bulkUpdateScientSources({
        root,
        change: { undoBatchId: bulk.undo?.batchId ?? "" },
        actor: "user",
      });

    const failed = await undo();
    expect(failed.sources.map((entry) => [entry.sourceId, entry.outcome])).toEqual([
      [first, "updated"],
      [second, "failed"],
    ]);
    const record = await readScientSourceRecord(root, first);
    if (!record) throw new Error("Expected a source.");
    await updateScientSourceMetadata({
      root,
      sourceId: first,
      expectedRevision: record.revision,
      metadata: { ...editableMetadataFromRecord(record), type: "thesis" },
      actor: "user",
    });
    await NodeFSP.rm(history);
    await NodeFSP.rename(`${history}-aside`, history);

    const retried = await undo();
    expect(retried.sources.map((entry) => [entry.sourceId, entry.outcome])).toEqual([
      [second, "updated"],
    ]);
    expect((await readScientSourceRecord(root, first))?.type).toBe("thesis");
    expect((await readScientSourceRecord(root, second))?.type).toBe("article");
    expect((await undo()).conflicts).toEqual([{ message: "This bulk edit was already undone." }]);
  });

  it("keeps Undo for a change whose receipt could not be finished", async () => {
    const { root, sourceIds } = await project(["First"]);
    const first = sourceIds[0] ?? "";
    const collectionId =
      (await createScientSourceCollection({ root, name: "Methods", actor: "user" })).collection
        ?.collectionId ?? "";
    const tags = async () => (await readScientSourceRecord(root, first))?.tags ?? [];
    const members = async () =>
      (await readScientSourcesOrganization(root)).collections[0]?.sourceIds ?? [];
    const undo = (batchId: string | undefined) =>
      bulkUpdateScientSources({ root, change: { undoBatchId: batchId ?? "" }, actor: "user" });

    failNextReceiptWrite(async () => (await tags()).includes("Bulk"));
    const tagged = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addTags: ["Bulk"] },
      actor: "user",
    });
    expect(await tags()).toEqual(["Bulk"]);
    await undo(tagged.undo?.batchId);
    expect(await tags()).toEqual([]);

    failNextReceiptWrite(async () => (await members()).includes(first));
    const added = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addToCollectionIds: [collectionId] },
      actor: "user",
    });
    expect(await members()).toEqual([first]);
    await undo(added.undo?.batchId);
    expect(await members()).toEqual([]);
  });

  it("keeps a later edit when an Undo that landed is retried", async () => {
    const { root, sourceIds } = await project(["First"]);
    const first = sourceIds[0] ?? "";
    const collectionId =
      (await createScientSourceCollection({ root, name: "Methods", actor: "user" })).collection
        ?.collectionId ?? "";
    const tags = async () => (await readScientSourceRecord(root, first))?.tags ?? [];
    const members = async () =>
      (await readScientSourcesOrganization(root)).collections[0]?.sourceIds ?? [];
    const undo = (batchId: string | undefined) =>
      bulkUpdateScientSources({ root, change: { undoBatchId: batchId ?? "" }, actor: "user" });

    const tagged = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addTags: ["Bulk"] },
      actor: "user",
    });
    failNextReceiptWrite(async () => !(await tags()).includes("Bulk"));
    await undo(tagged.undo?.batchId).catch(() => undefined);
    const record = await readScientSourceRecord(root, first);
    if (!record) throw new Error("Expected a source.");
    await updateScientSourceMetadata({
      root,
      sourceId: first,
      expectedRevision: record.revision,
      metadata: { ...editableMetadataFromRecord(record), tags: ["Bulk", "Later"] },
      actor: "user",
    });
    const retried = await undo(tagged.undo?.batchId);
    expect(await tags()).toEqual(["Bulk", "Later"]);
    expect(retried.conflicts?.map((conflict) => conflict.sourceId)).toEqual([first]);

    const added = await bulkUpdateScientSources({
      root,
      change: { sourceIds, addToCollectionIds: [collectionId] },
      actor: "user",
    });
    failNextReceiptWrite(async () => !(await members()).includes(first));
    await undo(added.undo?.batchId).catch(() => undefined);
    await changeScientSourceCollectionMembers({ root, collectionId, add: [first], actor: "user" });
    const again = await undo(added.undo?.batchId);
    expect(await members()).toEqual([first]);
    expect(again.conflicts?.map((conflict) => conflict.collectionId)).toEqual([collectionId]);
  });
});
