// @effect-diagnostics nodeBuiltinImport:off -- Review snapshot tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { editableMetadataFromRecord } from "./editable.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import {
  changeScientLibraryReview,
  listScientLibraryReviewRecords,
  listScientLibraryReviews,
  readScientLibraryReview,
  readScientLibraryReviewRecord,
  refreshScientLibraryReviewSnapshot,
} from "./libraryReviews.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import { importScientSource, readScientSourceRecord, updateScientSourceMetadata } from "./store.ts";
import { changeScientSystematicReview } from "./systematicReviewStore.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

type Library = ReturnType<typeof scientLibraryLocation>;

async function fixture(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-reviews-")),
  );
  fixtures.push(root);
  return root;
}

async function newLibrary(base: string, name: string): Promise<Library> {
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

function candidate(index: number, abstract: string | null = null): ScientSourceCandidate {
  return {
    sourceKey: `S${index}`,
    type: "article",
    customType: null,
    title: `Randomised trial number ${index}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: `Author${index}`, literalName: null },
    ],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [{ scheme: "doi", value: `10.1000/trial-${index}` }],
    abstract,
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

async function addRecord(
  library: Library,
  index: number,
  abstract: string | null = null,
): Promise<ScientSourceRecord> {
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(index, abstract),
    allowPossibleMetadataMatch: true,
  });
  if (!imported.record) throw new Error("Expected an imported source.");
  return imported.record;
}

async function createReview(projectRoot: string, library: Library): Promise<string> {
  const created = await changeScientLibraryReview({
    projectRoot,
    library,
    change: { action: "create-review", title: "Early therapy" },
    actor: "user",
  });
  if (!created.reviewId) throw new Error("Expected a review.");
  return created.reviewId;
}

function reviewFile(projectRoot: string, reviewId: string, suffix = ".json"): string {
  return NodePath.join(projectRoot, ".scient", "library", "reviews", `${reviewId}${suffix}`);
}

async function snapshotEntries(projectRoot: string, reviewId: string) {
  const text = await NodeFSP.readFile(reviewFile(projectRoot, reviewId, ".works.json"), "utf8");
  return (JSON.parse(text) as { records: Record<string, { abstract: string; capturedAt: string }> })
    .records;
}

async function tree(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .map((entry) => NodePath.join(entry.parentPath, entry.name))
      .toSorted()
      .map(async (path) => {
        const stats = await NodeFSP.lstat(path);
        return stats.isFile()
          ? `${path} ${(await NodeFSP.readFile(path)).toString("base64")}`
          : path;
      }),
  );
}

/** A review with a searched record and an added one, copied to a computer with an empty library. */
async function reviewCopiedToEmptyLibrary() {
  const base = await fixture();
  const library = await newLibrary(base, "author");
  const projectRoot = await newProject(base);
  const searched = await addRecord(library, 1, "Searched abstract.");
  const added = await addRecord(library, 2, "Imported abstract the registry no longer has.");
  const reviewId = await createReview(projectRoot, library);
  const logged = await changeScientLibraryReview({
    projectRoot,
    library,
    change: {
      action: "log-search",
      reviewId,
      database: "PubMed",
      query: "early therapy",
      searchedOn: "2026-11-11",
      sourceIds: [searched.sourceId],
    },
    actor: "agent",
  });
  expect(logged.skippedSourceIds).toBeUndefined();
  await changeScientLibraryReview({
    projectRoot,
    library,
    change: { action: "add-sources", reviewId, sourceIds: [added.sourceId] },
    actor: "user",
  });
  const copy = NodePath.join(base, "copy");
  await NodeFSP.cp(projectRoot, copy, { recursive: true });
  return {
    base,
    copy,
    emptyLibrary: await newLibrary(base, "collaborator"),
    reviewId,
    searched,
    added,
  };
}

describe("review record snapshots", () => {
  it("review-membership-after-move-empty-library: lists, screens and counts from the snapshot", async () => {
    const { copy, emptyLibrary, reviewId, searched, added } = await reviewCopiedToEmptyLibrary();
    const records = await listScientLibraryReviewRecords({
      projectRoot: copy,
      library: emptyLibrary,
      reviewId,
      mode: "read",
    });
    expect(records?.map(({ projectSourceId, from }) => [projectSourceId, from])).toEqual([
      [searched.sourceId, "snapshot"],
      [added.sourceId, "snapshot"],
    ]);
    expect(records?.[0]?.record?.title).toBe(searched.title);

    const screened = await changeScientLibraryReview({
      projectRoot: copy,
      library: emptyLibrary,
      change: {
        action: "screen",
        reviewId,
        stage: "title-abstract",
        decisions: [
          { sourceId: searched.sourceId, decision: "include" },
          { sourceId: added.sourceId, decision: "exclude", reason: "Wrong population" },
        ],
      },
      actor: "user",
    });
    expect(screened).toMatchObject({ outcome: "updated" });
    expect(screened.skippedSourceIds).toBeUndefined();
    const detail = await readScientLibraryReview({
      projectRoot: copy,
      library: emptyLibrary,
      reviewId,
      mode: "read",
    });
    expect(detail?.screeningSourceIds).toEqual([searched.sourceId, added.sourceId]);
    expect(detail?.prisma).toMatchObject({
      identified: { databases: 1, otherMethods: 1 },
      removedBeforeScreening: { duplicates: 0, other: 0 },
      screened: 2,
      titleAbstract: { included: 1, excluded: 1, pending: 0 },
    });
  });

  it("read-only calls write nothing, in the project or the library", async () => {
    const { base, copy, emptyLibrary, reviewId, added } = await reviewCopiedToEmptyLibrary();
    await NodeFSP.writeFile(reviewFile(copy, reviewId, ".works.json"), "{ not json");
    const before = await tree(base);
    const reads = { projectRoot: copy, library: emptyLibrary, mode: "read" as const };
    await listScientLibraryReviews(reads);
    await readScientLibraryReview({ ...reads, reviewId });
    await listScientLibraryReviewRecords({ ...reads, reviewId });
    expect(
      await readScientLibraryReviewRecord({ ...reads, reviewId, sourceId: added.sourceId }),
    ).toMatchObject({ from: "missing", record: null });
    expect(await tree(base)).toEqual(before);
  });

  it("crash-after-snapshot-before-review: readers ignore the extra entry and a retry reuses it", async () => {
    const base = await fixture();
    const library = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, 1);
    const second = await addRecord(library, 2);
    const reviewId = await createReview(projectRoot, library);
    await changeScientLibraryReview({
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [first.sourceId] },
      actor: "user",
    });
    const beforeCrash = await NodeFSP.readFile(reviewFile(projectRoot, reviewId));
    const addSecond = {
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [second.sourceId] },
      actor: "user",
    } as const;
    await changeScientLibraryReview(addSecond);
    // The snapshot was published; the review write that followed never happened.
    await NodeFSP.writeFile(reviewFile(projectRoot, reviewId), beforeCrash);
    const leftover = (await snapshotEntries(projectRoot, reviewId))[second.sourceId];
    expect(leftover).toBeDefined();

    const reads = { projectRoot, library, reviewId, mode: "read" as const };
    expect((await listScientLibraryReviewRecords(reads))?.map((r) => r.projectSourceId)).toEqual([
      first.sourceId,
    ]);
    expect(await readScientLibraryReviewRecord({ ...reads, sourceId: second.sourceId })).toBeNull();
    expect((await readScientLibraryReview(reads))?.prisma.identified.otherMethods).toBe(1);

    expect(await changeScientLibraryReview(addSecond)).toMatchObject({ outcome: "updated" });
    expect((await snapshotEntries(projectRoot, reviewId))[second.sourceId]).toEqual(leftover);
    expect((await listScientLibraryReviewRecords(reads))?.map((r) => r.projectSourceId)).toEqual([
      first.sourceId,
      second.sourceId,
    ]);
  });

  it("review-snapshot-abstract-offline: the detail returns the imported abstract", async () => {
    const { copy, emptyLibrary, reviewId, added } = await reviewCopiedToEmptyLibrary();
    const detail = await readScientLibraryReviewRecord({
      projectRoot: copy,
      library: emptyLibrary,
      reviewId,
      sourceId: added.sourceId,
      mode: "read",
    });
    expect(detail).toMatchObject({
      projectSourceId: added.sourceId,
      from: "snapshot",
      abstractFrom: "snapshot",
      removed: false,
      record: {
        sourceId: added.sourceId,
        revision: added.revision,
        abstract: "Imported abstract the registry no longer has.",
      },
    });
  });

  it("a refresh keeps an abstract the library lacks and writes nothing when nothing changed", async () => {
    const base = await fixture();
    const library = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(library, 1, "Imported abstract.");
    const reviewId = await createReview(projectRoot, library);
    await changeScientLibraryReview({
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [record.sourceId] },
      actor: "user",
    });
    const snapshotPath = reviewFile(projectRoot, reviewId, ".works.json");
    const written = JSON.parse(await NodeFSP.readFile(snapshotPath, "utf8"));
    written.fromNewerScient = true;
    written.records[record.sourceId].screeningHint = "kept";
    await NodeFSP.writeFile(snapshotPath, JSON.stringify(written));
    const current = await readScientSourceRecord(library, record.sourceId);
    if (!current) throw new Error("Expected the record.");
    await updateScientSourceMetadata({
      root: library,
      sourceId: current.sourceId,
      expectedRevision: current.revision,
      metadata: {
        ...editableMetadataFromRecord(current),
        title: "Corrected title",
        abstract: null,
      },
    });

    const refresh = { projectRoot, library, reviewId };
    expect(
      await refreshScientLibraryReviewSnapshot({ ...refresh, naming: new Set(["source_other"]) }),
    ).toEqual({ changed: false });
    expect((await snapshotEntries(projectRoot, reviewId))[record.sourceId]).toMatchObject({
      title: "Randomised trial number 1",
    });
    expect(
      await refreshScientLibraryReviewSnapshot({ ...refresh, naming: new Set([record.sourceId]) }),
    ).toEqual({ changed: true });
    expect((await snapshotEntries(projectRoot, reviewId))[record.sourceId]).toMatchObject({
      title: "Corrected title",
      abstract: "Imported abstract.",
      capturedRevision: current.revision + 1,
      screeningHint: "kept",
    });
    const bytes = await NodeFSP.readFile(snapshotPath, "utf8");
    expect(JSON.parse(bytes)).toMatchObject({ fromNewerScient: true });
    expect(await refreshScientLibraryReviewSnapshot(refresh)).toEqual({ changed: false });
    expect(await NodeFSP.readFile(snapshotPath, "utf8")).toBe(bytes);
    expect(
      await readScientLibraryReviewRecord({
        ...refresh,
        sourceId: record.sourceId,
        mode: "read",
      }),
    ).toMatchObject({
      from: "library",
      abstractFrom: "snapshot",
      record: { title: "Corrected title", abstract: "Imported abstract." },
    });
  });

  it("sets a broken snapshot aside, refills it, and removes a snapshot whose review never existed", async () => {
    const base = await fixture();
    const library = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(library, 1);
    const reviewId = await createReview(projectRoot, library);
    await changeScientLibraryReview({
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [record.sourceId] },
      actor: "user",
    });
    await NodeFSP.writeFile(reviewFile(projectRoot, reviewId, ".works.json"), "{ not json");
    const orphan = reviewFile(projectRoot, "review_never_created", ".works.json");
    await NodeFSP.writeFile(
      orphan,
      JSON.stringify({ formatVersion: 1, reviewId: "x", records: {} }),
    );

    await readScientLibraryReview({ projectRoot, library, reviewId, mode: "write" });
    const folder = await NodeFSP.readdir(NodePath.dirname(orphan));
    expect(folder.filter((name) => name.includes(".works.json.broken-"))).toHaveLength(1);
    expect(Object.keys(await snapshotEntries(projectRoot, reviewId))).toEqual([record.sourceId]);

    await listScientLibraryReviews({ projectRoot, library, mode: "read" });
    await expect(NodeFSP.access(orphan)).resolves.toBeUndefined();
    const listed = await listScientLibraryReviews({ projectRoot, library, mode: "write" });
    expect(listed).toMatchObject({ reviews: [{ reviewId }], issues: [] });
    await expect(NodeFSP.access(orphan)).rejects.toThrow();
  });

  it("after a crash while sharding, readers merge both layouts and the next write keeps the shards", async () => {
    const base = await fixture();
    const library = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, 1, "First abstract.");
    const second = await addRecord(library, 2);
    const reviewId = await createReview(projectRoot, library);
    await changeScientLibraryReview({
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [first.sourceId] },
      actor: "user",
    });
    const shardOf = (id: string) =>
      NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 1);
    const single = reviewFile(projectRoot, reviewId, ".works.json");
    const shards = reviewFile(projectRoot, reviewId, ".works");
    await NodeFSP.mkdir(shards);
    await NodeFSP.copyFile(single, NodePath.join(shards, `${shardOf(first.sourceId)}.json`));
    const emptyLibrary = await newLibrary(base, "collaborator");
    const offline = { projectRoot, library: emptyLibrary, reviewId, mode: "read" as const };
    expect(
      await readScientLibraryReviewRecord({ ...offline, sourceId: first.sourceId }),
    ).toMatchObject({ from: "snapshot", record: { abstract: "First abstract." } });

    await changeScientLibraryReview({
      projectRoot,
      library,
      change: { action: "add-sources", reviewId, sourceIds: [second.sourceId] },
      actor: "user",
    });
    await expect(NodeFSP.access(single)).rejects.toThrow();
    const shardFiles = (await NodeFSP.readdir(shards)).toSorted();
    expect(shardFiles).toEqual(
      [...new Set([first.sourceId, second.sourceId].map((id) => `${shardOf(id)}.json`))].toSorted(),
    );
    expect((await listScientLibraryReviewRecords(offline))?.map(({ from }) => from)).toEqual([
      "snapshot",
      "snapshot",
    ]);
  });

  it("the project store's review path writes no snapshot", async () => {
    const base = await fixture();
    const projectRoot = await newProject(base);
    const imported = await importScientSource({
      root: projectRoot,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate(1, "Abstract."),
      allowPossibleMetadataMatch: true,
    });
    const created = await changeScientSystematicReview({
      root: projectRoot,
      change: { action: "create-review", title: "Early therapy" },
      actor: "user",
    });
    await changeScientSystematicReview({
      root: projectRoot,
      change: {
        action: "add-sources",
        reviewId: created.reviewId!,
        sourceIds: [imported.record!.sourceId],
      },
      actor: "user",
    });
    const files = await NodeFSP.readdir(NodePath.join(projectRoot, ".scient"), { recursive: true });
    expect(files.filter((name) => name.endsWith(".works.json"))).toEqual([]);
    expect(files.some((name) => name.startsWith("library"))).toBe(false);
  });
});
