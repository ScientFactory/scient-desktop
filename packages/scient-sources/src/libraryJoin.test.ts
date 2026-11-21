// @effect-diagnostics nodeBuiltinImport:off -- Joins real Libraries in temporary folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  changeScientSourceCollectionMembers,
  createScientSourceCollection,
  placeScientSourceCollections,
  readScientSourcesOrganization,
  renameScientSourceCollection,
} from "./collections.ts";
import { backUpScientLibrary, scientLibraryBackupLeavesOut } from "./libraryBackup.ts";
import {
  compareScientLibraries,
  joinScientLibrary,
  listScientLibraryJoins,
  openScientLibraryJoinSource,
  readScientLibraryJoinDifferences,
  takeFromScientLibraryJoin,
  undoScientLibraryJoin,
} from "./libraryJoin.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import { readScientLibraryDistinctPairs } from "./libraryExclusions.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { withScientFileLock } from "./libraryLock.ts";
import { finishScientLibraryRestore, prepareScientLibraryRestore } from "./libraryRestore.ts";
import { pinScientLibrarySource } from "./projectPins.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  detachScientSourcePdf,
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  removeScientSource,
  setScientLibraryReadingState,
  updateScientSourceMetadata,
  updateScientSourceNote,
  writeScientSourceZoteroSync,
} from "./store.ts";
import {
  applyStep,
  EMPTY_MODEL,
  initialTitle,
  workOf,
  type Model,
  type Step,
} from "./testing/libraryModel.ts";
import { checkLibraryRules } from "./testing/libraryRules.ts";
import { createScenario, libraryOf, runStep, type Scenario } from "./testing/librarySteps.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function newScenario(): Promise<Scenario> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-join-")),
  );
  roots.push(root);
  return createScenario(root);
}

/** A Library after these steps, with the expectation the rule checker compares it with. */
async function built(steps: ReadonlyArray<Step>) {
  const scenario = await newScenario();
  let model = EMPTY_MODEL;
  for (const step of steps) model = applyStep(model, step, await runStep(scenario, model, step));
  return { scenario, model, library: libraryOf(scenario) };
}

async function further(scenario: Scenario, model: Model, steps: ReadonlyArray<Step>) {
  let next = model;
  for (const step of steps) next = applyStep(next, step, await runStep(scenario, next, step));
  return next;
}

async function backUp(scenario: Scenario): Promise<string> {
  const destination = NodePath.join(scenario.root, "backups");
  await NodeFSP.mkdir(destination, { recursive: true });
  const result = await backUpScientLibrary({ library: libraryOf(scenario), destination });
  if (result.outcome !== "backed-up") throw new Error(`Not backed up: ${result.outcome}`);
  return result.path;
}

async function joinedCollection() {
  const theirs = await built([{ op: "add", label: "arrived", pdf: false }]);
  const sourceId = workOf(theirs.model, "arrived").sourceId;
  await createScientSourceCollection({
    root: theirs.library,
    name: "Joined collection",
    sourceIds: [sourceId],
    actor: "user",
  });
  const ours = await built([{ op: "add", label: "mine", pdf: false }]);
  const joined = await joinScientLibrary({
    library: ours.library,
    folder: await backUp(theirs.scenario),
    actor: "user",
  });
  if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
  const collection = (await readScientSourcesOrganization(ours.library)).collections.find(
    (entry) => entry.name === "Joined collection",
  )!;
  return { ...ours, joinId: joined.joinId, sourceId, collectionId: collection.collectionId };
}

/** Every file the Library keeps, with its hash, apart from the joins' own records. */
async function inventory(folder: string): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = NodePath.join(entry.parentPath, entry.name);
    const path = NodePath.relative(folder, absolute).split(NodePath.sep).join("/");
    if (scientLibraryBackupLeavesOut(path) || path.startsWith("joins/")) continue;
    found.set(
      path,
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(absolute))
        .digest("hex"),
    );
  }
  return found;
}

/** The files of `after` that `before` lacks or holds differently. */
function changedSince(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  return [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path);
}

type Row = NonNullable<
  Awaited<ReturnType<typeof readScientLibraryJoinDifferences>>
>["rows"][number];

/** What a row showed, as a request to take something from it says it. */
const shownOf = (row: Row) => ({
  here: row.here?.fingerprint ?? null,
  other: row.other!.fingerprint,
  relation: row.relation,
  candidates: row.candidates.map((candidate) => candidate.sourceId),
});

const ids = async (scenario: Scenario) =>
  (await listScientSourceRecords(libraryOf(scenario))).map((record) => record.sourceId).toSorted();

describe("adding what another Library holds", () => {
  it("adds a new source whole and changes nothing that was here", async () => {
    const theirs = await built([
      { op: "add", label: "n1", pdf: true },
      { op: "add", label: "n2", pdf: false },
      { op: "editTitle", work: "n1", title: "A retitled new study" },
      { op: "setNote", work: "n1", note: "Their note on n1." },
    ]);
    const n1 = workOf(theirs.model, "n1").sourceId;
    const n2 = workOf(theirs.model, "n2").sourceId;
    await setScientLibraryReadingState({
      library: theirs.library,
      sourceIds: [n1],
      readingStatus: "read",
      starred: true,
    });
    await createScientSourceCollection({
      root: theirs.library,
      name: "Thesis",
      sourceIds: [n1, n2],
      actor: "user",
    });
    const pdf = workOf(theirs.model, "n1").pdfs[0]!.sha256;
    const highlights = NodePath.join(theirs.scenario.libraryRoot, "annotations", "v1");
    await NodeFSP.mkdir(highlights, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(highlights, `${pdf}.json`), '{"highlights":1}\n');
    // What n1 took from Zotero and left, as an import from Zotero keeps it.
    await writeScientSourceZoteroSync(theirs.library, {
      formatVersion: 1,
      sourceId: n1,
      libraryId: "475425",
      itemKey: "ABCD2345",
      itemVersion: 3,
      syncedAt: "2026-11-21T08:00:00.000Z",
      metadata: editableMetadataFromRecord((await readScientSourceRecord(theirs.library, n1))!),
      note: null,
      attachmentKeys: ["PDFA2345", "LEFT2345"],
    });
    const backup = await backUp(theirs.scenario);

    const ours = await built([
      { op: "add", label: "o1", pdf: true },
      { op: "setNote", work: "o1", note: "Our note." },
    ]);
    const before = await inventory(ours.scenario.libraryRoot);
    const progress: number[] = [];
    const result = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
      onProgress: ({ done }) => progress.push(done),
    });
    expect(result).toMatchObject({ outcome: "joined", added: 2, skipped: 0, different: 0 });
    expect(progress).toEqual([1, 2]);

    // Nothing that was here changed; what is new is the two sources' own files.
    const after = await inventory(ours.scenario.libraryRoot);
    for (const [path, hash] of before) expect(after.get(path)).toBe(hash);
    const brought = changedSince(before, after);
    expect(brought).toEqual(
      expect.arrayContaining([
        `records/${n1}.json`,
        `records/${n2}.json`,
        `history/${n1}/1.json`,
        `zotero/${n1}.json`,
        `annotations/v1/${pdf}.json`,
        `files/sha256/${pdf.slice(0, 2)}/${pdf}.pdf`,
      ]),
    );
    // The source is as the other Library has it: the record file itself, byte for byte.
    for (const path of [`records/${n1}.json`, `history/${n1}/1.json`, `zotero/${n1}.json`]) {
      expect(await NodeFSP.readFile(NodePath.join(ours.scenario.libraryRoot, path))).toEqual(
        await NodeFSP.readFile(NodePath.join(theirs.scenario.libraryRoot, path)),
      );
    }
    const record = await readScientSourceRecord(ours.library, n1);
    expect(record).toMatchObject({ title: "A retitled new study", note: "Their note on n1." });
    expect(record).toMatchObject({ readingStatus: "read", starred: true });
    // And it is where the other Library had it.
    const collection = (await readScientSourcesOrganization(ours.library)).collections.find(
      (entry) => entry.name === "Thesis",
    );
    expect(collection?.sourceIds.toSorted()).toEqual([n1, n2].toSorted());

    // The Library's own rules still hold for what was here.
    expect((await checkLibraryRules(ours.scenario, [ours.model])).violations).toEqual(
      // The checker knows nothing of the two sources a join brought.
      expect.not.arrayContaining([expect.stringContaining("o1")]),
    );
    // Joining the same backup again finds nothing new.
    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 0, identical: 2 });
  });

  it("continues a join that stopped and never brings back what was removed or changed since", async () => {
    const theirs = await built(
      ["a", "b", "c", "d", "e"].map((label) => ({ op: "add", label, pdf: label === "a" }) as Step),
    );
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const join = (faults?: { stopAfter: number }) =>
      joinScientLibrary({
        library: ours.library,
        folder: backup,
        actor: "user",
        ...(faults ? { faults } : {}),
      });

    // The first join is killed after two of the five sources.
    await expect(join({ stopAfter: 2 })).rejects.toThrow("test fault");
    const afterStop = await ids(ours.scenario);
    expect(afterStop).toHaveLength(3);
    const [stopped] = await listScientLibraryJoins(ours.library);
    expect(stopped).toMatchObject({ state: "stopped", added: 2 });

    // Before continuing, the person removes one it added and edits another.
    const [first, second] = afterStop.filter(
      (sourceId) => sourceId !== workOf(ours.model, "mine").sourceId,
    );
    const removed = (await readScientSourceRecord(ours.library, first!))!;
    await moveToTrash(ours.scenario, removed.sourceId);
    await setScientLibraryReadingState({
      library: ours.library,
      sourceIds: [second!],
      starred: true,
    });

    // Joining the same backup again adds only what is still missing.
    expect(await join()).toMatchObject({ outcome: "joined", added: 3, removedHere: 1 });
    const now = await ids(ours.scenario);
    expect(now).toHaveLength(5);
    expect(now).not.toContain(first);
    expect(await readScientSourceRecord(ours.library, second!)).toMatchObject({ starred: true });
    expect(now.filter((sourceId) => sourceId === id("a"))).toHaveLength(id("a") === first ? 0 : 1);
    // A third time: nothing.
    expect(await join()).toMatchObject({ outcome: "joined", added: 0 });
    expect(await ids(ours.scenario)).toEqual(now);

    // Undo of the stopped join takes back only what it added that is unchanged: nothing, here.
    expect(
      await undoScientLibraryJoin({
        library: ours.library,
        joinId: stopped!.joinId,
        actor: "user",
      }),
    ).toEqual({ outcome: "undone", trashed: 0, left: 2 });
    expect(await ids(ours.scenario)).toEqual(now);
  });

  it("undoes a join as far as nothing changed, and a later join does not add those again", async () => {
    const theirs = await built([
      { op: "add", label: "a", pdf: true },
      { op: "add", label: "b", pdf: false },
      { op: "add", label: "c", pdf: false },
    ]);
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    await createScientSourceCollection({
      root: theirs.library,
      name: "Only theirs",
      sourceIds: [id("a"), id("b")],
      actor: "user",
    });
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    expect(joined.added).toBe(3);

    // One of the three is starred afterwards: it is the person's now.
    await setScientLibraryReadingState({
      library: ours.library,
      sourceIds: [id("c")],
      starred: true,
    });
    const undo = () =>
      undoScientLibraryJoin({ library: ours.library, joinId: joined.joinId, actor: "user" });
    expect(await undo()).toEqual({ outcome: "undone", trashed: 2, left: 1 });
    expect(await undo()).toEqual({ outcome: "already-undone" });
    expect(await ids(ours.scenario)).toEqual(
      [id("c"), workOf(ours.model, "mine").sourceId].toSorted(),
    );
    // In the Trash, so recoverable; the collection the join made is gone with its members.
    expect(
      (await readScientSourceTrashEntries(ours.library)).map((entry) => entry.sourceId).toSorted(),
    ).toEqual([id("a"), id("b")].toSorted());
    expect(
      (await readScientSourcesOrganization(ours.library)).collections.map((entry) => entry.name),
    ).toEqual([]);
    expect(await listScientLibraryJoins(ours.library)).toMatchObject([
      { state: "undone", added: 3, left: 1 },
    ]);

    // They were removed here, so the same backup does not bring them back.
    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 0, removedHere: 2, identical: 1, different: 0 });
  });

  it("leaves sources and created collections on Undo when saved searches hide later filing", async () => {
    const { scenario, library, joinId, sourceId } = await joinedCollection();
    await createScientSourceCollection({
      root: library,
      name: "Filed later",
      sourceIds: [sourceId],
      actor: "user",
    });
    const record = await readScientSourceRecord(library, sourceId);
    const organization = await readScientSourcesOrganization(library);
    const searchesPath = NodePath.join(scenario.libraryRoot, "saved-searches.json");
    const damaged = "{ damaged saved searches";
    await NodeFSP.writeFile(searchesPath, damaged);
    expect((await readScientSourcesOrganization(library)).issue).toBeDefined();

    expect(await undoScientLibraryJoin({ library, joinId, actor: "user" })).toEqual({
      outcome: "undone",
      trashed: 0,
      left: 2,
    });
    expect(await undoScientLibraryJoin({ library, joinId, actor: "user" })).toEqual({
      outcome: "already-undone",
    });
    expect(await readScientSourceRecord(library, sourceId)).toEqual(record);
    expect(await readScientSourceTrashEntries(library)).toEqual([]);
    expect(await NodeFSP.readFile(searchesPath, "utf8")).toBe(damaged);
    expect(await listScientLibraryJoins(library)).toMatchObject([
      { joinId, state: "undone", added: 1, left: 2 },
    ]);

    await NodeFSP.rm(searchesPath);
    expect(await readScientSourcesOrganization(library)).toEqual(organization);
  });

  it.each(["member", "child"] as const)(
    "serializes Undo's empty-collection decision with a concurrent %s addition",
    async (addition) => {
      const { scenario, model, library, joinId, sourceId, collectionId } = await joinedCollection();
      const checked = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const undoing = undoScientLibraryJoin({
        library,
        joinId,
        actor: "user",
        faults: {
          afterCollectionRead: async () => {
            checked.resolve();
            await resume.promise;
          },
        },
      });
      await checked.promise;
      // Enqueue before resuming Undo, without yielding to a filesystem path lookup first.
      const changing = withScientFileLock(
        NodePath.join(scenario.libraryRoot, "library.lock"),
        () =>
          addition === "member"
            ? changeScientSourceCollectionMembers({
                root: library,
                collectionId,
                add: [workOf(model, "mine").sourceId],
                actor: "user",
              })
            : createScientSourceCollection({
                root: library,
                name: "Added child",
                parentCollectionId: collectionId,
                actor: "user",
              }),
      );
      resume.resolve();
      const [undone, changed] = await Promise.all([undoing, changing]);
      expect(undone).toEqual({ outcome: "undone", trashed: 1, left: 0 });
      expect(changed.outcome).toBe("not-found");
      expect((await readScientSourcesOrganization(library)).collections).toEqual([]);
      expect(await ids(scenario)).toEqual([workOf(model, "mine").sourceId]);
      expect((await readScientSourceTrashEntries(library)).map((entry) => entry.sourceId)).toEqual([
        sourceId,
      ]);
    },
  );

  it("keeps on Undo a collection the join made and the person renamed since", async () => {
    const { library, joinId, collectionId } = await joinedCollection();
    await renameScientSourceCollection({
      root: library,
      collectionId,
      name: "Methods",
      actor: "user",
    });

    expect(await undoScientLibraryJoin({ library, joinId, actor: "user" })).toEqual({
      outcome: "undone",
      trashed: 1,
      left: 1,
    });
    expect((await readScientSourcesOrganization(library)).collections).toMatchObject([
      { collectionId, name: "Methods" },
    ]);
  });

  it("counts a created collection left when its deletion fails after Undo reads it", async () => {
    const { scenario, library, joinId, collectionId } = await joinedCollection();
    const collectionPath = NodePath.join(
      scenario.libraryRoot,
      "collections",
      `${collectionId}.json`,
    );
    const collectionBytes = await NodeFSP.readFile(collectionPath);
    const searchesPath = NodePath.join(scenario.libraryRoot, "saved-searches.json");
    expect(
      await undoScientLibraryJoin({
        library,
        joinId,
        actor: "user",
        faults: {
          afterCollectionRead: () => NodeFSP.writeFile(searchesPath, "{ damaged saved searches"),
        },
      }),
    ).toEqual({ outcome: "undone", trashed: 1, left: 1 });
    expect(await NodeFSP.readFile(collectionPath)).toEqual(collectionBytes);
    expect(await listScientLibraryJoins(library)).toMatchObject([
      { joinId, state: "undone", added: 1, left: 1 },
    ]);
    await NodeFSP.rm(searchesPath);
    expect((await readScientSourcesOrganization(library)).collections).toMatchObject([
      { collectionId, sourceIds: [] },
    ]);
  });

  it("shows, and never changes, a source both Libraries hold; and never revives one removed here", async () => {
    // Two Libraries with one past: the second is a copy of the first, and both go on.
    const ours = await built([
      { op: "add", label: "s1", pdf: false },
      { op: "add", label: "s2", pdf: false },
      { op: "add", label: "s3", pdf: true },
      { op: "add", label: "s4", pdf: false },
      { op: "add", label: "s5", pdf: false },
    ]);
    const id = (label: string) => workOf(ours.model, label).sourceId;
    const theirs = await newScenario();
    await NodeFSP.rm(theirs.libraryRoot, { recursive: true });
    await NodeFSP.cp(ours.scenario.libraryRoot, theirs.libraryRoot, { recursive: true });
    const theirModel = await further(theirs, ours.model, [
      { op: "editTitle", work: "s1", title: "s1 as the other Library retitled it" },
      { op: "setNote", work: "s2", note: "Added on the other computer." },
      { op: "setNote", work: "s3", note: "A note on a paper this Library deleted." },
      { op: "setNote", work: "s4", note: "A note on a paper this Library merged away." },
      { op: "trash", work: "s5" },
    ]);
    await further(ours.scenario, ours.model, [
      { op: "trash", work: "s3" },
      { op: "deleteForGood", work: "s3" },
    ]);
    const merged = await mergeScientLibrarySources({
      library: ours.library,
      sourceIds: [id("s1"), id("s4")],
      survivorId: id("s1"),
    });
    expect(merged.outcome).toBe("merged");
    const backup = await backUp(theirs);
    const before = await inventory(ours.scenario.libraryRoot);

    const result = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    expect(result).toMatchObject({
      outcome: "joined",
      added: 0,
      different: 3,
      removedHere: 1,
      removedThere: 1,
    });
    // Not one file of this Library changed.
    expect(changedSince(before, await inventory(ours.scenario.libraryRoot))).toEqual([]);
    expect(await readScientSourceRecord(ours.library, id("s3"))).toBeNull();
    expect(workOf(theirModel, "s5").state).toBe("trash");
    expect(await readScientSourceRecord(ours.library, id("s5"))).not.toBeNull();

    const [join] = await listScientLibraryJoins(ours.library);
    expect(
      join!.different.toSorted((a, b) => a.otherSourceId.localeCompare(b.otherSourceId)),
    ).toMatchObject(
      [
        // Its title differs there; here it also took s4's place, so more differs.
        { otherSourceId: id("s1"), sourceId: id("s1"), relation: "same-id", parts: ["details"] },
        { otherSourceId: id("s2"), sourceId: id("s2"), relation: "same-id", parts: ["note"] },
        { otherSourceId: id("s4"), sourceId: id("s1"), relation: "merged-here", parts: ["note"] },
      ].toSorted((a, b) => a.otherSourceId.localeCompare(b.otherSourceId)),
    );
  });

  it("takes a paper under another ID, or one it cannot tell apart, for the one here", async () => {
    // The same paper (one DOI) entered separately in each Library; a rebuilt copy; a look-alike.
    const theirs = await built([
      { op: "add", label: "same", pdf: false },
      { op: "setNote", work: "same", note: "Their note." },
      { op: "add", label: "orig", pdf: false },
    ]);
    const ours = await built([{ op: "add", label: "same", pdf: false }]);
    const original = workOf(theirs.model, "orig").sourceId;
    const candidate = (sourceKey: string, title: string) =>
      sourceCandidate({
        sourceKey,
        type: "article" as const,
        title,
        creators: [
          {
            creatorType: "author" as const,
            givenName: "Ada",
            familyName: "Byron",
            literalName: null,
          },
        ],
        issuedRaw: "2019",
        issuedYear: 2019,
      });
    const add = (library: typeof ours.library, key: string, title: string, rebuiltFrom?: string) =>
      importScientSource({
        root: library,
        operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: candidate(key, title),
        ...(rebuiltFrom ? { hydratedFromProjectSourceId: rebuiltFrom } : {}),
        actor: "user",
        intake: "file",
      }).then((result) => result.record!);
    // This Library rebuilt `orig` from a project; the other has the original.
    const rebuilt = await add(ours.library, "rebuilt", initialTitle("orig"), original);
    // No identifier on either side: only title, author and year agree.
    const alike = await add(theirs.library, "alike", "A study with no identifier");
    const mine = await add(ours.library, "alike-here", "A study with no identifier");
    const backup = await backUp(theirs.scenario);
    const before = await inventory(ours.scenario.libraryRoot);

    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 0, different: 3 });
    expect(changedSince(before, await inventory(ours.scenario.libraryRoot))).toEqual([]);
    const [join] = await listScientLibraryJoins(ours.library);
    const by = (otherSourceId: string) =>
      join!.different.find((entry) => entry.otherSourceId === otherSourceId);
    expect(by(workOf(theirs.model, "same").sourceId)).toMatchObject({
      sourceId: workOf(ours.model, "same").sourceId,
      relation: "same-paper",
      parts: ["note"],
    });
    expect(by(original)).toMatchObject({ sourceId: rebuilt.sourceId, relation: "rebuilt-here" });
    expect(by(alike.sourceId)).toMatchObject({
      sourceId: mine.sourceId,
      relation: "possibly-same",
    });
  });

  it("does not add a paper that several sources here could be, nor a second rebuilt copy", async () => {
    // Two sources here share a DOI (one is a raw copy of the other under its own ID), so the
    // import's rule cannot choose between them for a third.
    const ours = await built([{ op: "add", label: "twin", pdf: false }]);
    const twin = workOf(ours.model, "twin").sourceId;
    const records = NodePath.join(ours.scenario.libraryRoot, "records");
    const copyId = `source_${"c".repeat(32)}`;
    const original = JSON.parse(
      await NodeFSP.readFile(NodePath.join(records, `${twin}.json`), "utf8"),
    ) as Record<string, unknown>;
    await NodeFSP.writeFile(
      NodePath.join(records, `${copyId}.json`),
      JSON.stringify({ ...original, sourceId: copyId }),
    );
    const theirs = await built([{ op: "add", label: "twin", pdf: false }]);
    // Each Library rebuilt the same project source under its own ID; there it was retitled.
    const rebuilt = (library: typeof ours.library, title: string) =>
      importScientSource({
        root: library,
        operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: sourceCandidate({ sourceKey: `rebuilt-${title}`, title }),
        hydratedFromProjectSourceId: "source_project_original",
        actor: "user",
        intake: "file",
      }).then((result) => result.record!);
    const here = await rebuilt(ours.library, "The paper as the project saved it");
    const there = await rebuilt(theirs.library, "The paper, title corrected there");
    const backup = await backUp(theirs.scenario);
    const join = () => joinScientLibrary({ library: ours.library, folder: backup, actor: "user" });

    expect(await join()).toMatchObject({ outcome: "joined", added: 0, different: 2 });
    const [first] = await listScientLibraryJoins(ours.library);
    const by = (otherSourceId: string) =>
      first!.different.find((entry) => entry.otherSourceId === otherSourceId);
    // Several candidates: none is named, and it is not added.
    expect(by(workOf(theirs.model, "twin").sourceId)).toMatchObject({
      sourceId: null,
      relation: "possibly-same",
    });
    expect(by(there.sourceId)).toMatchObject({
      sourceId: here.sourceId,
      relation: "rebuilt-here",
      parts: ["details"],
    });

    // Deleted for good here, the other Library's copy of that project source stays out.
    await removeScientSource({
      root: ours.library,
      sourceId: here.sourceId,
      expectedRevision: here.revision,
      actor: "user",
    });
    await deleteScientSourcesPermanently({ root: ours.library });
    expect(await join()).toMatchObject({ outcome: "joined", added: 0, removedHere: 1 });
    expect(await readScientSourceRecord(ours.library, there.sourceId)).toBeNull();
  });

  it("leaves on Undo a source that a project uses, that was filed or highlighted since", async () => {
    const theirs = await built(
      ["a", "b", "c", "d"].map((label) => ({ op: "add", label, pdf: true }) as Step),
    );
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    expect(joined.added).toBe(4);

    // a: a project pinned it. b: it was put in a collection. c: its PDF was highlighted.
    const root = ours.scenario.libraryRoot;
    await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "projects", "instance_1.json"),
      JSON.stringify({
        formatVersion: 1,
        instanceId: "instance_1",
        sources: [{ projectSourceId: id("a"), sourceId: id("a") }],
      }),
    );
    await createScientSourceCollection({
      root: ours.library,
      name: "Mine",
      sourceIds: [id("b")],
      actor: "user",
    });
    const pdf = workOf(theirs.model, "c").pdfs[0]!.sha256;
    await NodeFSP.mkdir(NodePath.join(root, "annotations", "v1"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "annotations", "v1", `${pdf}.json`), "{}");

    expect(
      await undoScientLibraryJoin({ library: ours.library, joinId: joined.joinId, actor: "user" }),
    ).toEqual({ outcome: "undone", trashed: 1, left: 3 });
    expect(await ids(ours.scenario)).toEqual(
      [id("a"), id("b"), id("c"), workOf(ours.model, "mine").sourceId].toSorted(),
    );
  });

  it("keeps apart here what the other Library unmerged, and brings a PDF only an earlier version names", async () => {
    const theirs = await built([
      { op: "add", label: "x", pdf: false },
      { op: "add", label: "y", pdf: false },
      { op: "merge", survivor: "x", loser: "y" },
      { op: "undoMerge", loser: "y" },
      { op: "add", label: "p", pdf: true },
    ]);
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    // The PDF is detached there; its earlier version still names it and the file is still kept.
    const withPdf = (await readScientSourceRecord(theirs.library, id("p")))!;
    const attachment = withPdf.attachments[0]!;
    await detachScientSourcePdf({
      root: theirs.library,
      sourceId: id("p"),
      attachmentId: attachment.attachmentId,
      expectedRevision: withPdf.revision,
      actor: "user",
    });
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);

    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 3 });
    expect(
      (await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).map((pair) =>
        [...pair.sourceIds].toSorted(),
      ),
    ).toEqual([[id("x"), id("y")].toSorted()]);
    expect((await readScientSourceRecord(ours.library, id("p")))?.attachments).toEqual([]);
    await expect(
      NodeFSP.stat(
        NodePath.join(
          ours.scenario.libraryRoot,
          "files",
          "sha256",
          attachment.sha256.slice(0, 2),
          `${attachment.sha256}.pdf`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("files a source that arrived just before a join stopped, and keeps the parent of a kept collection", async () => {
    const theirs = await built([
      { op: "add", label: "a", pdf: false },
      { op: "add", label: "b", pdf: false },
    ]);
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    const parent = await createScientSourceCollection({
      root: theirs.library,
      name: "Thesis",
      actor: "user",
    });
    await createScientSourceCollection({
      root: theirs.library,
      name: "Chapter 3",
      parentCollectionId: parent.collection!.collectionId,
      sourceIds: [id("a"), id("b")],
      actor: "user",
    });
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const members = async () =>
      (await readScientSourcesOrganization(ours.library)).collections
        .find((entry) => entry.name === "Chapter 3")
        ?.sourceIds.toSorted();

    // Killed after the first record was created, before it was put in its collection.
    let organised = 0;
    await expect(
      joinScientLibrary({
        library: ours.library,
        folder: backup,
        actor: "user",
        faults: {
          beforeOrganise: () => {
            organised += 1;
            throw new Error("Stopped before organising (test fault).");
          },
        },
      }),
    ).rejects.toThrow("test fault");
    expect(organised).toBe(1);
    expect(await ids(ours.scenario)).toHaveLength(2);
    expect(await members()).toEqual([]);

    // The next join settles the stopped one first: its source is filed, the other one added.
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    expect(joined.added).toBe(1);
    expect(await members()).toEqual([id("a"), id("b")].toSorted());

    // Undo of the second join: its one source is starred, so it and its collections stay.
    const second = (await listScientLibraryJoins(ours.library)).find(
      (entry) => entry.joinId === joined.joinId,
    )!;
    expect(second).toMatchObject({ state: "done", added: 1 });
    const added = (await ids(ours.scenario)).filter(
      (sourceId) => sourceId === id("a") || sourceId === id("b"),
    );
    await setScientLibraryReadingState({ library: ours.library, sourceIds: added, starred: true });
    expect(
      await undoScientLibraryJoin({ library: ours.library, joinId: joined.joinId, actor: "user" }),
    ).toMatchObject({ outcome: "undone", trashed: 0 });
    const names = (await readScientSourcesOrganization(ours.library)).collections.map(
      (entry) => entry.name,
    );
    expect(names.toSorted()).toEqual(["Chapter 3", "Thesis"]);
  });

  it("keeps two same-named collections of the other Library as two", async () => {
    const theirs = await built([
      { op: "add", label: "a", pdf: false },
      { op: "add", label: "b", pdf: false },
    ]);
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    const twins = [
      ["collection_11111111111111111111111111111111", id("a")],
      ["collection_22222222222222222222222222222222", id("b")],
    ] as const;
    await placeScientSourceCollections({
      root: theirs.library,
      tree: twins.map(([collectionId]) => ({ collectionId, name: "Scopus" })),
      wanted: twins.map(([collectionId]) => collectionId),
      remake: false,
      actor: "user",
    });
    for (const [collectionId, sourceId] of twins) {
      await changeScientSourceCollectionMembers({
        root: theirs.library,
        collectionId,
        add: [sourceId],
        actor: "user",
      });
    }
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);

    await joinScientLibrary({
      library: ours.library,
      folder: await backUp(theirs.scenario),
      actor: "user",
    });

    const collections = (await readScientSourcesOrganization(ours.library)).collections;
    expect(collections.map((entry) => [entry.collectionId, entry.name, entry.sourceIds])).toEqual(
      twins.map(([collectionId, sourceId]) => [collectionId, "Scopus", [sourceId]]),
    );
  });

  it("adds both of two papers the other Library keeps as two, whichever part each falls in", async () => {
    // The other Library holds one paper twice, under two IDs (a raw copy), on purpose.
    const theirs = await built([{ op: "add", label: "dup", pdf: false }]);
    const first = workOf(theirs.model, "dup").sourceId;
    const second = `source_${"d".repeat(32)}`;
    const records = NodePath.join(theirs.scenario.libraryRoot, "records");
    const original = JSON.parse(
      await NodeFSP.readFile(NodePath.join(records, `${first}.json`), "utf8"),
    ) as Record<string, unknown>;
    await NodeFSP.writeFile(
      NodePath.join(records, `${second}.json`),
      JSON.stringify({ ...original, sourceId: second }),
    );
    const backup = await backUp(theirs.scenario);
    for (const partSize of [100, 1]) {
      const ours = await built([{ op: "add", label: "mine", pdf: false }]);
      // A paper is imported here while the join runs, so each part is judged afresh.
      let imported = false;
      const result = await joinScientLibrary({
        library: ours.library,
        folder: backup,
        actor: "user",
        faults: { partSize },
        onStarted: () => {
          imported = true;
        },
      });
      expect(imported).toBe(true);
      expect(result).toMatchObject({ outcome: "joined", added: 2, skipped: 0 });
      expect(await ids(ours.scenario)).toEqual(
        [first, second, workOf(ours.model, "mine").sourceId].toSorted(),
      );
    }
  });

  it("keeps apart the sources the other Library's own rule keeps apart after a later merge", async () => {
    // There: b was unmerged from a, then a was merged into c. Its rule keeps c and b apart.
    const theirs = await built([
      { op: "add", label: "a", pdf: false },
      { op: "add", label: "b", pdf: false },
      { op: "add", label: "c", pdf: false },
      { op: "merge", survivor: "a", loser: "b" },
      { op: "undoMerge", loser: "b" },
      { op: "merge", survivor: "c", loser: "a" },
    ]);
    const id = (label: string) => workOf(theirs.model, label).sourceId;
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 2 });
    expect(
      (await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).map((pair) =>
        [...pair.sourceIds].toSorted(),
      ),
    ).toEqual([[id("b"), id("c")].toSorted()]);
  });

  it("leaves on Undo a source a project has just pinned, and one whose state on arrival is not known", async () => {
    const theirs = await built([
      { op: "add", label: "a", pdf: true },
      { op: "add", label: "b", pdf: true },
    ]);
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    // The first source's record lands, then the join is killed before it is filed.
    await expect(
      joinScientLibrary({
        library: ours.library,
        folder: backup,
        actor: "user",
        faults: {
          beforeOrganise: () => {
            throw new Error("Stopped before organising (test fault).");
          },
        },
      }),
    ).rejects.toThrow("test fault");
    const [stopped] = await listScientLibraryJoins(ours.library);
    const second = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (second.outcome !== "joined") throw new Error(`Not joined: ${second.outcome}`);
    expect(second.added).toBe(1);
    // The stopped join's source: its highlights on arrival were never recorded, and its PDF
    // has a highlights file now. The second join's source: a project pinned it, and the
    // Library's map of that project has not been written yet.
    const stoppedId = (await ids(ours.scenario)).find(
      (sourceId) =>
        sourceId !== workOf(ours.model, "mine").sourceId &&
        sourceId !== lastAdded(second.joinId, ours.scenario.libraryRoot),
    )!;
    const pdf = (await readScientSourceRecord(ours.library, stoppedId))!.attachments[0]!.sha256;
    const highlights = NodePath.join(ours.scenario.libraryRoot, "annotations", "v1");
    await NodeFSP.mkdir(highlights, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(highlights, `${pdf}.json`), "{}");
    const pinned = lastAdded(second.joinId, ours.scenario.libraryRoot);
    await pinScientLibrarySource({
      projectRoot: ours.scenario.projects[0]!,
      library: ours.library,
      sourceId: pinned,
      actor: "user",
      note: null,
    });

    expect(
      await undoScientLibraryJoin({
        library: ours.library,
        joinId: stopped!.joinId,
        actor: "user",
      }),
    ).toEqual({ outcome: "undone", trashed: 0, left: 1 });
    expect(
      await undoScientLibraryJoin({ library: ours.library, joinId: second.joinId, actor: "user" }),
    ).toEqual({ outcome: "undone", trashed: 0, left: 1 });
    expect(await ids(ours.scenario)).toHaveLength(3);
  });

  it("brings the highlights of a source whose PDF had been copied when the join was killed", async () => {
    const theirs = await built([{ op: "add", label: "a", pdf: true }]);
    const pdf = workOf(theirs.model, "a").pdfs[0]!.sha256;
    const theirHighlights = NodePath.join(theirs.scenario.libraryRoot, "annotations", "v1");
    await NodeFSP.mkdir(theirHighlights, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(theirHighlights, `${pdf}.json`), '{"marks":2}\n');
    const backup = await backUp(theirs.scenario);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    await expect(
      joinScientLibrary({
        library: ours.library,
        folder: backup,
        actor: "user",
        faults: {
          afterFiles: () => {
            throw new Error("Stopped after the files (test fault).");
          },
        },
      }),
    ).rejects.toThrow("test fault");
    // The PDF is here and its record is not. The next join must not take the PDF for one of
    // this Library's own and leave the highlights behind.
    expect(await ids(ours.scenario)).toHaveLength(1);
    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 1, different: 0 });
    expect(
      await NodeFSP.readFile(
        NodePath.join(ours.scenario.libraryRoot, "annotations", "v1", `${pdf}.json`),
        "utf8",
      ),
    ).toBe('{"marks":2}\n');
  });

  it("reads only a finished backup or a Library its own restore moved aside", async () => {
    const theirs = await built([{ op: "add", label: "a", pdf: true }]);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const open = (folder: string) => openScientLibraryJoinSource(ours.library, folder);

    // Another Scient's live Library folder is not accepted, nor this Library itself.
    expect(await open(theirs.scenario.libraryRoot)).toEqual({ outcome: "not-a-library" });
    expect(await open(ours.scenario.libraryRoot)).toEqual({ outcome: "same-library" });
    expect(await open("relative/path")).toEqual({ outcome: "not-a-library" });

    const backup = await backUp(theirs.scenario);
    expect(await open(backup)).toMatchObject({ outcome: "ready", other: { kind: "backup" } });
    await NodeFSP.appendFile(NodePath.join(backup, "library", "library.json"), " ");
    expect(await open(backup)).toEqual({ outcome: "damaged" });
    expect(
      await joinScientLibrary({ library: ours.library, folder: backup, actor: "user" }),
    ).toEqual({ outcome: "damaged" });

    // A folder beside this Library that only looks like one a restore set aside is refused.
    const lookalike = `${ours.scenario.libraryRoot}.replaced-restore_1`;
    await NodeFSP.cp(theirs.scenario.libraryRoot, lookalike, { recursive: true });
    expect(await open(lookalike)).toEqual({ outcome: "not-a-library" });

    // The Library a restore of this one moved aside, as that restore recorded it.
    const restorable = await built([{ op: "add", label: "r", pdf: false }]);
    const good = await backUp(restorable.scenario);
    await prepareScientLibraryRestore({ libraryRoot: ours.scenario.libraryRoot, backup: good });
    const finished = await finishScientLibraryRestore(ours.scenario.libraryRoot);
    if (finished.outcome !== "restored" || !finished.keptReplaced) throw new Error("Not kept.");
    const aside = finished.keptReplaced.path;
    expect(await open(aside)).toMatchObject({ outcome: "ready", other: { kind: "replaced" } });
    // What this Library held before the restore comes into the restored one.
    expect(
      await joinScientLibrary({ library: ours.library, folder: aside, actor: "user" }),
    ).toMatchObject({ outcome: "joined", added: 1 });
    expect(await ids(ours.scenario)).toContain(workOf(ours.model, "mine").sourceId);
    const compared = await compareScientLibraries(ours.library, aside);
    expect(compared).toMatchObject({ fresh: [], identical: 1 });
  });
});

/** The one source a finished join's record says it added. */
function lastAdded(joinId: string, libraryRoot: string): string {
  const part = JSON.parse(
    NodeFS.readFileSync(NodePath.join(libraryRoot, "joins", joinId, "part-00001.json"), "utf8"),
  ) as { added: ReadonlyArray<{ sourceId: string }> };
  return part.added[0]!.sourceId;
}

async function moveToTrash(scenario: Scenario, sourceId: string) {
  const library = libraryOf(scenario);
  const record = (await readScientSourceRecord(library, sourceId))!;
  await removeScientSource({
    root: library,
    sourceId,
    expectedRevision: record.revision,
    actor: "user",
  });
}

describe("what differs between the two Libraries, and taking one thing at a time", () => {
  /** Two Libraries with one past; the other one then gets a title, a note and a PDF. */
  async function diverged() {
    const ours = await built([
      { op: "add", label: "s1", pdf: false },
      { op: "add", label: "s2", pdf: false },
      { op: "setNote", work: "s2", note: "My own note." },
    ]);
    const id = (label: string) => workOf(ours.model, label).sourceId;
    const theirs = await newScenario();
    await NodeFSP.rm(theirs.libraryRoot, { recursive: true });
    await NodeFSP.cp(ours.scenario.libraryRoot, theirs.libraryRoot, { recursive: true });
    await further(theirs, ours.model, [
      { op: "editTitle", work: "s1", title: "s1 as the other Library retitled it" },
      { op: "setNote", work: "s2", note: "Written on the other computer." },
    ]);
    const theirLibrary = libraryOf(theirs);
    const pdfPath = NodePath.join(theirs.inbox, "extra.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nan extra PDF\n%%EOF\n");
    const withNote = (await readScientSourceRecord(theirLibrary, id("s2")))!;
    const attached = await attachScientSourcePdf({
      root: theirLibrary,
      sourceId: id("s2"),
      expectedRevision: withNote.revision,
      pdfPath,
      actor: "user",
    });
    const backup = await backUp(theirs);
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    const list = async () =>
      (await readScientLibraryJoinDifferences({ library: ours.library, joinId: joined.joinId }))!;
    const row = async (label: string) =>
      (await list()).rows.find((entry) => entry.otherSourceId === id(label));
    return {
      ours,
      id,
      backup,
      joinId: joined.joinId,
      list,
      row,
      pdf: attached.record.attachments[0]!.sha256,
    };
  }

  it("lists each paper with both sides as they are now, also when the folder is away", async () => {
    const { ours, id, backup, list, row, pdf } = await diverged();
    const listed = await list();
    expect(listed).toMatchObject({ available: true, total: 2, nextOffset: null });
    expect(await row("s1")).toMatchObject({
      relation: "same-id",
      parts: ["details"],
      here: { sourceId: id("s1"), title: initialTitle("s1") },
      other: { title: "s1 as the other Library retitled it" },
      details: [
        {
          field: "Title",
          here: initialTitle("s1"),
          other: "s1 as the other Library retitled it",
        },
      ],
    });
    expect(await row("s2")).toMatchObject({
      parts: ["note", "pdfs"],
      here: { note: "My own note.", pdfs: [] },
      other: {
        note: "Written on the other computer.",
        pdfs: [{ sha256: pdf, fileName: "extra.pdf", available: true }],
      },
    });
    // Reading changed nothing here.
    expect((await readScientSourceRecord(ours.library, id("s2")))?.note).toBe("My own note.");

    // With the backup away the list still says which papers, how they stand and what differed.
    await NodeFSP.rename(backup, `${backup} (moved)`);
    const away = await list();
    expect(away.available).toBe(false);
    expect(away.rows).toHaveLength(2);
    expect(await row("s1")).toMatchObject({ parts: ["details"], other: null });
    expect(await row("s2")).toMatchObject({ parts: ["note", "pdfs"], other: null });
    expect((await row("s1"))?.otherTitle).toBe("s1 as the other Library retitled it");
  });

  it("counts a paper's further details among its details, each under its own name", async () => {
    const ours = await built([{ op: "add", label: "s1", pdf: false }]);
    const sourceId = workOf(ours.model, "s1").sourceId;
    const theirs = await newScenario();
    await NodeFSP.rm(theirs.libraryRoot, { recursive: true });
    await NodeFSP.cp(ours.scenario.libraryRoot, theirs.libraryRoot, { recursive: true });
    // On the other computer the edition and the place of publication were filled in.
    const record = (await readScientSourceRecord(libraryOf(theirs), sourceId))!;
    await updateScientSourceMetadata({
      root: libraryOf(theirs),
      sourceId,
      expectedRevision: record.revision,
      metadata: {
        ...editableMetadataFromRecord(record),
        more: { edition: "3", "publisher-place": "Leiden" },
      },
      actor: "user",
    });
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: await backUp(theirs),
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    expect(joined).toMatchObject({ added: 0, different: 1 });
    const [row] = (await readScientLibraryJoinDifferences({
      library: ours.library,
      joinId: joined.joinId,
    }))!.rows;
    expect(row).toMatchObject({
      relation: "same-id",
      parts: ["details"],
      details: [
        { field: "Edition", here: "", other: "3" },
        { field: "Place of publication", here: "", other: "Leiden" },
      ],
    });
  });

  it("adds the other note under this paper's own, once, and attaches one PDF", async () => {
    const { ours, id, joinId, row, pdf } = await diverged();
    const shown = (await row("s2"))!;
    const take = (
      what: Parameters<typeof takeFromScientLibraryJoin>[0]["take"],
      operationId: string,
      from = shown,
    ) =>
      takeFromScientLibraryJoin({
        library: ours.library,
        joinId,
        otherSourceId: id("s2"),
        take: what,
        shown: shownOf(from),
        operationId,
        actor: "user",
      });

    expect(await take({ kind: "note" }, "op_note_1")).toEqual({
      outcome: "taken",
      sourceId: id("s2"),
    });
    const noted = (await readScientSourceRecord(ours.library, id("s2")))!;
    expect(noted.note).toMatch(
      /^My own note\.\n\n\(From the backup of \d{4}-\d{2}-\d{2}:\)\nWritten on the other computer\.$/u,
    );
    // The same request again (its answer was lost) does nothing more.
    expect(await take({ kind: "note" }, "op_note_1")).toEqual({ outcome: "already" });
    // The row the person still sees is stale now: another click is refused, nothing is added.
    expect(await take({ kind: "note" }, "op_note_2")).toEqual({ outcome: "changed" });
    expect((await readScientSourceRecord(ours.library, id("s2")))?.note).toBe(noted.note);

    // The list no longer offers the note; the PDF is still to take, from the row as it is now.
    const after = (await row("s2"))!;
    expect(after.parts).toEqual(["pdfs"]);
    expect(await take({ kind: "pdf", sha256: pdf }, "op_pdf_1", after)).toEqual({
      outcome: "taken",
      sourceId: id("s2"),
    });
    const attached = (await readScientSourceRecord(ours.library, id("s2")))!;
    expect(attached.attachments.map((entry) => entry.sha256)).toEqual([pdf]);
    expect(attached.note).toBe(noted.note);
    expect(await row("s2")).toBeUndefined();
    // Each was an ordinary edit: the paper's earlier versions are kept.
    expect(attached.revision).toBeGreaterThan(shown.here ? 2 : 0);
  });

  it("does nothing when the paper here changed after the list was shown, or the folder is away", async () => {
    const { ours, id, backup, joinId, row } = await diverged();
    const shown = (await row("s2"))!;
    const take = () =>
      takeFromScientLibraryJoin({
        library: ours.library,
        joinId,
        otherSourceId: id("s2"),
        take: { kind: "note" },
        shown: shownOf(shown),
        operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        actor: "user",
      });
    // Starring changes no version, and still counts: the row no longer shows the paper as it is.
    await setScientLibraryReadingState({
      library: ours.library,
      sourceIds: [id("s2")],
      starred: true,
    });
    expect(await take()).toEqual({ outcome: "changed" });
    await setScientLibraryReadingState({
      library: ours.library,
      sourceIds: [id("s2")],
      starred: false,
    });
    await NodeFSP.rename(backup, `${backup} (moved)`);
    expect(await take()).toEqual({ outcome: "unavailable" });
    expect((await readScientSourceRecord(ours.library, id("s2")))?.note).toBe("My own note.");
  });

  /** A paper of the other Library that may be one here, left behind by a join. */
  async function alikeLeftBehind(
    /** Done to the other Library's paper before its backup is made. */
    first?: (
      theirs: Awaited<ReturnType<typeof built>>["library"],
      sourceId: string,
    ) => Promise<unknown>,
  ) {
    const candidate = (sourceKey: string) =>
      sourceCandidate({
        sourceKey,
        type: "article" as const,
        title: "A study with no identifier",
        creators: [
          {
            creatorType: "author" as const,
            givenName: "Ada",
            familyName: "Byron",
            literalName: null,
          },
        ],
        issuedRaw: "2019",
        issuedYear: 2019,
      });
    const add = (library: Awaited<ReturnType<typeof built>>["library"], key: string) =>
      importScientSource({
        root: library,
        operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: candidate(key),
        actor: "user",
        intake: "file",
      }).then((result) => result.record!);
    const theirs = await built([{ op: "add", label: "t", pdf: false }]);
    const ours = await built([{ op: "add", label: "o", pdf: false }]);
    const alike = await add(theirs.library, "alike");
    await first?.(theirs.library, alike.sourceId);
    const mine = await add(ours.library, "alike-here");
    const backup = await backUp(theirs.scenario);
    const joined = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
    });
    if (joined.outcome !== "joined") throw new Error(`Not joined: ${joined.outcome}`);
    const list = async () =>
      (await readScientLibraryJoinDifferences({ library: ours.library, joinId: joined.joinId }))!;
    const addSeparately = (row: Row, operationId: string) =>
      takeFromScientLibraryJoin({
        library: ours.library,
        joinId: joined.joinId,
        otherSourceId: alike.sourceId,
        take: { kind: "add-separately" },
        shown: shownOf(row),
        operationId,
        actor: "user",
      });
    return { ours, alike, mine, list, addSeparately, backup };
  }

  it("adds a paper that may be the same separately, and keeps it apart from the one it resembled", async () => {
    const { ours, alike, mine, list, addSeparately } = await alikeLeftBehind();
    const [shown] = (await list()).rows;
    expect(shown).toMatchObject({
      otherSourceId: alike.sourceId,
      relation: "possibly-same",
      here: { sourceId: mine.sourceId },
      candidates: [{ sourceId: mine.sourceId }],
    });

    expect(await addSeparately(shown!, "op_add_1")).toEqual({
      outcome: "taken",
      sourceId: alike.sourceId,
    });
    expect(await readScientSourceRecord(ours.library, alike.sourceId)).toMatchObject({
      title: "A study with no identifier",
    });
    expect(
      (await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).map((pair) =>
        [...pair.sourceIds].toSorted(),
      ),
    ).toEqual([[alike.sourceId, mine.sourceId].toSorted()]);
    // It is here under its own ID now, so it is no longer listed.
    expect((await list()).rows).toEqual([]);
  });

  it("adds nothing separately from a row that no longer shows how the papers stand", async () => {
    const { ours, alike, mine, list, addSeparately } = await alikeLeftBehind();
    const [shown] = (await list()).rows;
    // The paper here it resembled is retitled: nothing here looks like the other one now.
    const record = (await readScientSourceRecord(ours.library, mine.sourceId))!;
    await updateScientSourceMetadata({
      root: ours.library,
      sourceId: mine.sourceId,
      expectedRevision: record.revision,
      metadata: {
        ...editableMetadataFromRecord(record),
        title: "Something else entirely",
        creators: [],
        issuedRaw: "1901",
      },
      actor: "user",
    });

    // The old row named a paper to keep it apart from; that is no longer what would happen.
    expect(await addSeparately(shown!, "op_stale")).toEqual({ outcome: "changed" });
    expect(await readScientSourceRecord(ours.library, alike.sourceId)).toBeNull();
    expect(await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).toEqual([]);

    // The list says so, and from that row the paper is added with nothing to keep apart from.
    const [now] = (await list()).rows;
    expect(now).toMatchObject({ relation: "not-here", here: null, candidates: [] });
    expect(await addSeparately(now!, "op_now")).toEqual({
      outcome: "taken",
      sourceId: alike.sourceId,
    });
    expect(await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).toEqual([]);
  });

  it("adds nothing separately when a file of the backup is not the one the backup lists", async () => {
    for (const damaged of ["an earlier version", "the collections"] as const) {
      // The other Library's paper has an earlier version: its note was written after it came.
      const { ours, alike, list, addSeparately, backup } = await alikeLeftBehind(
        async (theirs, sourceId) => {
          const record = (await readScientSourceRecord(theirs, sourceId))!;
          await updateScientSourceNote({
            root: theirs,
            sourceId,
            expectedRevision: record.revision,
            expectedNote: record.note ?? null,
            note: "Written before the backup.",
            actor: "user",
          });
        },
      );
      const [shown] = (await list()).rows;
      const before = await inventory(ours.scenario.libraryRoot);
      const payload = NodePath.join(backup, "library");
      if (damaged === "an earlier version") {
        const history = NodePath.join(payload, "history", alike.sourceId);
        const [version] = await NodeFSP.readdir(history);
        await NodeFSP.appendFile(NodePath.join(history, version!), " ");
      } else {
        await NodeFSP.appendFile(NodePath.join(payload, "library.json"), " ");
      }

      expect(await addSeparately(shown!, `op_${damaged.length}`), damaged).toEqual({
        outcome: "unavailable",
      });
      // Nothing of the paper is here: no record, no version, no decision about it.
      expect(await readScientSourceRecord(ours.library, alike.sourceId)).toBeNull();
      expect(changedSince(before, await inventory(ours.scenario.libraryRoot))).toEqual([]);
      expect(await readScientLibraryDistinctPairs(ours.scenario.libraryRoot)).toEqual([]);
    }
  });

  it("attaches only the very PDF the row named, and reads a backup's records against its list", async () => {
    const { ours, id, backup, joinId, list, row, pdf } = await diverged();
    const shown = (await row("s2"))!;
    // The file at the PDF's place in the backup is replaced by another PDF.
    const payload = NodePath.join(backup, "library");
    for (const entry of await NodeFSP.readdir(payload, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = NodePath.join(entry.parentPath, entry.name);
      const hash = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(file))
        .digest("hex");
      if (hash === pdf) await NodeFSP.writeFile(file, "%PDF-1.7\nanother paper\n%%EOF\n");
    }
    expect(
      await takeFromScientLibraryJoin({
        library: ours.library,
        joinId,
        otherSourceId: id("s2"),
        take: { kind: "pdf", sha256: pdf },
        shown: shownOf(shown),
        operationId: "op_swapped",
        actor: "user",
      }),
    ).toEqual({ outcome: "unavailable" });
    expect((await readScientSourceRecord(ours.library, id("s2")))?.attachments).toEqual([]);

    // A record of the backup that was changed is not shown as the other version.
    const record = NodePath.join(payload, "records", `${id("s1")}.json`);
    await NodeFSP.writeFile(
      record,
      (await NodeFSP.readFile(record, "utf8")).replace("retitled", "tampered"),
    );
    expect((await list()).available).toBe(true);
    expect(await row("s1")).toMatchObject({ parts: ["details"], other: null });
  });

  it("leaves both notes out for a reader that may not see the person's notes", async () => {
    const { ours, id, joinId } = await diverged();
    const listed = (await readScientLibraryJoinDifferences({
      library: ours.library,
      joinId,
      personal: false,
    }))!;
    const row = listed.rows.find((entry) => entry.otherSourceId === id("s2"));
    expect(row).toMatchObject({ parts: ["pdfs"], here: { note: "" }, other: { note: "" } });
    expect(JSON.stringify(listed)).not.toContain("Written on the other computer.");
    expect(JSON.stringify(listed)).not.toContain("My own note.");
  });

  it("does not add a paper that an edit made here, between two parts, the same as one here", async () => {
    const theirs = await built([
      { op: "add", label: "t1", pdf: false },
      { op: "add", label: "t2", pdf: false },
    ]);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const mine = NodePath.join(
      ours.scenario.libraryRoot,
      "records",
      `${workOf(ours.model, "mine").sourceId}.json`,
    );
    const backup = await backUp(theirs.scenario);
    let asked = 0;
    const result = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
      faults: { partSize: 1 },
      shouldStop: () => {
        asked += 1;
        if (asked !== 2) return false;
        // Between the parts, the paper here is given the details of the one still to come.
        const coming = ["t1", "t2"]
          .map((label) => workOf(theirs.model, label).sourceId)
          .find(
            (sourceId) =>
              !NodeFS.existsSync(
                NodePath.join(ours.scenario.libraryRoot, "records", `${sourceId}.json`),
              ),
          )!;
        const other = JSON.parse(
          NodeFS.readFileSync(
            NodePath.join(theirs.scenario.libraryRoot, "records", `${coming}.json`),
            "utf8",
          ),
        ) as Record<string, unknown>;
        const here = JSON.parse(NodeFS.readFileSync(mine, "utf8")) as Record<string, unknown>;
        NodeFS.writeFileSync(
          mine,
          JSON.stringify({
            ...here,
            title: other.title,
            creators: other.creators,
            issuedRaw: other.issuedRaw,
            issuedYear: other.issuedYear,
            identifiers: other.identifiers,
          }),
        );
        return false;
      },
    });
    expect(result).toMatchObject({ outcome: "joined", added: 1, skipped: 1 });
    expect(await ids(ours.scenario)).toHaveLength(2);
  });

  it("does not add a paper that an edit made the same as one this very join had just added", async () => {
    const theirs = await built([
      { op: "add", label: "t1", pdf: false },
      { op: "add", label: "t2", pdf: false },
    ]);
    const ours = await built([{ op: "add", label: "mine", pdf: false }]);
    const records = (scenario: Scenario) => NodePath.join(scenario.libraryRoot, "records");
    const [first, second] = ["t1", "t2"].map((label) => workOf(theirs.model, label).sourceId);
    const backup = await backUp(theirs.scenario);
    let asked = 0;
    const result = await joinScientLibrary({
      library: ours.library,
      folder: backup,
      actor: "user",
      faults: { partSize: 1 },
      shouldStop: () => {
        asked += 1;
        if (asked !== 2) return false;
        // Between the parts, the paper that has just arrived is given, here, the details of
        // the one still to come (the other Library keeps the two apart; this edit does not).
        const [arrived, coming] = NodeFS.existsSync(
          NodePath.join(records(ours.scenario), `${first}.json`),
        )
          ? [first!, second!]
          : [second!, first!];
        const other = JSON.parse(
          NodeFS.readFileSync(NodePath.join(records(theirs.scenario), `${coming}.json`), "utf8"),
        ) as Record<string, unknown>;
        const file = NodePath.join(records(ours.scenario), `${arrived}.json`);
        const here = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
        NodeFS.writeFileSync(
          file,
          JSON.stringify({
            ...here,
            title: other.title,
            creators: other.creators,
            issuedRaw: other.issuedRaw,
            issuedYear: other.issuedYear,
            identifiers: other.identifiers,
          }),
        );
        return false;
      },
    });
    expect(result).toMatchObject({ outcome: "joined", added: 1, skipped: 1 });
    expect(await ids(ours.scenario)).toHaveLength(2);
  });

  it("refuses to make a note longer than a note may be", async () => {
    const { ours, id, joinId, row } = await diverged();
    const record = (await readScientSourceRecord(ours.library, id("s2")))!;
    await updateScientSourceNote({
      root: ours.library,
      sourceId: id("s2"),
      expectedRevision: record.revision,
      expectedNote: record.note ?? null,
      note: "x".repeat(99_990),
      actor: "user",
    });
    const shown = (await row("s2"))!;
    expect(
      await takeFromScientLibraryJoin({
        library: ours.library,
        joinId,
        otherSourceId: id("s2"),
        take: { kind: "note" },
        shown: shownOf(shown),
        operationId: "op_long_1",
        actor: "user",
      }),
    ).toEqual({ outcome: "too-long" });
    expect((await readScientSourceRecord(ours.library, id("s2")))?.note).toHaveLength(99_990);
  });
});
