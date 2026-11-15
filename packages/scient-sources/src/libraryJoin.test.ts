// @effect-diagnostics nodeBuiltinImport:off -- Joins real Libraries in temporary folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { createScientSourceCollection, readScientSourcesOrganization } from "./collections.ts";
import { backUpScientLibrary, scientLibraryBackupLeavesOut } from "./libraryBackup.ts";
import {
  compareScientLibraries,
  joinScientLibrary,
  listScientLibraryJoins,
  openScientLibraryJoinSource,
  undoScientLibraryJoin,
} from "./libraryJoin.ts";
import { readScientLibraryDistinctPairs } from "./libraryExclusions.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { finishScientLibraryRestore, prepareScientLibraryRestore } from "./libraryRestore.ts";
import {
  deleteScientSourcesPermanently,
  detachScientSourcePdf,
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  removeScientSource,
  setScientLibraryReadingState,
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
        `annotations/v1/${pdf}.json`,
        `files/sha256/${pdf.slice(0, 2)}/${pdf}.pdf`,
      ]),
    );
    // The source is as the other Library has it: the record file itself, byte for byte.
    for (const path of [`records/${n1}.json`, `history/${n1}/1.json`]) {
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
    ).toMatchObject({ outcome: "joined", added: 0, removedHere: 2, different: 1 });
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
    ).toEqual(
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
    const candidate = (sourceKey: string, title: string) => ({
      sourceKey,
      type: "article" as const,
      customType: null,
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
      fieldProvenance: [],
      pdfAvailable: false,
      pdfFileName: null,
      pdfAttachmentCount: 0,
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
        candidate: {
          sourceKey: `rebuilt-${title}`,
          type: "article",
          customType: null,
          title,
          creators: [],
          issuedRaw: null,
          issuedYear: null,
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
          fieldProvenance: [],
          pdfAvailable: false,
          pdfFileName: null,
          pdfAttachmentCount: 0,
        },
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
