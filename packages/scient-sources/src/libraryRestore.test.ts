// @effect-diagnostics nodeBuiltinImport:off -- The restore drill runs real Library steps in temporary folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  bulkUpdateScientSources,
  createScientSourceCollection,
  saveScientSourceSearch,
} from "./collections.ts";
import { backUpScientLibrary, scientLibraryBackupLeavesOut } from "./libraryBackup.ts";
import { listScientLibraryRecentChanges } from "./libraryChanges.ts";
import { openScientLibraryJoinSource } from "./libraryJoin.ts";
import { markScientLibrarySourcesDistinct } from "./libraryMerge.ts";
import {
  moveScientProjectBackIntoProject,
  readScientLibraryMoveState,
  runScientLibraryMove,
} from "./libraryMove.ts";
import {
  cancelScientLibraryRestore,
  finishScientLibraryRestore,
  listScientLibraryRestores,
  prepareScientLibraryPutBack,
  prepareScientLibraryRestore,
  readScientLibraryRestorePending,
  scientLibraryUnused,
  type ScientLibraryRestoreFault,
} from "./libraryRestore.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import { resolveScientProjectPins } from "./projectPins.ts";
import { importScientSource, readScientSourceRecord } from "./store.ts";
import { applyStep, EMPTY_MODEL, workOf, type Model, type Step } from "./testing/libraryModel.ts";
import { checkLibraryRules } from "./testing/libraryRules.ts";
import {
  createScenario,
  libraryOf,
  recoverScenario,
  runStep,
  type Scenario,
} from "./testing/librarySteps.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-restore-")),
  );
  roots.push(root);
  return root;
}

/** Every kind of content the steps make: edits, notes, PDFs, pins, merges, Trash, deletion. */
const STEPS: ReadonlyArray<Step> = [
  { op: "add", label: "w1", pdf: true },
  { op: "add", label: "w2", pdf: true },
  { op: "add", label: "w3", pdf: false },
  { op: "add", label: "w4", pdf: true },
  { op: "add", label: "w5", pdf: true },
  { op: "add", label: "w6", pdf: false },
  { op: "add", label: "w7", pdf: true },
  { op: "editTitle", work: "w1", title: "A retitled study of the fixture library" },
  { op: "setNote", work: "w1", note: "Read chapter two again." },
  { op: "setNote", work: "w5", note: "The copy's own note." },
  { op: "pin", project: 0, work: "w1", note: "Cite for the method." },
  { op: "pin", project: 0, work: "w5", note: null },
  { op: "pin", project: 1, work: "w2", note: null },
  { op: "pin", project: 2, work: "w7", note: "Soon gone." },
  { op: "setProjectNote", project: 1, work: "w2", note: "Background only." },
  // A merge that stands, and one that was undone.
  { op: "merge", survivor: "w3", loser: "w5" },
  { op: "merge", survivor: "w2", loser: "w6" },
  { op: "undoMerge", loser: "w6" },
  { op: "trash", work: "w4" },
  { op: "trash", work: "w7" },
  { op: "deleteForGood", work: "w7" },
  { op: "resolveProject", project: 0 },
  { op: "resolveProject", project: 1 },
  { op: "resolveProject", project: 2 },
];

async function build(): Promise<{ readonly scenario: Scenario; readonly model: Model }> {
  const scenario = await createScenario(await temporaryRoot());
  let model = EMPTY_MODEL;
  for (const step of STEPS) model = applyStep(model, step, await runStep(scenario, model, step));
  // What the steps do not cover: a collection, a saved search, a bulk edit, a "not duplicates"
  // decision, and a file a later Scient might keep here.
  const library = libraryOf(scenario);
  const id = (label: string) => workOf(model, label).sourceId;
  await createScientSourceCollection({
    root: library,
    name: "To read",
    sourceIds: [id("w1"), id("w2")],
    actor: "user",
  });
  await saveScientSourceSearch({
    root: library,
    name: "Fixtures",
    filter: { text: "fixture" },
    actor: "user",
  });
  await bulkUpdateScientSources({
    root: library,
    change: { sourceIds: [id("w1"), id("w3")], addTags: ["Cohort"] },
    actor: "user",
  });
  await markScientLibrarySourcesDistinct({ library, sourceIds: [id("w1"), id("w2")] });
  await NodeFSP.mkdir(NodePath.join(scenario.libraryRoot, "from-a-later-scient"));
  await NodeFSP.writeFile(
    NodePath.join(scenario.libraryRoot, "from-a-later-scient", "kept.json"),
    '{"kept":true}\n',
  );
  return { scenario, model };
}

/** Every file a backup keeps, with its hash. */
async function inventory(folder: string): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = NodePath.join(entry.parentPath, entry.name);
    const path = NodePath.relative(folder, absolute).split(NodePath.sep).join("/");
    if (scientLibraryBackupLeavesOut(path)) continue;
    found.set(
      path,
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(absolute))
        .digest("hex"),
    );
  }
  return new Map([...found].toSorted(([a], [b]) => a.localeCompare(b)));
}

async function backUp(scenario: Scenario): Promise<string> {
  const destination = NodePath.join(scenario.root, "backups");
  await NodeFSP.mkdir(destination, { recursive: true });
  const result = await backUpScientLibrary({ library: libraryOf(scenario), destination });
  if (result.outcome !== "backed-up") throw new Error(`Not backed up: ${result.outcome}`);
  return result.path;
}

/** The same projects with the Library at another place, as after the old one was lost. */
const withLibraryAt = (scenario: Scenario, libraryRoot: string): Scenario => ({
  ...scenario,
  libraryRoot,
});

const besideOf = async (libraryRoot: string) =>
  (await NodeFSP.readdir(NodePath.dirname(libraryRoot))).toSorted();

describe("restoring a backup of the Library", () => {
  it("brings back every kept file and every rule, and the Library goes on working", async () => {
    const { scenario, model } = await build();
    const before = await inventory(scenario.libraryRoot);
    const backup = await backUp(scenario);

    // The Library is lost; the projects are still there.
    const restoredRoot = NodePath.join(scenario.root, "elsewhere", "scient", "library");
    const prepared = await prepareScientLibraryRestore({ libraryRoot: restoredRoot, backup });
    expect(prepared).toMatchObject({ outcome: "ready", counts: { sources: 4 } });
    // Nothing is in the Library's place until the next start.
    expect(await besideOf(restoredRoot)).not.toContain("library");
    expect(await readScientLibraryRestorePending(restoredRoot)).toMatchObject({
      restoreId: prepared.outcome === "ready" ? prepared.restoreId : "",
    });

    const finished = await finishScientLibraryRestore(restoredRoot);
    expect(finished).toMatchObject({ outcome: "restored", keptReplaced: null });
    expect(await besideOf(restoredRoot)).toEqual(["library", "library.restore.lock"]);
    expect(await finishScientLibraryRestore(restoredRoot)).toEqual({ outcome: "none" });

    // Byte for byte what was there, plus the note of where it came from.
    const after = new Map(await inventory(restoredRoot));
    expect(after.delete("restores.json")).toBe(true);
    expect([...after]).toEqual([...before]);

    // The same rules hold against the same expectation, with the projects as they were.
    const restored = withLibraryAt(scenario, restoredRoot);
    expect((await checkLibraryRules(restored, [model])).violations).toEqual([]);

    // It goes on working: a restart's recovery, the merge can still be undone, the paper
    // deleted for good stays deleted when its project is resolved again.
    await recoverScenario(restored);
    let next = model;
    for (const step of [
      { op: "undoMerge", loser: "w5" },
      { op: "resolveProject", project: 0 },
      { op: "resolveProject", project: 2 },
      { op: "add", label: "w8", pdf: true },
      { op: "pin", project: 1, work: "w8", note: null },
    ] satisfies ReadonlyArray<Step>) {
      next = applyStep(next, step, await runStep(restored, next, step));
    }
    expect((await checkLibraryRules(restored, [next])).violations).toEqual([]);
    expect(workOf(next, "w7").state).toBe("deleted");
  });

  it("replaces the Library a new computer made when its projects were opened, and keeps that one", async () => {
    const { scenario, model } = await build();
    const backup = await backUp(scenario);
    // A new Library, and each project opened against it as the server does: Scient rebuilds
    // the projects' sources there from their saved details.
    const newRoot = NodePath.join(scenario.root, "new-computer", "scient", "library");
    await ensureScientLibrary(newRoot);
    const fresh = withLibraryAt(scenario, newRoot);
    for (const project of scenario.projects) {
      await resolveScientProjectPins({
        projectRoot: project,
        library: scientLibraryLocation(newRoot),
        mode: "write",
        actor: "user",
      });
    }
    const rebuilt = await inventory(newRoot);
    expect([...rebuilt.keys()].filter((path) => path.startsWith("records/"))).toHaveLength(4);
    expect(await scientLibraryUnused(newRoot)).toBe(false);

    const prepared = await prepareScientLibraryRestore({ libraryRoot: newRoot, backup });
    if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);
    const kept = `${newRoot}.replaced-${prepared.restoreId}`;
    expect(await finishScientLibraryRestore(newRoot)).toMatchObject({
      outcome: "restored",
      keptReplaced: { path: kept, sources: 4 },
    });
    // The Library that was there is beside the restored one, whole.
    expect(await inventory(kept)).toEqual(rebuilt);
    expect(await besideOf(newRoot)).toEqual([
      "library",
      NodePath.basename(kept),
      "library.restore.lock",
    ]);
    // The projects find their own sources again, not the rebuilt copies.
    await recoverScenario(fresh);
    expect((await checkLibraryRules(fresh, [model])).violations).toEqual([]);
    // A later start leaves the kept Library alone.
    expect(await finishScientLibraryRestore(newRoot)).toEqual({ outcome: "none" });
    expect(await inventory(kept)).toEqual(rebuilt);
    // The restored Library itself records where the old one is, and Recent changes lists it
    // for as long as that folder is there.
    const restore = async () =>
      (await listScientLibraryRecentChanges(libraryOf(fresh), 50)).changes.find(
        (change) => change.kind === "restore",
      );
    expect(await restore()).toMatchObject({
      id: prepared.restoreId,
      by: "user",
      sources: 4,
      kept: { path: kept, sources: 4 },
    });
    await NodeFSP.rm(kept, { recursive: true });
    expect(await restore()).toMatchObject({ id: prepared.restoreId, kept: null });
  });

  it("still records the kept Library when a start is killed right after the swap is recorded", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const other = await createScenario(await temporaryRoot());
    const step: Step = { op: "add", label: "mine", pdf: false };
    await runStep(other, EMPTY_MODEL, step);
    const prepared = await prepareScientLibraryRestore({ libraryRoot: other.libraryRoot, backup });
    if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);

    await expect(
      finishScientLibraryRestore(other.libraryRoot, { fault: "before-intent-removed" }),
    ).rejects.toThrow("test fault");
    // The next start finishes; the record made before the stop is the one that stands.
    const kept = `${other.libraryRoot}.replaced-${prepared.restoreId}`;
    expect(await finishScientLibraryRestore(other.libraryRoot)).toMatchObject({
      outcome: "restored",
      keptReplaced: { path: kept, sources: 1 },
    });
    expect(
      (await listScientLibraryRecentChanges(libraryOf(other), 50)).changes.filter(
        (change) => change.kind === "restore",
      ),
    ).toMatchObject([{ kept: { path: kept, sources: 1 } }]);
  });

  it("keeps a project that was moved back after the backup out of the restored Library", async () => {
    const scenario = await createScenario(await temporaryRoot());
    const library = libraryOf(scenario);
    const project = scenario.projects[0]!;
    // A project with its own source moves into the Library; then the backup is made.
    const own = await importScientSource({
      root: project,
      operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      candidate: {
        sourceKey: "own",
        type: "article",
        customType: null,
        title: "A study the project keeps",
        creators: [],
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
        fieldProvenance: [],
        pdfAvailable: false,
        pdfFileName: null,
        pdfAttachmentCount: 0,
      },
      actor: "user",
      intake: "file",
    });
    const move = () => runScientLibraryMove({ library, projectRoot: project, actor: "user" });
    expect((await move()).outcome).toBe("moved");
    const backup = await backUp(scenario);

    // After the backup the person moves the project back, then restores the backup.
    expect(
      await moveScientProjectBackIntoProject({ library, projectRoot: project, actor: "user" }),
    ).toMatchObject({ outcome: "moved-back" });
    await prepareScientLibraryRestore({ libraryRoot: scenario.libraryRoot, backup });
    // A start killed right after the swap: the decision is not carried over yet, so until the
    // next start finishes the restore no project may move in.
    await expect(
      finishScientLibraryRestore(scenario.libraryRoot, { fault: "after-swap" }),
    ).rejects.toThrow("test fault");
    await expect(move()).rejects.toThrow("did not finish. Restart Scient");
    expect(await readScientSourceRecord(project, own.record!.sourceId)).not.toBeNull();
    expect(await finishScientLibraryRestore(scenario.libraryRoot)).toMatchObject({
      outcome: "restored",
    });

    // The backup was made while the project was in the Library. The decision made since is
    // carried over: the project keeps its own sources and nothing moves it in again.
    expect((await move()).outcome).toBe("moved-back");
    expect(await readScientSourceRecord(project, own.record!.sourceId)).not.toBeNull();
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).moved).toBe(false);
    // A second start changes nothing.
    expect(await finishScientLibraryRestore(scenario.libraryRoot)).toEqual({ outcome: "none" });
    expect((await move()).outcome).toBe("moved-back");
  });

  it("makes no new Library while the old one is aside and the copy is not in place", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const other = await createScenario(await temporaryRoot());
    const step: Step = { op: "add", label: "mine", pdf: true };
    await runStep(other, EMPTY_MODEL, step);
    await prepareScientLibraryRestore({ libraryRoot: other.libraryRoot, backup });

    // A copy that only waits does not stop the Library from being used or made.
    await expect(ensureScientLibrary(other.libraryRoot)).resolves.toMatchObject({});
    await expect(
      finishScientLibraryRestore(other.libraryRoot, { fault: "after-aside" }),
    ).rejects.toThrow("test fault");
    // Half way: a write that would make a Library is refused, so the real one is not shadowed.
    await expect(ensureScientLibrary(other.libraryRoot)).rejects.toThrow(
      "did not finish. Restart Scient",
    );
    expect(await besideOf(other.libraryRoot)).not.toContain("library");

    expect(await finishScientLibraryRestore(other.libraryRoot)).toMatchObject({
      outcome: "restored",
      keptReplaced: { sources: 1 },
    });
    await expect(ensureScientLibrary(other.libraryRoot)).resolves.toMatchObject({});
  });

  it.each<ScientLibraryRestoreFault>(["after-aside", "after-swap", "before-intent-removed"])(
    "a start that stops %s is finished by the next start",
    async (fault) => {
      const { scenario, model } = await build();
      const before = await inventory(scenario.libraryRoot);
      const backup = await backUp(scenario);
      const root = NodePath.join(scenario.root, "elsewhere", "scient", "library");
      await ensureScientLibrary(root);
      await prepareScientLibraryRestore({ libraryRoot: root, backup });

      await expect(finishScientLibraryRestore(root, { fault })).rejects.toThrow("test fault");
      expect(await finishScientLibraryRestore(root)).toMatchObject({
        outcome: "restored",
        keptReplaced: null,
      });
      expect(await besideOf(root)).toEqual(["library", "library.restore.lock"]);
      const after = new Map(await inventory(root));
      after.delete("restores.json");
      expect([...after]).toEqual([...before]);
      expect((await checkLibraryRules(withLibraryAt(scenario, root), [model])).violations).toEqual(
        [],
      );
      expect(await finishScientLibraryRestore(root)).toEqual({ outcome: "none" });
    },
  );

  it("puts the Library back when a start moved it aside and the waiting copy was then lost", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const other = await createScenario(await temporaryRoot());
    const step: Step = { op: "add", label: "mine", pdf: true };
    const mine = applyStep(EMPTY_MODEL, step, await runStep(other, EMPTY_MODEL, step));
    const before = await inventory(other.libraryRoot);
    const prepared = await prepareScientLibraryRestore({ libraryRoot: other.libraryRoot, backup });
    if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);

    // The start stops after moving the Library aside, and then the waiting copy is lost.
    await expect(
      finishScientLibraryRestore(other.libraryRoot, { fault: "after-aside" }),
    ).rejects.toThrow("test fault");
    await NodeFSP.rm(`${other.libraryRoot}.restoring-${prepared.restoreId}`, { recursive: true });

    expect(await finishScientLibraryRestore(other.libraryRoot)).toMatchObject({
      outcome: "failed",
      waiting: false,
    });
    expect(await besideOf(other.libraryRoot)).toEqual(["library", "library.restore.lock"]);
    expect(await inventory(other.libraryRoot)).toEqual(before);
    expect((await checkLibraryRules(other, [mine])).violations).toEqual([]);
  });

  it("stages nothing from a folder that is not a whole, unchanged backup", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const root = NodePath.join(scenario.root, "elsewhere", "scient", "library");
    const prepare = () => prepareScientLibraryRestore({ libraryRoot: root, backup });
    const payload = NodePath.join(backup, "library");
    const manifestPath = NodePath.join(backup, "backup.json");
    const manifest = await NodeFSP.readFile(manifestPath, "utf8");
    const withManifest = async (change: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(manifest) as Record<string, unknown>;
      change(value);
      await NodeFSP.writeFile(manifestPath, JSON.stringify(value));
    };
    type Listed = Array<{ path: string; sha256: string; bytes: number }>;

    expect(await prepareScientLibraryRestore({ libraryRoot: root, backup: scenario.root })).toEqual(
      { outcome: "not-a-backup" },
    );

    // A file that changed, one that is gone, one that does not belong.
    await NodeFSP.appendFile(NodePath.join(payload, "aliases.json"), " ");
    expect(await prepare()).toEqual({ outcome: "damaged", file: "aliases.json" });
    await NodeFSP.rm(NodePath.join(payload, "aliases.json"));
    expect(await prepare()).toEqual({ outcome: "damaged", file: "aliases.json" });
    await NodeFSP.writeFile(NodePath.join(payload, "records", "stray.json"), "{}");
    expect(await prepare()).toEqual({ outcome: "damaged", file: "records/stray.json" });
    await NodeFSP.rm(NodePath.join(payload, "records", "stray.json"));

    // Names a restore will not write: outside the Library, twice by case, a name a backup
    // leaves out, one Windows cannot create, and a backup without `library.json`.
    const first = (JSON.parse(manifest) as { files: Listed }).files[0]!.path;
    await withManifest((value) => {
      (value.files as Listed)[0]!.path = "../outside.json";
    });
    expect(await prepare()).toEqual({ outcome: "unsafe-paths", file: "../outside.json" });
    await withManifest((value) => {
      const files = value.files as Listed;
      files.push({ ...files[0]!, path: first.toUpperCase() });
    });
    expect(await prepare()).toEqual({ outcome: "unsafe-paths", file: first.toUpperCase() });
    for (const path of ["library.lock", "records/aux.json", "records/name.", "a:b.json"]) {
      await withManifest((value) => {
        (value.files as Listed).push({ path, sha256: "0".repeat(64), bytes: 0 });
      });
      expect(await prepare()).toEqual({ outcome: "unsafe-paths", file: path });
    }
    await withManifest((value) => {
      value.files = (value.files as Listed).filter((file) => file.path !== "library.json");
    });
    expect(await prepare()).toEqual({ outcome: "unsafe-paths", file: "library.json" });
    await withManifest((value) => {
      value.formatVersion = 2;
    });
    expect(await prepare()).toEqual({ outcome: "unsupported" });

    expect(await besideOf(root)).toEqual(["library.restore.lock"]);
  });

  it("cannot be cancelled or replaced once a start has swapped the Library in", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const other = await createScenario(await temporaryRoot());
    await runStep(other, EMPTY_MODEL, { op: "add", label: "mine", pdf: false });
    const prepared = await prepareScientLibraryRestore({ libraryRoot: other.libraryRoot, backup });
    if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);
    expect(await readScientLibraryRestorePending(other.libraryRoot)).toMatchObject({
      begun: false,
    });

    // The start is killed after the copy took the Library's place, before it was recorded.
    await expect(
      finishScientLibraryRestore(other.libraryRoot, { fault: "after-swap" }),
    ).rejects.toThrow("test fault");
    expect(await readScientLibraryRestorePending(other.libraryRoot)).toMatchObject({
      restoreId: prepared.restoreId,
      begun: true,
    });
    // Dropping the intent now would leave a restored Library nothing ever finished.
    expect(await cancelScientLibraryRestore(other.libraryRoot)).toEqual({ outcome: "begun" });
    expect(await prepareScientLibraryRestore({ libraryRoot: other.libraryRoot, backup })).toEqual({
      outcome: "unfinished",
    });
    expect(await finishScientLibraryRestore(other.libraryRoot)).toMatchObject({
      outcome: "restored",
      restoreId: prepared.restoreId,
      keptReplaced: { sources: 1 },
    });
    expect(await readScientLibraryRestorePending(other.libraryRoot)).toBeNull();
  });

  it("leaves the copy that was waiting when a later backup turns out damaged", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const root = NodePath.join(scenario.root, "elsewhere", "scient", "library");
    const first = await prepareScientLibraryRestore({ libraryRoot: root, backup });
    if (first.outcome !== "ready") throw new Error(`Not ready: ${first.outcome}`);

    // A second backup whose last listed file was changed: found only after copying the rest.
    const damaged = NodePath.join(scenario.root, "damaged-backup");
    await NodeFSP.cp(backup, damaged, { recursive: true });
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(damaged, "backup.json"), "utf8"),
    ) as { readonly files: ReadonlyArray<{ readonly path: string }> };
    const last = manifest.files.at(-1)!.path;
    await NodeFSP.appendFile(NodePath.join(damaged, "library", ...last.split("/")), "x");
    expect(await prepareScientLibraryRestore({ libraryRoot: root, backup: damaged })).toEqual({
      outcome: "damaged",
      file: last,
    });

    expect(await readScientLibraryRestorePending(root)).toMatchObject({
      restoreId: first.restoreId,
      begun: false,
    });
    expect(await besideOf(root)).toEqual([
      "library.restore.json",
      "library.restore.lock",
      `library.restoring-${first.restoreId}`,
    ]);
    expect(await finishScientLibraryRestore(root)).toMatchObject({
      outcome: "restored",
      restoreId: first.restoreId,
    });
  });

  it("still lists, and reads, a Library an earlier restore kept after another restore", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const other = await createScenario(await temporaryRoot());
    await runStep(other, EMPTY_MODEL, { op: "add", label: "mine", pdf: false });
    const restore = async () => {
      const prepared = await prepareScientLibraryRestore({
        libraryRoot: other.libraryRoot,
        backup,
      });
      if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);
      expect(await finishScientLibraryRestore(other.libraryRoot)).toMatchObject({
        outcome: "restored",
      });
      return `${other.libraryRoot}.replaced-${prepared.restoreId}`;
    };
    const firstKept = await restore();
    // Something made after the first restore, so the second keeps that Library too.
    await runStep(other, EMPTY_MODEL, { op: "add", label: "between", pdf: false });
    const secondKept = await restore();

    // The backup knows neither; the record of the first came over from the Library replaced.
    const kept = (await listScientLibraryRestores(libraryOf(other))).flatMap((entry) =>
      entry.kept ? [entry.kept.path] : [],
    );
    expect(kept.toSorted()).toEqual([firstKept, secondKept].toSorted());
    for (const folder of [firstKept, secondKept]) {
      expect(await openScientLibraryJoinSource(libraryOf(other), folder)).toMatchObject({
        outcome: "ready",
        other: { kind: "replaced" },
      });
    }
  });

  /** A Library a person works in, with another Library's backup restored over it by mistake. */
  async function restoredByMistake() {
    const { scenario, model } = await build();
    const elsewhere = await createScenario(await temporaryRoot());
    await runStep(elsewhere, EMPTY_MODEL, { op: "add", label: "theirs", pdf: true });
    const wrongBackup = await backUp(elsewhere);
    const mine = await inventory(scenario.libraryRoot);
    const prepared = await prepareScientLibraryRestore({
      libraryRoot: scenario.libraryRoot,
      backup: wrongBackup,
    });
    if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);
    expect(await finishScientLibraryRestore(scenario.libraryRoot)).toMatchObject({
      outcome: "restored",
      putBack: false,
    });
    const kept = `${scenario.libraryRoot}.replaced-${prepared.restoreId}`;
    expect(await inventory(kept)).toEqual(mine);
    return { scenario, model, mine, kept, wrong: await inventory(scenario.libraryRoot) };
  }

  /** A Library's files apart from its own record of restores, which a put-back adds to. */
  const apartFromRestores = (files: ReadonlyMap<string, string>) =>
    new Map([...files].filter(([path]) => path !== "restores.json"));

  it("puts the Library back after a restore made by mistake, whole, and that can be taken back too", async () => {
    const { scenario, model, mine, kept, wrong } = await restoredByMistake();
    const root = scenario.libraryRoot;

    // Only a folder this Library's record of a restore names.
    expect(await prepareScientLibraryPutBack({ libraryRoot: root, folder: scenario.root })).toEqual(
      { outcome: "not-kept" },
    );

    // Choosing it changes nothing yet, and Cancel leaves both Libraries exactly as they are.
    const first = await prepareScientLibraryPutBack({ libraryRoot: root, folder: kept });
    expect(first).toMatchObject({ outcome: "ready", counts: { sources: 4 } });
    expect(await readScientLibraryRestorePending(root)).toMatchObject({
      putBack: NodePath.basename(kept),
      begun: false,
    });
    expect(await cancelScientLibraryRestore(root)).toEqual({ outcome: "cancelled" });
    expect(await inventory(kept)).toEqual(mine);
    expect(await inventory(root)).toEqual(wrong);

    const again = await prepareScientLibraryPutBack({ libraryRoot: root, folder: kept });
    if (again.outcome !== "ready") throw new Error(`Not ready: ${again.outcome}`);
    const displaced = `${root}.replaced-${again.restoreId}`;
    expect(await finishScientLibraryRestore(root)).toMatchObject({
      outcome: "restored",
      putBack: true,
      keptReplaced: { path: displaced, sources: 1 },
    });
    // The Library is the one that was replaced, file for file; the one restored by mistake
    // is kept in its turn; the folder that was kept is the Library now.
    expect(apartFromRestores(await inventory(root))).toEqual(apartFromRestores(mine));
    expect(apartFromRestores(await inventory(displaced))).toEqual(apartFromRestores(wrong));
    expect(await besideOf(root)).toEqual([
      "library",
      NodePath.basename(displaced),
      "library.restore.lock",
    ]);
    await recoverScenario(scenario);
    expect((await checkLibraryRules(scenario, [model])).violations).toEqual([]);
    expect(
      (await listScientLibraryRecentChanges(libraryOf(scenario), 50)).changes.filter(
        (change) => change.kind === "restore",
      ),
    ).toMatchObject([{ id: again.restoreId, putBack: true, kept: { path: displaced } }]);

    // And back again: the restored Library can be made the Library once more.
    const back = await prepareScientLibraryPutBack({ libraryRoot: root, folder: displaced });
    if (back.outcome !== "ready") throw new Error(`Not ready: ${back.outcome}`);
    expect(await finishScientLibraryRestore(root)).toMatchObject({
      outcome: "restored",
      putBack: true,
    });
    expect(apartFromRestores(await inventory(root))).toEqual(apartFromRestores(wrong));
    expect(apartFromRestores(await inventory(`${root}.replaced-${back.restoreId}`))).toEqual(
      apartFromRestores(mine),
    );
  });

  it("finishes putting a Library back at the next start, wherever a start was killed", async () => {
    for (const fault of ["after-aside", "after-swap", "before-intent-removed"] as const) {
      const { scenario, model, mine, kept } = await restoredByMistake();
      const root = scenario.libraryRoot;
      const prepared = await prepareScientLibraryPutBack({ libraryRoot: root, folder: kept });
      if (prepared.outcome !== "ready") throw new Error(`Not ready: ${prepared.outcome}`);
      await expect(finishScientLibraryRestore(root, { fault })).rejects.toThrow("test fault");
      // It has begun: it cannot be cancelled, and no other restore can take its place.
      expect(await cancelScientLibraryRestore(root)).toEqual({ outcome: "begun" });
      expect(await prepareScientLibraryPutBack({ libraryRoot: root, folder: kept })).toMatchObject({
        outcome: expect.stringMatching(/^(unfinished|not-kept)$/u),
      });
      expect(await finishScientLibraryRestore(root)).toMatchObject({
        outcome: "restored",
        putBack: true,
      });
      expect(apartFromRestores(await inventory(root))).toEqual(apartFromRestores(mine));
      await recoverScenario(scenario);
      expect((await checkLibraryRules(scenario, [model])).violations).toEqual([]);
    }
  });

  it("drops a waiting copy on Cancel, replaces it on a second request, and can be stopped", async () => {
    const { scenario } = await build();
    const backup = await backUp(scenario);
    const root = NodePath.join(scenario.root, "elsewhere", "scient", "library");

    let asked = 0;
    expect(
      await prepareScientLibraryRestore({
        libraryRoot: root,
        backup,
        shouldStop: () => (asked += 1) > 3,
      }),
    ).toEqual({ outcome: "stopped" });
    expect(await besideOf(root)).toEqual(["library.restore.lock"]);

    const first = await prepareScientLibraryRestore({ libraryRoot: root, backup });
    const second = await prepareScientLibraryRestore({ libraryRoot: root, backup });
    if (first.outcome !== "ready" || second.outcome !== "ready") throw new Error("Not ready.");
    expect(await besideOf(root)).toEqual([
      "library.restore.json",
      "library.restore.lock",
      `library.restoring-${second.restoreId}`,
    ]);

    expect(await cancelScientLibraryRestore(root)).toEqual({ outcome: "cancelled" });
    expect(await cancelScientLibraryRestore(root)).toEqual({ outcome: "nothing-waiting" });
    expect(await besideOf(root)).toEqual(["library.restore.lock"]);
    expect(await finishScientLibraryRestore(root)).toEqual({ outcome: "none" });
  });

  it("keeps a replaced Library for anything a person made, and for what it does not know", async () => {
    const root = NodePath.join(await temporaryRoot(), "library");
    expect(await scientLibraryUnused(root)).toBe(true);
    await ensureScientLibrary(root);
    await NodeFSP.mkdir(NodePath.join(root, "records"));
    await NodeFSP.mkdir(NodePath.join(root, "text", "sha256"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "text", "sha256", "x.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(root, "instances.json"), "{}");
    expect(await scientLibraryUnused(root)).toBe(true);

    for (const path of ["deleted/source_1.json", "saved-searches.json", "unknown.bin"]) {
      const file = NodePath.join(root, ...path.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, "{}");
      expect(await scientLibraryUnused(root)).toBe(false);
      await NodeFSP.rm(file);
    }
    await NodeFSP.symlink(NodePath.join(root, "library.json"), NodePath.join(root, "a-link"));
    expect(await scientLibraryUnused(root)).toBe(false);
  });
});
