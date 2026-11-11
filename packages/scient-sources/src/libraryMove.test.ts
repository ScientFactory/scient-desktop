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
  resolveScientReviewConflict,
  SCIENT_REVIEW_COMBINED_NOTE,
} from "./libraryReviewConflicts.ts";
import { listScientLibraryReviewRecords, readScientLibraryReview } from "./libraryReviews.ts";
import {
  moveScientProjectBackIntoProject,
  readScientLibraryMoveState,
  runScientLibraryMove,
  scientLibraryMoveInternals,
  scientLibraryMoveStatusLines,
  ScientLibraryMoveCrash,
  type ScientLibraryMoveFaults,
  type ScientLibraryMoveJournal,
  type ScientLibraryMoveProgress,
} from "./libraryMove.ts";
import {
  ensureScientLibrary,
  listScientLibraryInstances,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { readScientProjectPins, resolveScientProjectPins } from "./projectPins.ts";
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
    expect(scientLibraryMoveStatusLines(untracked.journal)).toEqual([]);
  });

  it("does nothing on a project with no v1 store, and writes no journal", async () => {
    const base = await fixture();
    const library = await newLibrary(base);
    const project = await newProject(base);
    expect((await move(library, project)).outcome).toBe("not-needed");
    expect(await exists(NodePath.join(library.root, "migrations"))).toBe(false);
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
    for (const root of [projectB, copied]) {
      const resolved = await resolveScientReviewConflict({
        projectRoot: root,
        library: empty,
        reviewId,
        conflictId: conflict!.conflictId,
        pick: "combine",
        actor: "user",
      });
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
    expect((await moving).outcome).toBe("moved");
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
