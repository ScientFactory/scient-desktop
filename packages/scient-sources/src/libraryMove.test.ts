// @effect-diagnostics nodeBuiltinImport:off -- Move tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { readLibraryAliasesAt } from "./libraryAliases.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  listScientReviewConflicts,
  readScientReviewVersions,
  resolveScientReviewConflict,
  SCIENT_REVIEW_COMBINED_NOTE,
} from "./libraryReviewConflicts.ts";
import {
  changeScientLibraryReview,
  listScientLibraryReviewRecords,
  readScientLibraryReview,
} from "./libraryReviews.ts";
import {
  moveScientProjectBackIntoProject,
  readScientLibraryMoveState,
  restoreScientProjectPreMoveArchive,
  runScientLibraryMove,
  scientLibraryMoveInternals,
  scientLibraryMoveStatusLines,
  ScientLibraryMoveCrash,
  type ScientLibraryMoveFaults,
  type ScientLibraryMoveJournal,
  type ScientLibraryMoveProgress,
} from "./libraryMove.ts";
import { ScientPreMoveRestorePendingError } from "./libraryMoveArchive.ts";
import {
  ensureScientLibrary,
  listScientLibraryInstances,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { SCIENT_SOURCE_NAME_LIMIT } from "./organize.ts";
import {
  exportScientProjectPackage,
  importScientProjectPackage,
  listScientProjectPackages,
} from "./projectPackage.ts";
import {
  readScientProjectPinNoteHistory,
  readScientProjectPins,
  resolveScientProjectPins,
  setScientProjectPinNote,
} from "./projectPins.ts";
import {
  attachScientSourcePdf,
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "./store.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import { organizeScientSources } from "./collections.ts";
import { changeScientSystematicReview } from "./systematicReviewStore.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-move-")),
  );
  fixtures.push(root);
  return root;
}

async function newLibrary(base: string, name = "state"): Promise<ScientLibraryLocation> {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return scientLibraryLocation(root);
}

async function newProject(base: string, name = "project"): Promise<string> {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return root;
}

const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

function candidate(
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title: `Study ${sourceKey}`,
    creators: [ada],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
    abstract: `Abstract of ${sourceKey}.`,
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
    ...overrides,
  };
}

async function add(root: string, key: string, overrides: Partial<ScientSourceCandidate> = {}) {
  const result = await importScientSource({
    root,
    operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    candidate: candidate(key, overrides),
    actor: "user",
    intake: "file",
  });
  return result.record!;
}

async function editTitle(root: ScientSourceStoreLocation, sourceId: string, title: string) {
  const record = (await readScientSourceRecord(root, sourceId))!;
  return updateScientSourceMetadata({
    root,
    sourceId,
    expectedRevision: record.revision,
    metadata: { ...editableMetadataFromRecord(record), title },
  });
}

async function review(root: string, title: string, sourceIds: ReadonlyArray<string>) {
  const { reviewId } = await changeScientSystematicReview({
    root,
    change: { action: "create-review", title },
    actor: "user",
  });
  await changeScientSystematicReview({
    root,
    change: {
      action: "log-search",
      reviewId: reviewId!,
      database: "PubMed",
      query: title,
      searchedOn: "2026-11-01",
      sourceIds: [...sourceIds],
    },
    actor: "user",
  });
  return reviewId!;
}

async function screen(
  root: string,
  reviewId: string,
  sourceId: string,
  decision: "include" | "exclude",
) {
  await changeScientSystematicReview({
    root,
    change: {
      action: "screen",
      reviewId,
      stage: "title-abstract",
      decisions: [{ sourceId, decision }],
    },
    actor: "user",
  });
}

/**
 * A v1 project with what the move must carry: two sources (one with a PDF, a note and a
 * revision, one plain), one in the trash, a collection, a screened review, bibliography copies
 * and a highlight on the PDF.
 */
async function seed(root: string) {
  const a = await add(root, "a", { identifiers: [{ scheme: "doi", value: "10.1000/a" }] });
  const b = await add(root, "b", { title: "Plain study" });
  const c = await add(root, "c", { title: "Removed study" });
  const pdf = NodePath.join(NodePath.dirname(root), `${NodePath.basename(root)}-a.pdf`);
  await NodeFSP.writeFile(pdf, `%PDF-1.7\n${root}\n`, "utf8");
  const attached = await attachScientSourcePdf({
    root,
    sourceId: a.sourceId,
    expectedRevision: a.revision,
    pdfPath: pdf,
  });
  await updateScientSourceNote({
    root,
    sourceId: a.sourceId,
    expectedRevision: attached.record.revision,
    note: "Why this project cites A.",
  });
  await editTitle(root, b.sourceId, "Plain study, revised");
  await removeScientSource({ root, sourceId: c.sourceId, expectedRevision: c.revision });
  await organizeScientSources({
    root,
    change: { action: "create-collection", name: "Methods", sourceIds: [a.sourceId] },
    actor: "user",
  });
  const reviewId = await review(root, "Screening", [a.sourceId, b.sourceId]);
  await screen(root, reviewId, a.sourceId, "include");
  await NodeFSP.mkdir(NodePath.join(root, ".scient/sources/bibliography"), { recursive: true });
  for (const name of ["references.bib", "references.json"]) {
    await NodeFSP.writeFile(
      NodePath.join(root, ".scient/sources/bibliography", name),
      `v1 ${name}\n`,
    );
    await NodeFSP.writeFile(NodePath.join(root, name), `v1 ${name}\n`);
  }
  const sha256 = attached.record.attachments[0]!.sha256;
  await NodeFSP.mkdir(NodePath.join(root, ".scient/annotations/v1"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, ".scient/annotations/v1", `${sha256}.json`),
    JSON.stringify({
      formatVersion: 1,
      material: { sha256, byteLength: 10 },
      paths: [".scient/sources/a.pdf"],
      annotations: [{ annotationId: "ann_1", revision: 1, highlighted: true, note: "Key line" }],
      history: [],
    }),
  );
  return { a, b, c, reviewId, sha256 };
}

async function instanceOf(library: ScientLibraryLocation, project: string) {
  const path = await NodeFSP.realpath(project);
  return (await listScientLibraryInstances(library)).find((entry) => entry.path === path)!
    .instanceId;
}

async function journalOf(library: ScientLibraryLocation, project: string) {
  const root = await NodeFSP.realpath(library.root);
  const instanceId = await instanceOf(library, project);
  return (await scientLibraryMoveInternals.readJournalAt(
    scientLibraryMoveInternals.migrationDirectory(root, instanceId),
  ))!;
}

const move = (
  library: ScientLibraryLocation,
  projectRoot: string,
  faults?: ScientLibraryMoveFaults,
) => runScientLibraryMove({ library, projectRoot, actor: "user", ...(faults ? { faults } : {}) });

async function crashAt(
  library: ScientLibraryLocation,
  project: string,
  faults: ScientLibraryMoveFaults,
): Promise<ScientLibraryMoveJournal> {
  await expect(move(library, project, faults)).rejects.toBeInstanceOf(ScientLibraryMoveCrash);
  return journalOf(library, project);
}

const sha = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function exists(path: string): Promise<boolean> {
  return NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The rerun's bar: journal `done`, `.scient/sources` gone, every v1 record pinned and resolved,
 * the review and bibliography copies in place, the backup holding the records, and every
 * artifact at its journal hash.
 */
async function expectDone(
  library: ScientLibraryLocation,
  project: string,
  expected: {
    readonly sourceIds: ReadonlyArray<string>;
    readonly reviewIds: ReadonlyArray<string>;
  },
) {
  const journal = await journalOf(library, project);
  expect(journal.state).toBe("done");
  expect(journal.retry).toEqual([]);
  expect(await exists(NodePath.join(project, ".scient/sources"))).toBe(false);
  const pins = await resolveScientProjectPins({
    projectRoot: project,
    library,
    mode: "read",
    actor: "user",
  });
  expect(pins.map(({ pin }) => pin.sourceId).toSorted()).toEqual(
    [...expected.sourceIds].toSorted(),
  );
  expect(pins.every(({ resolution }) => resolution.kind === "resolved")).toBe(true);
  for (const reviewId of expected.reviewIds) {
    expect(await exists(NodePath.join(project, `.scient/library/reviews/${reviewId}.json`))).toBe(
      true,
    );
    expect(
      await exists(NodePath.join(project, `.scient/library/reviews/${reviewId}.works.json`)),
    ).toBe(true);
  }
  for (const artifact of journal.artifacts) {
    const bytes = await NodeFSP.readFile(NodePath.join(project, artifact.path));
    expect(sha(bytes), artifact.path).toBe(artifact.stagedSha256);
  }
  const backup = scientLibraryMoveInternals.backupRoot(
    await NodeFSP.realpath(library.root),
    journal.instanceId,
  );
  for (const sourceId of expected.sourceIds) {
    const runs = Array.from({ length: journal.run }, (_, index) => String(index + 1));
    const kept = await Promise.all(
      runs.map((run) => exists(NodePath.join(backup, run, "sources/records", `${sourceId}.json`))),
    );
    expect(kept.some(Boolean), sourceId).toBe(true);
  }
  return journal;
}

async function seededMove() {
  const base = await fixture();
  const library = await newLibrary(base);
  const project = await newProject(base);
  const seeded = await seed(project);
  return { base, library, project, ...seeded };
}

describe("the move", () => {
  it("moves a project in one run: records, PDF, note on the pin, review, collection, highlight", async () => {
    const { library, project, a, b, c, reviewId, sha256 } = await seededMove();
    const result = await move(library, project);
    expect(result.outcome).toBe("moved");
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });

    const pins = await readScientProjectPins(project);
    expect(pins.find((pin) => pin.sourceId === a.sourceId)?.note).toBe("Why this project cites A.");
    const moved = (await readScientSourceRecord(library, a.sourceId))!;
    expect(moved.formatVersion).toBe(2);
    expect(moved.note).toBeUndefined();
    expect(
      await exists(
        NodePath.join(library.root, "files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
      ),
    ).toBe(true);
    expect(await exists(NodePath.join(library.root, "history", b.sourceId, "1.json"))).toBe(true);
    expect(await exists(NodePath.join(library.root, "trash", `${c.sourceId}.json`))).toBe(true);
    expect(await exists(NodePath.join(library.root, "annotations/v1", `${sha256}.json`))).toBe(
      true,
    );
    expect(await exists(NodePath.join(project, ".scient/annotations/v1"))).toBe(false);
    const collections = await NodeFSP.readdir(NodePath.join(library.root, "collections"));
    expect(collections).toHaveLength(1);
    const records = await listScientLibraryReviewRecords({
      projectRoot: project,
      library: null,
      mode: "read",
      reviewId,
    });
    expect(records?.map((record) => record.from)).toEqual(["snapshot", "snapshot"]);
    expect(
      await NodeFSP.readFile(
        NodePath.join(project, ".scient/library/bibliography/references.bib"),
        "utf8",
      ),
    ).toBe("v1 references.bib\n");
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).moved).toBe(true);
  });

  it("says to commit the change only when git tracks .scient/sources", async () => {
    const { library, project } = await seededMove();
    const tracked = await runScientLibraryMove({
      library,
      projectRoot: project,
      actor: "user",
      gitTracked: async () => true,
    });
    expect(scientLibraryMoveStatusLines(tracked.journal)).toContain(
      "The Library moved out of this project. Commit the change to stop storing PDFs in git.",
    );
    const other = await seededMove();
    const untracked = await move(other.library, other.project);
    expect(scientLibraryMoveStatusLines(untracked.journal, other.library.root)).toEqual([
      `Your Library is in ${other.library.root}.`,
      `A copy of this project's sources from before the move is kept in .scient/library/retained-before-library/${untracked.journal!.runId}.`,
    ]);
  });

  it("does nothing on a project with no v1 store, and writes no journal", async () => {
    const base = await fixture();
    const library = await newLibrary(base);
    const project = await newProject(base);
    expect((await move(library, project)).outcome).toBe("not-needed");
    expect(await exists(NodePath.join(library.root, "migrations"))).toBe(false);
  });
});

describe("a moved name the library already has", () => {
  it("fits a long project title, keeps the bracket and number, and names each clash apart", () => {
    const title = `${"A".repeat(189)} ${"B".repeat(10)}`;
    const taken = new Set(["methods"]);
    const names = Array.from({ length: 12 }, () => {
      const name = scientLibraryMoveInternals.uniqueName("Methods", taken, title);
      taken.add(name.toLocaleLowerCase());
      return name;
    });
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(SCIENT_SOURCE_NAME_LIMIT);
      expect(name).toBe(name.trim());
      expect(name).toMatch(/^Methods \(A+( B+)?( \d+)?\)$/);
    }
    expect(names[11]).toMatch(/ 12\)$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never cuts a character made of two code units in half", () => {
    const loneHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const title = `${"A".repeat(189)}🌊${"B".repeat(9)}`;
    const taken = new Set(["methods"]);
    for (let index = 0; index < 12; index += 1) {
      const name = scientLibraryMoveInternals.uniqueName("Methods", taken, title);
      expect(name).not.toMatch(loneHalf);
      expect(name.length).toBeLessThanOrEqual(SCIENT_SOURCE_NAME_LIMIT);
      taken.add(name.toLocaleLowerCase());
    }
    const long = `${"C".repeat(196)}🌊`;
    expect(
      scientLibraryMoveInternals.uniqueName(long, new Set([long.toLocaleLowerCase()]), "🌊"),
    ).not.toMatch(loneHalf);
  });
});

describe("crash tests: each crash, then a rerun that ends in done with nothing lost", () => {
  it("crash-after-library-copy", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    const journal = await crashAt(library, project, { crashAt: "after-library-copy" });
    expect(journal.state).toBe("copying");
    expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(false);
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("crash-after-verify-before-stage", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    expect((await crashAt(library, project, { crashAt: "after-verify" })).state).toBe("copying");
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("crash-after-stage-before-prepared", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    expect((await crashAt(library, project, { crashAt: "after-stage" })).state).toBe("copying");
    expect(await exists(NodePath.join(project, ".scient/library/.staging"))).toBe(true);
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect(await exists(NodePath.join(project, ".scient/library/.staging"))).toBe(false);
  });

  it("crash-after-prepared-before-pins", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    expect((await crashAt(library, project, { crashAt: "after-prepared" })).state).toBe("prepared");
    expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(false);
    expect(await exists(NodePath.join(project, ".scient/sources/records"))).toBe(true);
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("crash-right-after-pins-published", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    const journal = await crashAt(library, project, { crashAt: "after-pins-published" });
    expect(journal.state).toBe("prepared");
    const pins = await NodeFSP.readFile(NodePath.join(project, ".scient/library/pins.json"));
    expect(sha(pins)).toBe(
      journal.artifacts.find((artifact) => artifact.kind === "pins")!.stagedSha256,
    );
    // Prepared is not committed: nothing of v1 is gone yet.
    expect(await exists(NodePath.join(project, ".scient/sources/records"))).toBe(true);
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("crash-partial-pins-copy-fallback (link refused, copy interrupted)", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    const journal = await crashAt(library, project, { refuseLinks: true, interruptPinsCopy: true });
    expect(journal.state).toBe("prepared");
    const partial = await NodeFSP.readFile(
      NodePath.join(project, ".scient/library/pins.json"),
      "utf8",
    );
    expect(() => JSON.parse(partial)).toThrow();
    expect(await exists(NodePath.join(project, ".scient/sources/records"))).toBe(true);
    await move(library, project, { refuseLinks: true });
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("crash-mid-cleanup, and an open PDF stays listed until a later open deletes it", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    const journal = await crashAt(library, project, { crashAt: "mid-cleanup" });
    expect(journal.state).toBe("cleanup");
    expect(journal.cleanup.length).toBeGreaterThan(0);
    const held = await move(library, project, { undeletable: (path) => path.endsWith(".pdf") });
    expect(held.journal?.state).toBe("cleanup");
    expect(held.journal?.retry.some((path) => path.endsWith(".pdf"))).toBe(true);
    await move(library, project);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
  });

  it("pulled-pins-with-local-v1-store: joins, never deletes before its own commit", async () => {
    const { base, library, a, b, reviewId } = await seededMove();
    // Checkout A moves; checkout B is a copy made before that, with its own v1 store.
    const projectA = NodePath.join(base, "project");
    const projectB = NodePath.join(base, "copy");
    await NodeFSP.cp(projectA, projectB, { recursive: true });
    const onlyB = await add(projectB, "b-only", { title: "Only in B" });
    await move(library, projectA);
    // B pulls A's moved files.
    await NodeFSP.cp(
      NodePath.join(projectA, ".scient/library"),
      NodePath.join(projectB, ".scient/library"),
      {
        recursive: true,
      },
    );
    // A pins.json alone never authorizes cleanup: crash B before it commits.
    await crashAt(library, projectB, { crashAt: "after-prepared" });
    expect(
      await exists(NodePath.join(projectB, ".scient/sources/records", `${onlyB.sourceId}.json`)),
    ).toBe(true);
    await move(library, projectB);
    await expectDone(library, projectB, {
      sourceIds: [a.sourceId, b.sourceId, onlyB.sourceId],
      reviewIds: [reviewId],
    });
    const keys = (await readScientProjectPins(projectB)).map((pin) => pin.citationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("copied-checkout-diverged: both versions kept, each checkout resolves its own", async () => {
    const { base, library, project, a, b } = await seededMove();
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(project, copy, { recursive: true });
    await editTitle(project, b.sourceId, "Edited in A");
    await editTitle(copy, b.sourceId, "Edited in B");
    await move(library, project);
    const result = await move(library, copy);
    expect(result.journal?.divergedSources).toBe(1);
    await expectDone(library, copy, { sourceIds: [a.sourceId, b.sourceId], reviewIds: [] });
    const resolved = async (root: string) =>
      (
        await resolveScientProjectPins({ projectRoot: root, library, mode: "read", actor: "user" })
      ).find(({ pin }) => pin.sourceId === b.sourceId)!.resolution;
    const inA = await resolved(project);
    const inB = await resolved(copy);
    expect(
      inA.kind === "resolved" && inB.kind === "resolved" && inA.sourceId !== inB.sourceId,
    ).toBe(true);
    if (inA.kind !== "resolved" || inB.kind !== "resolved") return;
    expect((await readScientSourceRecord(library, inA.sourceId))?.title).toBe("Edited in A");
    expect((await readScientSourceRecord(library, inB.sourceId))?.title).toBe("Edited in B");
    const pairs = JSON.parse(
      await NodeFSP.readFile(NodePath.join(library.root, "distinct-pairs.json"), "utf8"),
    );
    expect(pairs.pairs.map((pair: { reason: string }) => pair.reason)).toEqual([
      "divergent-copies",
    ]);
  });

  it("rerun-after-pre-switch-crash-same-ids: existing records are compared, never overwritten", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    await crashAt(library, project, { crashAt: "after-prepared" });
    const recordPath = NodePath.join(library.root, "records", `${a.sourceId}.json`);
    const before = await NodeFSP.stat(recordPath, { bigint: true });
    await move(library, project);
    const after = await NodeFSP.stat(recordPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await listScientSourceRecords(library)).length).toBe(2);
  });

  it("a same-ID library record with other content is never overwritten", async () => {
    const { library, project, b } = await seededMove();
    const foreign = NodePath.join(library.root, "records", `${b.sourceId}.json`);
    const record = (await readScientSourceRecord(project, b.sourceId))!;
    const { projectId: _project, note: _note, ...rest } = record;
    const planted = { ...rest, formatVersion: 2, revision: 7, title: "Someone else's edit" };
    await NodeFSP.mkdir(NodePath.dirname(foreign), { recursive: true });
    await NodeFSP.writeFile(foreign, `${JSON.stringify(planted, null, 2)}\n`);
    const bytes = await NodeFSP.readFile(foreign);
    await move(library, project);
    expect((await NodeFSP.readFile(foreign)).equals(bytes)).toBe(true);
  });

  it("join-pulled-newer-review-with-local-v1", async () => {
    const { base, library, project: projectA, a, b, reviewId } = await seededMove();
    const projectB = NodePath.join(base, "copy");
    await NodeFSP.cp(projectA, projectB, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(projectB, ".scient/sources/bibliography/references.bib"),
      "B's copy\n",
    );
    // A screens further, then moves.
    await screen(projectA, reviewId, b.sourceId, "exclude");
    await move(library, projectA);
    const moved = NodePath.join(projectA, ".scient/library");
    const aFiles = Object.fromEntries(
      await Promise.all(
        [
          `reviews/${reviewId}.json`,
          `reviews/${reviewId}.works.json`,
          "bibliography/references.bib",
        ].map(
          async (file) => [file, sha(await NodeFSP.readFile(NodePath.join(moved, file)))] as const,
        ),
      ),
    );
    await NodeFSP.cp(moved, NodePath.join(projectB, ".scient/library"), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(projectA, "references.bib"),
      NodePath.join(projectB, "references.bib"),
    );
    await move(library, projectB);
    const journal = await expectDone(library, projectB, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    for (const [file, hash] of Object.entries(aFiles)) {
      expect(
        sha(await NodeFSP.readFile(NodePath.join(projectB, ".scient/library", file))),
        file,
      ).toBe(hash);
    }
    expect(journal.reviewConflicts).toEqual([reviewId]);
    const [conflict] = await listScientReviewConflicts({ projectRoot: projectB, reviewId });
    expect(conflict!.review.screening.some((entry) => entry.sourceId === b.sourceId)).toBe(false);
    const inForce = await readScientLibraryReview({
      projectRoot: projectB,
      library,
      mode: "read",
      reviewId,
    });
    expect(inForce?.prisma.titleAbstract.excluded).toBeGreaterThan(0);
    // B's own bibliography copy is not lost: the backup keeps it.
    const backup = scientLibraryMoveInternals.backupRoot(
      await NodeFSP.realpath(library.root),
      journal.instanceId,
    );
    expect(
      await NodeFSP.readFile(
        NodePath.join(backup, "1/sources/bibliography/references.bib"),
        "utf8",
      ),
    ).toBe("B's copy\n");
  });

  it("repeat-move-after-older-client-write", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    await move(library, project);
    const v2Review = await NodeFSP.readFile(
      NodePath.join(project, `.scient/library/reviews/${reviewId}.json`),
    );
    const pinsBefore = await readScientProjectPins(project);
    // An older Scient sees an empty Library: it adds a source, writes the old review again with a
    // new decision, and creates another review.
    const added = await add(project, "older", { title: "Added by an older Scient" });
    const oldReview = JSON.parse(v2Review.toString("utf8"));
    oldReview.screening.push({
      sourceId: b.sourceId,
      stage: "title-abstract",
      decision: "include",
      decidedAt: "2026-11-12T00:00:00.000Z",
      decidedBy: "user",
    });
    await NodeFSP.mkdir(NodePath.join(project, ".scient/sources/reviews"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(project, `.scient/sources/reviews/${reviewId}.json`),
      `${JSON.stringify(oldReview, null, 2)}\n`,
    );
    const second = await review(project, "Second review", [added.sourceId]);
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).v1Present).toBe(
      true,
    );

    const result = await move(library, project);
    expect(result.journal?.run).toBe(2);
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId, added.sourceId],
      reviewIds: [reviewId, second],
    });
    expect(
      (
        await NodeFSP.readFile(NodePath.join(project, `.scient/library/reviews/${reviewId}.json`))
      ).equals(v2Review),
    ).toBe(true);
    expect((await listScientReviewConflicts({ projectRoot: project, reviewId })).length).toBe(1);
    const pinsAfter = await readScientProjectPins(project);
    for (const pin of pinsBefore) {
      expect(pinsAfter.find((entry) => entry.sourceId === pin.sourceId)?.citationKey).toBe(
        pin.citationKey,
      );
    }
  });

  it("combine-incoming-only-search, on an empty library and after copying the project", async () => {
    const base = await fixture();
    const library = await newLibrary(base);
    const projectA = await newProject(base);
    const a = await add(projectA, "a");
    const reviewId = await review(projectA, "Review", [a.sourceId]);
    const projectB = NodePath.join(base, "copy");
    await NodeFSP.cp(projectA, projectB, { recursive: true });
    // B: a second search with its own source B, screened; and a pair marked differently.
    const sourceB = await add(projectB, "b-source", { title: "Found by B" });
    const extra = await add(projectB, "extra", { title: "Extra" });
    await changeScientSystematicReview({
      root: projectB,
      change: {
        action: "log-search",
        reviewId,
        database: "Embase",
        query: "b",
        searchedOn: "2026-11-02",
        sourceIds: [sourceB.sourceId, extra.sourceId],
      },
      actor: "user",
    });
    await screen(projectB, reviewId, sourceB.sourceId, "include");
    await changeScientSystematicReview({
      root: projectB,
      change: { action: "mark-distinct", reviewId, sourceIds: [sourceB.sourceId, extra.sourceId] },
      actor: "user",
    });
    await changeScientSystematicReview({
      root: projectA,
      change: { action: "add-sources", reviewId, sourceIds: [a.sourceId] },
      actor: "user",
    });
    await move(library, projectA);
    await NodeFSP.cp(
      NodePath.join(projectA, ".scient/library"),
      NodePath.join(projectB, ".scient/library"),
      {
        recursive: true,
      },
    );
    // A's version marks the same pair duplicate.
    const aReviewPath = NodePath.join(projectB, `.scient/library/reviews/${reviewId}.json`);
    const aReview = JSON.parse(await NodeFSP.readFile(aReviewPath, "utf8"));
    aReview.duplicates.push({
      sourceId: extra.sourceId,
      duplicateOf: sourceB.sourceId,
      decidedAt: "2026-11-03T00:00:00.000Z",
      decidedBy: "user",
    });
    await NodeFSP.writeFile(aReviewPath, `${JSON.stringify(aReview, null, 2)}\n`);
    await move(library, projectB);
    const [conflict] = await listScientReviewConflicts({ projectRoot: projectB, reviewId });

    // Combine where this computer's library is empty: everything comes from the snapshots.
    const empty = await newLibrary(base, "other-state");
    const copied = NodePath.join(base, "copied-again");
    await NodeFSP.cp(projectB, copied, { recursive: true });
    // A pick made against a version that is no longer in force changes nothing.
    const pickAt = (root: string, expectedRevision: string) =>
      resolveScientReviewConflict({
        projectRoot: root,
        library: empty,
        reviewId,
        conflictId: conflict!.conflictId,
        pick: "combine",
        actor: "user",
        expectedRevision,
      });
    expect((await pickAt(projectB, "0000000000000000")).outcome).toBe("version-changed");
    expect(await listScientReviewConflicts({ projectRoot: projectB, reviewId })).toHaveLength(1);
    for (const root of [projectB, copied]) {
      const inForce = await readScientReviewVersions({ projectRoot: root, reviewId });
      const resolved = await pickAt(root, inForce.currentRevision!);
      expect(resolved.outcome).toBe("resolved");
      if (resolved.outcome !== "resolved") return;
      expect(resolved.report?.undecidedPairs.map((pair) => [...pair].toSorted())).toEqual([
        [sourceB.sourceId, extra.sourceId].toSorted(),
      ]);
      const detail = await readScientLibraryReview({
        projectRoot: root,
        library: empty,
        mode: "read",
        reviewId,
      });
      expect(detail?.review.searches.map((search) => search.database).toSorted()).toEqual([
        "Embase",
        "PubMed",
      ]);
      const records = await listScientLibraryReviewRecords({
        projectRoot: root,
        library: empty,
        mode: "read",
        reviewId,
      });
      expect(records?.find((record) => record.projectSourceId === sourceB.sourceId)?.from).toBe(
        "snapshot",
      );
      expect(detail?.prisma.titleAbstract.included).toBeGreaterThan(0);
      expect(await listScientReviewConflicts({ projectRoot: root, reviewId })).toEqual([]);
    }
  });

  it("combine reopens a record the two copies decided differently", async () => {
    const { combineScientReviews } = await import("./libraryReviewConflicts.ts");
    const base = {
      formatVersion: 1 as const,
      reviewId: "review_1",
      title: "R",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "user" as const,
      searches: [],
      otherSourceIds: ["s1"],
      duplicates: [],
      distinctPairs: [],
      exclusionReasons: [],
    };
    const decided = (decision: "include" | "exclude") => ({
      ...base,
      screening: [
        {
          sourceId: "s1",
          stage: "title-abstract" as const,
          decision,
          decidedAt: `2026-01-0${decision === "include" ? 2 : 3}T00:00:00.000Z`,
          decidedBy: "user" as const,
        },
      ],
    });
    const { review: combined } = combineScientReviews({
      existing: decided("include"),
      incoming: decided("exclude"),
      actor: "agent",
      now: "2026-02-01T00:00:00.000Z",
    });
    const last = combined.screening.at(-1)!;
    expect(last.cleared).toBe(true);
    expect(last.note).toBe(SCIENT_REVIEW_COMBINED_NOTE);
  });
});

/** Full text named by the seeded PDF's hash, in the project and (when given) in the library. */
async function seedFullText(
  library: ScientLibraryLocation,
  project: string,
  sha256: string,
  libraryText?: (projectText: Buffer) => Buffer,
) {
  const relative = `text/sha256/${sha256.slice(0, 2)}/${sha256}.json`;
  const projectText = Buffer.from(
    `${JSON.stringify({ formatVersion: 1, pages: ["Page one of the study.", "Page two."] })}\n`,
  );
  await NodeFSP.mkdir(NodePath.dirname(NodePath.join(project, ".scient/sources", relative)), {
    recursive: true,
  });
  await NodeFSP.writeFile(NodePath.join(project, ".scient/sources", relative), projectText);
  const libraryPath = NodePath.join(library.root, relative);
  if (libraryText) {
    await NodeFSP.mkdir(NodePath.dirname(libraryPath), { recursive: true });
    await NodeFSP.writeFile(libraryPath, libraryText(projectText));
  }
  return { relative, projectText, libraryPath };
}

describe("full text named by a PDF hash", () => {
  it("a library text file cut short is copied again before the project text is deleted", async () => {
    const { library, project, a, b, reviewId, sha256 } = await seededMove();
    const { projectText, libraryPath } = await seedFullText(library, project, sha256, (text) =>
      text.subarray(0, Math.floor(text.length / 2)),
    );
    expect((await move(library, project)).outcome).toBe("moved");
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await NodeFSP.readFile(libraryPath)).equals(projectText)).toBe(true);
  });

  it("a different library text file stays, and the project text is deleted only from the backup", async () => {
    const { library, project, a, b, reviewId, sha256 } = await seededMove();
    const other = Buffer.from(
      `${JSON.stringify({ formatVersion: 1, pages: ["Another extraction."] })}\n`,
    );
    const { relative, projectText, libraryPath } = await seedFullText(
      library,
      project,
      sha256,
      () => other,
    );
    expect((await move(library, project)).outcome).toBe("moved");
    const journal = await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await NodeFSP.readFile(libraryPath)).equals(other)).toBe(true);
    const backup = scientLibraryMoveInternals.backupRoot(
      await NodeFSP.realpath(library.root),
      journal.instanceId,
    );
    const kept = await NodeFSP.readFile(NodePath.join(backup, "1/sources", relative));
    expect(kept.equals(projectText)).toBe(true);
  });

  // regression: review M3-5d-2, a whole extraction that starts the project's text is not a cut copy
  it("library text that is whole JSON and starts the project text stays in force", async () => {
    const { library, project, a, b, reviewId, sha256 } = await seededMove();
    const { relative, projectText, libraryPath } = await seedFullText(
      library,
      project,
      sha256,
      (text) => text.subarray(0, text.length - 1),
    );
    const kept = await NodeFSP.readFile(libraryPath);
    expect((await move(library, project)).outcome).toBe("moved");
    const journal = await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await NodeFSP.readFile(libraryPath)).equals(kept)).toBe(true);
    const backup = scientLibraryMoveInternals.backupRoot(
      await NodeFSP.realpath(library.root),
      journal.instanceId,
    );
    expect(
      (await NodeFSP.readFile(NodePath.join(backup, "1/sources", relative))).equals(projectText),
    ).toBe(true);
  });

  it("library text replaced after the backup step is backed up at cleanup, not left behind", async () => {
    const { library, project, a, b, reviewId, sha256 } = await seededMove();
    const { relative, projectText, libraryPath } = await seedFullText(library, project, sha256);
    await expect(move(library, project, { crashAt: "after-prepared" })).rejects.toBeInstanceOf(
      ScientLibraryMoveCrash,
    );
    const other = Buffer.from(
      `${JSON.stringify({ formatVersion: 1, pages: ["Re-extracted."] })}\n`,
    );
    await NodeFSP.writeFile(libraryPath, other);
    expect((await move(library, project)).outcome).toBe("moved");
    const journal = await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await NodeFSP.readFile(libraryPath)).equals(other)).toBe(true);
    const backup = scientLibraryMoveInternals.backupRoot(
      await NodeFSP.realpath(library.root),
      journal.instanceId,
    );
    expect(
      (await NodeFSP.readFile(NodePath.join(backup, "1/sources", relative))).equals(projectText),
    ).toBe(true);
  });
});
/** The bar after an interrupted move back finishes: v1 rebuilt with the later edit, no pins. */
async function expectMovedBack(
  library: ScientLibraryLocation,
  project: string,
  seeded: {
    readonly a: { sourceId: string };
    readonly b: { sourceId: string };
    readonly sha256: string;
  },
  run: number,
) {
  const journal = await journalOf(library, project);
  expect(journal.state).toBe("moved-back");
  expect(journal.run).toBe(run);
  expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(false);
  expect((await listScientSourceRecords(project)).length).toBe(2);
  expect((await readScientSourceRecord(project, seeded.b.sourceId))?.title).toBe(
    "Edited in the library",
  );
  expect((await readScientSourceRecord(project, seeded.a.sourceId))?.note).toBe(
    "Why this project cites A.",
  );
  const { sha256 } = seeded;
  expect(
    await exists(
      NodePath.join(project, ".scient/sources/files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
    ),
  ).toBe(true);
  expect((await readScientLibraryMoveState({ library, projectRoot: project })).moved).toBe(false);
  expect((await move(library, project)).outcome).toBe("moved-back");
  expect((await journalOf(library, project)).run).toBe(run);
}

describe("move back into this project", () => {
  it("rebuilds the v1 store with a later edit, copies the PDF back and removes pins.json", async () => {
    const { library, project, a, b, sha256 } = await seededMove();
    await move(library, project);
    await editTitle(library, b.sourceId, "Edited in the library");
    const result = await moveScientProjectBackIntoProject({
      library,
      projectRoot: project,
      actor: "user",
    });
    expect(result).toMatchObject({ outcome: "moved-back", restoredSources: 2, restoredPdfs: 1 });
    expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(false);
    expect((await readScientSourceRecord(project, b.sourceId))?.title).toBe(
      "Edited in the library",
    );
    expect((await readScientSourceRecord(project, a.sourceId))?.note).toBe(
      "Why this project cites A.",
    );
    expect(
      await exists(
        NodePath.join(project, ".scient/sources/files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
      ),
    ).toBe(true);
    expect((await listScientSourceRecords(project)).length).toBe(2);
    // Library records stay; the move does not run again on its own.
    expect(await readScientSourceRecord(library, a.sourceId)).not.toBeNull();
    expect((await move(library, project)).outcome).toBe("moved-back");
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).moved).toBe(false);
    expect((await readLibraryAliasesAt(await NodeFSP.realpath(library.root))).size).toBe(0);
  });

  it("crash after the backups are restored: a retried move back finishes it", async () => {
    const seeded = await seededMove();
    const { library, project, b } = seeded;
    await move(library, project);
    const { run } = await journalOf(library, project);
    await editTitle(library, b.sourceId, "Edited in the library");
    const back = (faults?: ScientLibraryMoveFaults) =>
      moveScientProjectBackIntoProject({
        library,
        projectRoot: project,
        actor: "user",
        ...(faults ? { faults } : {}),
      });
    await expect(back({ crashAt: "after-restore-backups" })).rejects.toBeInstanceOf(
      ScientLibraryMoveCrash,
    );
    expect((await journalOf(library, project)).state).toBe("restoring");
    // The store is still in the staging folder: nothing is published before it is whole.
    expect(await exists(NodePath.join(project, ".scient/sources"))).toBe(false);
    expect(await exists(NodePath.join(project, ".scient/library/.restoring/sources/records"))).toBe(
      true,
    );
    expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(true);
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).moved).toBe(true);
    expect(await back()).toMatchObject({ outcome: "moved-back", restoredSources: 2 });
    await expectMovedBack(library, project, seeded, run);
  });

  it("crash before the final journal write: the next write finishes the move back, not a move", async () => {
    const seeded = await seededMove();
    const { library, project, b } = seeded;
    await move(library, project);
    const { run } = await journalOf(library, project);
    await editTitle(library, b.sourceId, "Edited in the library");
    await expect(
      moveScientProjectBackIntoProject({
        library,
        projectRoot: project,
        actor: "user",
        faults: { crashAt: "before-moved-back" },
      }),
    ).rejects.toBeInstanceOf(ScientLibraryMoveCrash);
    expect((await journalOf(library, project)).state).toBe("restoring");
    expect(await exists(NodePath.join(project, ".scient/library/pins.json"))).toBe(false);
    // The lazy move a write runs, and the background pass, finish the restore.
    expect((await move(library, project)).outcome).toBe("moved-back");
    await expectMovedBack(library, project, seeded, run);
    expect(
      await moveScientProjectBackIntoProject({ library, projectRoot: project, actor: "user" }),
    ).toEqual({ outcome: "not-moved" });
  });

  // regression: review M3-5d-2, a resumed move back replaced files changed since the restore
  it("changes made to the restored store before the move back resumes are kept", async () => {
    const seeded = await seededMove();
    const { library, project, a, b, reviewId } = seeded;
    await move(library, project);
    const { run } = await journalOf(library, project);
    await editTitle(library, b.sourceId, "Edited in the library");
    await expect(
      moveScientProjectBackIntoProject({
        library,
        projectRoot: project,
        actor: "user",
        faults: { crashAt: "before-moved-back" },
      }),
    ).rejects.toBeInstanceOf(ScientLibraryMoveCrash);
    // An older Scient opens the restored store and writes to it.
    const review = NodePath.join(project, ".scient/sources/reviews", `${reviewId}.json`);
    const decided = Buffer.concat([await NodeFSP.readFile(review), Buffer.from("\n")]);
    await NodeFSP.writeFile(review, decided);
    await updateScientSourceNote({
      root: project,
      sourceId: a.sourceId,
      expectedRevision: (await readScientSourceRecord(project, a.sourceId))!.revision,
      note: "Written by an older Scient.",
    });
    expect((await move(library, project)).outcome).toBe("moved-back");
    expect((await journalOf(library, project)).run).toBe(run);
    expect((await NodeFSP.readFile(review)).equals(decided)).toBe(true);
    expect((await readScientSourceRecord(project, a.sourceId))?.note).toBe(
      "Written by an older Scient.",
    );
    expect((await readScientSourceRecord(project, b.sourceId))?.title).toBe(
      "Edited in the library",
    );
  });

  it("a store an older Scient writes while the move back is interrupted stops the move back", async () => {
    const { library, project } = await seededMove();
    await move(library, project);
    const back = (faults?: ScientLibraryMoveFaults) =>
      moveScientProjectBackIntoProject({
        library,
        projectRoot: project,
        actor: "user",
        ...(faults ? { faults } : {}),
      });
    await expect(back({ crashAt: "after-restore-backups" })).rejects.toBeInstanceOf(
      ScientLibraryMoveCrash,
    );
    const added = await add(project, "C");
    expect(await back()).toEqual({ outcome: "project-store-present" });
    expect((await journalOf(library, project)).state).toBe("done");
    expect(await exists(NodePath.join(project, ".scient/library/.restoring"))).toBe(false);
    expect((await readScientSourceRecord(project, added.sourceId))?.title).toBe("Study C");
    // The ordinary move then joins what the older Scient wrote.
    expect((await move(library, project)).outcome).toBe("moved");
    expect((await readScientProjectPins(project)).length).toBe(3);
  });
});

/** A file-copy hook that holds the first copy until `release` is called. */
function pauseAtFirstFileCopy() {
  let paused!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const beforeFileCopy = async () => {
    if (!first) return;
    first = false;
    paused();
    await gate;
  };
  return { reached, release, beforeFileCopy };
}

describe("the library lock during a move", () => {
  it("another library writer completes while the move copies files", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    // A record that only the library holds, edited mid-move by another writer.
    const outside = await importScientSource({
      root: library,
      operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      candidate: candidate("outside", { title: "In the library already" }),
      actor: "user",
      intake: "file",
    });
    const pause = pauseAtFirstFileCopy();
    const progress: ScientLibraryMoveProgress[] = [];
    const moving = runScientLibraryMove({
      library,
      projectRoot: project,
      actor: "user",
      faults: { beforeFileCopy: pause.beforeFileCopy },
      onProgress: (entry) => progress.push(entry),
    });
    await pause.reached;
    expect(progress.at(-1)).toMatchObject({ phase: "files", done: 0 });
    // Free right now, not after the move: a try that does not wait at all gets the lock.
    expect(await withScientLibraryLock(library.root, async () => "held", { timeoutMs: 0 })).toBe(
      "held",
    );
    await editTitle(library, outside.record!.sourceId, "Edited during the move");
    pause.release();
    const moved = await moving;
    expect(moved.outcome).toBe("moved");
    // The check counts the records, v1 files and highlights it backs up, not only the PDFs.
    const checking = progress.filter((entry) => entry.phase === "verifying").at(-1)!;
    expect(checking.done).toBe(checking.total);
    expect(checking.total).toBeGreaterThan(
      moved.journal!.pdfs.length + moved.journal!.sources.length,
    );
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await readScientSourceRecord(library, outside.record!.sourceId))?.title).toBe(
      "Edited during the move",
    );
  });

  it("crash-after-first-batch: an edit made in the gap is kept, and the rerun finishes", async () => {
    const { library, project, a, b, reviewId } = await seededMove();
    const journal = await crashAt(library, project, {
      crashAt: "after-first-batch",
      batchSize: 1,
    });
    expect(journal.state).toBe("copying");
    const first = [a.sourceId, b.sourceId].toSorted()[0]!;
    expect(await readScientSourceRecord(library, first)).not.toBeNull();
    // Between holds of the library lock, another writer edits the record the move just copied.
    await editTitle(library, first, "Edited between batches");
    await move(library, project, { batchSize: 1 });
    await expectDone(library, project, {
      sourceIds: [a.sourceId, b.sourceId],
      reviewIds: [reviewId],
    });
    expect((await readScientSourceRecord(library, first))?.title).toBe("Edited between batches");
    expect((await listScientSourceRecords(library)).length).toBe(2);
  });

  it("the move back restores a library edit and a PDF added while its PDFs were copied", async () => {
    const { base, library, project, b, sha256 } = await seededMove();
    await move(library, project);
    const pause = pauseAtFirstFileCopy();
    const movingBack = moveScientProjectBackIntoProject({
      library,
      projectRoot: project,
      actor: "user",
      faults: { beforeFileCopy: pause.beforeFileCopy },
    });
    await pause.reached;
    const edited = await editTitle(library, b.sourceId, "Edited while the PDFs came back");
    const pdf = NodePath.join(base, "added-in-the-gap.pdf");
    await NodeFSP.writeFile(pdf, "%PDF-1.7\nadded in the gap\n", "utf8");
    const attached = await attachScientSourcePdf({
      root: library,
      sourceId: b.sourceId,
      expectedRevision: edited.record.revision,
      pdfPath: pdf,
    });
    pause.release();
    expect(await movingBack).toMatchObject({ outcome: "moved-back", restoredPdfs: 2 });
    const restored = await readScientSourceRecord(project, b.sourceId);
    expect(restored?.title).toBe("Edited while the PDFs came back");
    for (const hash of [sha256, attached.record.attachments[0]!.sha256]) {
      expect(
        await exists(
          NodePath.join(project, ".scient/sources/files/sha256", hash.slice(0, 2), `${hash}.pdf`),
        ),
      ).toBe(true);
    }
  });

  it("the move back brings highlights made while moved into the project, the library keeps them", async () => {
    const { library, project, sha256 } = await seededMove();
    await move(library, project);
    const libraryFile = NodePath.join(library.root, "annotations/v1", `${sha256}.json`);
    const write = async (annotations: ReadonlyArray<object>) =>
      NodeFSP.writeFile(
        libraryFile,
        JSON.stringify({
          formatVersion: 1,
          material: { sha256, byteLength: 10 },
          paths: [],
          annotations,
          history: [],
        }),
      );
    await write([{ annotationId: "ann_1", revision: 2, highlighted: true, note: "Edited" }]);
    const pause = pauseAtFirstFileCopy();
    const movingBack = moveScientProjectBackIntoProject({
      library,
      projectRoot: project,
      actor: "user",
      faults: { beforeFileCopy: pause.beforeFileCopy },
    });
    await pause.reached;
    // Made while the PDFs come back, with the library lock free: read again in the last hold.
    await write([
      { annotationId: "ann_1", revision: 2, highlighted: true, note: "Edited" },
      { annotationId: "ann_2", revision: 1, highlighted: true, note: "Added while moved" },
    ]);
    pause.release();
    expect((await movingBack).outcome).toBe("moved-back");
    const restored = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(project, ".scient/annotations/v1", `${sha256}.json`),
        "utf8",
      ),
    );
    expect(
      restored.annotations.map((entry: { annotationId: string; revision: number }) => [
        entry.annotationId,
        entry.revision,
      ]),
    ).toEqual([
      ["ann_1", 2],
      ["ann_2", 1],
    ]);
    expect(await exists(libraryFile)).toBe(true);
  });

  it("the move back keeps and counts a record removed from the library while its PDFs were copied", async () => {
    const { library, project, a, sha256 } = await seededMove();
    await move(library, project);
    const pause = pauseAtFirstFileCopy();
    const movingBack = moveScientProjectBackIntoProject({
      library,
      projectRoot: project,
      actor: "user",
      faults: { beforeFileCopy: pause.beforeFileCopy },
    });
    await pause.reached;
    const inLibrary = (await readScientSourceRecord(library, a.sourceId))!;
    await removeScientSource({
      root: library,
      sourceId: a.sourceId,
      expectedRevision: inLibrary.revision,
    });
    pause.release();
    expect(await movingBack).toMatchObject({
      outcome: "moved-back",
      restoredSources: 2,
      restoredPdfs: 1,
    });
    expect(await readScientSourceRecord(project, a.sourceId)).not.toBeNull();
    expect(
      await exists(
        NodePath.join(project, ".scient/sources/files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
      ),
    ).toBe(true);
  });

  it("the move back copies its PDFs with the library lock free", async () => {
    const { library, project, sha256 } = await seededMove();
    await move(library, project);
    const pause = pauseAtFirstFileCopy();
    const movingBack = moveScientProjectBackIntoProject({
      library,
      projectRoot: project,
      actor: "user",
      faults: { beforeFileCopy: pause.beforeFileCopy },
    });
    await pause.reached;
    expect(await withScientLibraryLock(library.root, async () => "held", { timeoutMs: 0 })).toBe(
      "held",
    );
    pause.release();
    expect(await movingBack).toMatchObject({ outcome: "moved-back", restoredPdfs: 1 });
    expect(
      await exists(
        NodePath.join(project, ".scient/sources/files/sha256", sha256.slice(0, 2), `${sha256}.pdf`),
      ),
    ).toBe(true);
  });
});

describe("the sealed copy from before the move", () => {
  const manifestOf = async (project: string, journal: ScientLibraryMoveJournal) =>
    JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(project, journal.archive!.path, "manifest.json"),
        "utf8",
      ),
    );

  it("keeps the evidence, is never read by the Library, and restores with no move journal", async () => {
    const { base, library, project, a, b, sha256 } = await seededMove();
    const pdfBytes = await NodeFSP.readFile(
      NodePath.join(NodePath.dirname(project), `${NodePath.basename(project)}-a.pdf`),
    );
    const { journal } = await move(library, project);
    const archive = NodePath.join(project, journal!.archive!.path);
    const manifest = await manifestOf(project, journal!);
    expect(manifest.counts).toMatchObject({
      records: 2,
      trash: 1,
      pdfs: 1,
      annotations: 1,
      reviews: 1,
    });
    expect(manifest.missing).toEqual([]);
    const pdf = manifest.files.find((file: { path: string }) => file.path.endsWith(".pdf"));
    expect(await NodeFSP.readFile(NodePath.join(archive, pdf.path))).toEqual(pdfBytes);
    expect(await exists(NodePath.join(archive, "annotations", `${sha256}.json`))).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(archive, "README.md"), "utf8")).toContain(
      "Scient never reads this folder on its own.",
    );

    // Not a v1 store: a later open neither moves it again nor reads it.
    const records = (await listScientSourceRecords(library)).length;
    expect(await move(library, project)).toMatchObject({ outcome: "moved", journal: { run: 1 } });
    expect((await readScientLibraryMoveState({ library, projectRoot: project })).v1Present).toBe(
      false,
    );
    expect(await listScientSourceRecords(library)).toHaveLength(records);

    // A collaborator's copy on a computer with its own, empty Library and no journal.
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(project, elsewhere, { recursive: true });
    const theirs = await newLibrary(base, "other-computer");
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toMatchObject({
      outcome: "restored",
      restoredSources: 2,
      restoredPdfs: 1,
    });
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toEqual({
      outcome: "project-store-present",
    });
    expect(await move(theirs, elsewhere)).toMatchObject({ outcome: "moved" });
    expect(
      (await listScientSourceRecords(theirs)).map((record) => record.title).toSorted(),
    ).toEqual(["Plain study, revised", "Study a"]);
    expect(
      await exists(NodePath.join(theirs.root, "files/sha256", sha256.slice(0, 2), `${sha256}.pdf`)),
    ).toBe(true);
    expect(await exists(NodePath.join(theirs.root, "annotations/v1", `${sha256}.json`))).toBe(true);
    expect(
      (await readScientProjectPins(elsewhere)).find((pin) => pin.sourceId === a.sourceId)?.note,
    ).toBe("Why this project cites A.");
    expect((await readScientProjectPins(elsewhere)).map((pin) => pin.sourceId)).toContain(
      b.sourceId,
    );
  });

  it("refuses an entry that names another place, and a move finishes an interrupted restore", async () => {
    const { base, library, project, sha256 } = await seededMove();
    const { journal } = await move(library, project);
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(project, elsewhere, { recursive: true });
    const manifestPath = NodePath.join(elsewhere, journal!.archive!.path, "manifest.json");
    const sealed = await NodeFSP.readFile(manifestPath, "utf8");

    // A correctly hashed payload whose original path leaves the project.
    const payload = Buffer.from("{}");
    const name = `${"0".repeat(64)}.json`;
    await NodeFSP.writeFile(
      NodePath.join(elsewhere, journal!.archive!.path, "annotations", name),
      payload,
    );
    const manifest = JSON.parse(sealed);
    manifest.files.push({
      path: `annotations/${name}`,
      original: "../outside.json",
      sha256: sha(payload),
      bytes: payload.byteLength,
    });
    await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toEqual({
      outcome: "archive-changed",
      files: [`annotations/${name}`],
    });
    expect(await exists(NodePath.join(base, "outside.json"))).toBe(false);
    expect(await exists(NodePath.join(elsewhere, ".scient/sources"))).toBe(false);
    await NodeFSP.writeFile(manifestPath, sealed);

    // The store is published, then copying the highlights fails.
    const failHighlights = async (from: string, to: string) => {
      if (from.includes(`${NodePath.sep}annotations${NodePath.sep}`)) {
        throw new Error("The disk is full.");
      }
      await NodeFSP.copyFile(from, to);
    };
    await expect(
      restoreScientProjectPreMoveArchive({
        projectRoot: elsewhere,
        faults: { copyFile: failHighlights },
      }),
    ).rejects.toThrow("The disk is full.");
    expect((await readScientLibraryMoveState({ library, projectRoot: elsewhere })).v1Present).toBe(
      true,
    );

    // The archive changes before the next move: the move waits, keeping the restore's record.
    const highlight = NodePath.join(
      elsewhere,
      journal!.archive!.path,
      "annotations",
      `${sha256}.json`,
    );
    const archived = await NodeFSP.readFile(highlight);
    await NodeFSP.writeFile(highlight, "{}");
    const theirs = await newLibrary(base, "other-computer");
    await expect(move(theirs, elsewhere)).rejects.toBeInstanceOf(ScientPreMoveRestorePendingError);
    expect(await listScientSourceRecords(theirs)).toEqual([]);
    const progress = NodePath.join(elsewhere, ".scient/library/restore-progress.json");
    expect(await exists(progress)).toBe(true);
    await NodeFSP.writeFile(highlight, archived);
    expect(await move(theirs, elsewhere)).toMatchObject({ outcome: "moved" });
    expect(await exists(NodePath.join(theirs.root, "annotations/v1", `${sha256}.json`))).toBe(true);
    expect(await exists(progress)).toBe(false);
  });

  it("follows no link on the way: manifest, staging folder or payload", async () => {
    const { base, library, project } = await seededMove();
    const { journal } = await move(library, project);
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(project, elsewhere, { recursive: true });
    const archiveId = NodePath.basename(journal!.archive!.path);
    const archive = NodePath.join(elsewhere, journal!.archive!.path);

    // The staging parent leads to a sibling folder that holds a file where the restore stages.
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(NodePath.join(outside, archiveId), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(outside, archiveId, "sentinel"), "keep");
    const staging = NodePath.join(elsewhere, ".scient/library/.restoring-archive");
    await NodeFSP.symlink(outside, staging);
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toEqual({
      outcome: "archive-changed",
      files: [`.scient/library/.restoring-archive/${archiveId}`],
    });
    expect(await NodeFSP.readdir(NodePath.join(outside, archiveId))).toEqual(["sentinel"]);
    await NodeFSP.rm(staging);

    // A payload that is a link to a file with the right bytes.
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(archive, "manifest.json"), "utf8"),
    );
    const pdf = manifest.files.find((file: { path: string }) => file.path.endsWith(".pdf"));
    const sameBytes = NodePath.join(base, "same-bytes.pdf");
    await NodeFSP.rename(NodePath.join(archive, pdf.path), sameBytes);
    await NodeFSP.symlink(sameBytes, NodePath.join(archive, pdf.path));
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toEqual({
      outcome: "archive-changed",
      files: [pdf.path],
    });

    // The manifest itself is a link.
    const manifestCopy = NodePath.join(base, "manifest.json");
    await NodeFSP.rename(NodePath.join(archive, "manifest.json"), manifestCopy);
    await NodeFSP.symlink(manifestCopy, NodePath.join(archive, "manifest.json"));
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere, archiveId })).toEqual(
      { outcome: "archive-changed", files: ["manifest.json"] },
    );
    expect(await exists(NodePath.join(elsewhere, ".scient/sources"))).toBe(false);
  });

  it("never takes a part-written highlight copy for the project's own", async () => {
    const { base, library, project, sha256 } = await seededMove();
    const { journal } = await move(library, project);
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(project, elsewhere, { recursive: true });
    const halfThenFail = async (from: string, to: string) => {
      if (!from.includes(`${NodePath.sep}annotations${NodePath.sep}`)) {
        return NodeFSP.copyFile(from, to);
      }
      const bytes = await NodeFSP.readFile(from);
      await NodeFSP.writeFile(to, bytes.subarray(0, bytes.byteLength >> 1));
      throw new Error("The disk is full.");
    };
    await expect(
      restoreScientProjectPreMoveArchive({
        projectRoot: elsewhere,
        faults: { copyFile: halfThenFail },
      }),
    ).rejects.toThrow("The disk is full.");
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toMatchObject({
      outcome: "restored",
      keptAnnotations: 0,
    });
    const restored = await NodeFSP.readFile(
      NodePath.join(elsewhere, ".scient/annotations/v1", `${sha256}.json`),
    );
    expect(restored).toEqual(
      await NodeFSP.readFile(
        NodePath.join(elsewhere, journal!.archive!.path, "annotations", `${sha256}.json`),
      ),
    );
  });

  it("stops, keeping its progress, where a highlight cannot be published without replacing one", async () => {
    const { base, library, project, sha256 } = await seededMove();
    await move(library, project);
    const elsewhere = NodePath.join(base, "elsewhere");
    await NodeFSP.cp(project, elsewhere, { recursive: true });
    const destination = NodePath.join(elsewhere, ".scient/annotations/v1", `${sha256}.json`);
    // Another writer publishes the project's own highlights just as linking turns out unsupported.
    const theirs = '{"theirs":true}\n';
    const noLinks = async () => {
      await NodeFSP.writeFile(destination, theirs);
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    };
    await expect(
      restoreScientProjectPreMoveArchive({ projectRoot: elsewhere, faults: { link: noLinks } }),
    ).rejects.toBeInstanceOf(ScientPreMoveRestorePendingError);
    expect(await NodeFSP.readFile(destination, "utf8")).toBe(theirs);
    await expect(
      NodeFSP.stat(NodePath.join(elsewhere, ".scient/library/restore-progress.json")),
    ).resolves.toBeTruthy();
    expect(await restoreScientProjectPreMoveArchive({ projectRoot: elsewhere })).toMatchObject({
      outcome: "restored",
      keptAnnotations: 1,
    });
    expect(await NodeFSP.readFile(destination, "utf8")).toBe(theirs);
  });

  it("deletes nothing until the copy is sealed, and an interrupted copy finishes on the rerun", async () => {
    const { library, project } = await seededMove();
    const before = await NodeFSP.readdir(NodePath.join(project, ".scient/sources"), {
      recursive: true,
    });
    const crashed = await crashAt(library, project, { crashAt: "mid-archive" });
    expect(crashed.state).toBe("committed");
    expect(crashed.archive).toBeUndefined();
    expect(
      await NodeFSP.readdir(NodePath.join(project, ".scient/sources"), { recursive: true }),
    ).toEqual(before);
    expect(
      await NodeFSP.readdir(NodePath.join(project, ".scient/library/retained-before-library")),
    ).toEqual([`.${crashed.runId}.partial`]);

    const { journal } = await move(library, project);
    expect(journal).toMatchObject({ state: "done", archive: { path: expect.any(String) } });
    expect(
      await NodeFSP.readdir(NodePath.join(project, ".scient/library/retained-before-library")),
    ).toEqual([crashed.runId]);
    const manifest = await manifestOf(project, journal!);
    for (const file of manifest.files) {
      const bytes = await NodeFSP.readFile(
        NodePath.join(project, journal!.archive!.path, file.path),
      );
      expect(sha(bytes), file.path).toBe(file.sha256);
    }
  });
});

describe("the current-project package", () => {
  it("restores into an empty Library with the original computer gone, with what came after the move", async () => {
    const { base, library, project, a, b, reviewId } = await seededMove();
    await move(library, project);
    // After the move: a second PDF with a highlight, a personal note and a project-note edit.
    const later = NodePath.join(base, "later.pdf");
    await NodeFSP.writeFile(later, "%PDF-1.7\nadded after the move\n", "utf8");
    const before = (await readScientSourceRecord(library, b.sourceId))!;
    const attached = await attachScientSourcePdf({
      root: library,
      sourceId: b.sourceId,
      expectedRevision: before.revision,
      pdfPath: later,
    });
    const laterSha = attached.record.attachments[0]!.sha256;
    const highlight = {
      formatVersion: 1,
      material: { sha256: laterSha, byteLength: 30 },
      paths: [],
      annotations: [{ annotationId: "ann_later", revision: 1, highlighted: true, note: "After" }],
      history: [],
    };
    await NodeFSP.mkdir(NodePath.join(library.root, "annotations/v1"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(library.root, "annotations/v1", `${laterSha}.json`),
      JSON.stringify(highlight),
    );
    await updateScientSourceNote({
      root: library,
      sourceId: a.sourceId,
      expectedRevision: (await readScientSourceRecord(library, a.sourceId))!.revision,
      note: "PERSONAL",
    });
    const aKey = (await readScientProjectPins(project)).find(
      (pin) => pin.sourceId === a.sourceId,
    )!.citationKey;
    await setScientProjectPinNote({
      projectRoot: project,
      citationKey: aKey,
      note: "Why this project cites A, revised.",
      base: "Why this project cites A.",
      actor: "user",
    });

    // A source only the review names, never added to the project.
    const reviewOnly = (
      await importScientSource({
        root: library,
        operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: candidate("screened", { title: "Screened out study" }),
      })
    ).record!;
    await changeScientLibraryReview({
      projectRoot: project,
      library,
      change: {
        action: "log-search",
        reviewId,
        database: "Embase",
        query: "sepsis",
        searchedOn: "2026-11-12",
        sourceIds: [reviewOnly.sourceId],
      },
      actor: "user",
    });

    const exported = await exportScientProjectPackage({
      projectRoot: project,
      library,
      relativePath: "handoff",
      title: "Sepsis",
    });
    expect(exported.counts).toMatchObject({
      pins: 2,
      sources: 3,
      reviewOnlySources: 1,
      pdfs: 2,
      annotations: 2,
      reviews: 1,
    });
    expect(exported.unavailable).toEqual([]);

    // Another computer: a new project and an empty Library; the original Library is gone.
    const theirs = await newLibrary(base, "other-computer");
    const target = await newProject(base, "received");
    await NodeFSP.cp(NodePath.join(project, "handoff"), NodePath.join(target, "handoff"), {
      recursive: true,
    });
    await NodeFSP.rm(library.root, { recursive: true, force: true });
    expect(await listScientProjectPackages(target)).toMatchObject([
      { relativePath: "handoff", title: "Sepsis" },
    ]);
    const imported = await importScientProjectPackage({
      projectRoot: target,
      library: theirs,
      folder: NodePath.join(target, "handoff"),
      actor: "user",
    });
    expect(imported).toMatchObject({
      outcome: "imported",
      sources: { added: 3, matched: 0 },
      pdfs: { added: 2 },
      annotations: 2,
      pins: { added: 2 },
      reviews: { added: 1, conflicts: 0 },
      collections: 1,
    });

    const pins = await readScientProjectPins(target);
    expect(pins.map((pin) => [pin.citationKey, pin.note])).toEqual(
      (await readScientProjectPins(project)).map((pin) => [pin.citationKey, pin.note]),
    );
    expect(
      (await readScientProjectPinNoteHistory({ projectRoot: target, citationKey: aKey }))?.map(
        (version) => version.note,
      ),
    ).toEqual(["Why this project cites A.", "Why this project cites A, revised."]);
    const resolved = await resolveScientProjectPins({
      projectRoot: target,
      library: theirs,
      mode: "read",
      actor: "user",
    });
    expect(resolved.every(({ resolution }) => resolution.kind === "resolved")).toBe(true);
    const records = await listScientSourceRecords(theirs);
    expect(records.map((record) => record.note ?? null)).toEqual([null, null, null]);
    expect(records.flatMap((record) => record.attachments.map((entry) => entry.sha256))).toContain(
      laterSha,
    );
    expect(
      JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(theirs.root, "annotations/v1", `${laterSha}.json`),
          "utf8",
        ),
      ).annotations,
    ).toEqual(highlight.annotations);
    const reviewRecords = await listScientLibraryReviewRecords({
      projectRoot: target,
      library: theirs,
      mode: "read",
      reviewId,
    });
    expect(reviewRecords?.map((record) => record.from)).toEqual(["library", "library", "library"]);
    expect(pins).toHaveLength(2);

    // A second import matches everything and adds nothing.
    expect(
      await importScientProjectPackage({
        projectRoot: target,
        library: theirs,
        folder: NodePath.join(target, "handoff"),
        actor: "user",
      }),
    ).toMatchObject({
      sources: { added: 0, matched: 3 },
      pins: { added: 0 },
      reviews: { added: 0 },
    });
  });

  it("refuses a package whose files changed after it was exported", async () => {
    const { library, project } = await seededMove();
    await move(library, project);
    await exportScientProjectPackage({ projectRoot: project, library, relativePath: "handoff" });
    await NodeFSP.appendFile(NodePath.join(project, "handoff/project/pins.json"), " ");
    expect(
      await importScientProjectPackage({
        projectRoot: project,
        library,
        folder: NodePath.join(project, "handoff"),
        actor: "user",
      }),
    ).toEqual({ outcome: "package-changed", files: ["project/pins.json"] });
  });
});
