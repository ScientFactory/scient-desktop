// @effect-diagnostics nodeBuiltinImport:off -- Resolution tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  keepScientProjectSourceSeparate,
  linkScientProjectSource,
  unlinkScientProjectSource,
} from "./libraryInstanceMap.ts";
import { changeScientLibraryReview, listScientLibraryReviewRecords } from "./libraryReviews.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  markScientLibrarySourcesDistinct,
  mergeScientLibrarySources,
  undoScientLibraryMerge,
} from "./libraryMerge.ts";
import { readScientDisplacedCopies } from "./projectDisplacedCopies.ts";
import {
  listScientProjectPinnedWorks,
  pinScientLibrarySource,
  refreshScientProjectPinSnapshots,
  resolveScientProjectPins,
  setScientProjectPinNote,
} from "./projectPins.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  importScientSource,
  listScientSourceRecords,
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

type Library = ReturnType<typeof scientLibraryLocation>;

async function newLibrary(base: string, name: string): Promise<Library> {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return scientLibraryLocation(root);
}

const work = (title: string): ScientSourceCandidate => ({
  sourceKey: title,
  type: "article",
  customType: null,
  title,
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2020",
  issuedYear: 2020,
  identifiers: [{ scheme: "doi", value: "10.1000/shared" }],
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
});

async function add(library: Library, candidate: ScientSourceCandidate) {
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate,
  });
  return imported.record!;
}

describe("resolving a copied project's sources", () => {
  it("keeps an alternate hydration deleted for good across fresh checkouts of a sparse snapshot", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-instance-map-")),
    );
    fixtures.push(base);
    const author = await newLibrary(base, "author");
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    await initializeScientProject({ root: project });
    const sparse = {
      ...work("Old imported title"),
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
      containerTitle: null,
    };
    const cited = await add(author, sparse);
    await pinScientLibrarySource({
      projectRoot: project,
      library: author,
      sourceId: cited.sourceId,
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    const resolveFresh = async (name: string) => {
      const copy = NodePath.join(base, name);
      await NodeFSP.cp(project, copy, { recursive: true });
      const [pin] = await resolveScientProjectPins({
        projectRoot: copy,
        library: collaborator,
        mode: "write",
        actor: "user",
      });
      return pin!.resolution;
    };
    const first = await resolveFresh("first");
    if (first.kind !== "resolved") throw new Error("Expected the first hydration.");
    const original = (await readScientSourceRecord(collaborator, first.sourceId))!;
    const corrected = await updateScientSourceMetadata({
      root: collaborator,
      sourceId: original.sourceId,
      expectedRevision: original.revision,
      metadata: { ...editableMetadataFromRecord(original), title: "Corrected title" },
      actor: "user",
    });
    expect(corrected.outcome).toBe("updated");
    const second = await resolveFresh("second");
    if (second.kind !== "resolved") throw new Error("Expected the alternate hydration.");
    expect(second.sourceId).not.toBe(first.sourceId);
    const alternate = (await readScientSourceRecord(collaborator, second.sourceId))!;
    await removeScientSource({
      root: collaborator,
      sourceId: alternate.sourceId,
      expectedRevision: alternate.revision,
    });
    await deleteScientSourcesPermanently({ root: collaborator });

    expect(await resolveFresh("third")).toEqual({
      kind: "unresolved",
      projectSourceId: cited.sourceId,
      reason: "removed",
      candidateIds: [alternate.sourceId],
    });
    expect((await listScientSourceRecords(collaborator)).map(({ sourceId }) => sourceId)).toEqual([
      original.sourceId,
    ]);

    const reimported = await importScientSource({
      root: collaborator,
      operationId: NodeCrypto.randomUUID(),
      candidate: { ...sparse, sourceKey: `project-source:${cited.sourceId}` },
      actor: "user",
      intake: "file",
    });
    expect(reimported.outcome).toBe("imported");
    expect(reimported.record?.title).toBe(sparse.title);
    expect(await listScientSourceRecords(collaborator)).toHaveLength(2);
  });

  it("leaves a pin and a review record a misleading near-match contradicts on its snapshot", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-instance-map-")),
    );
    fixtures.push(base);
    const author = await newLibrary(base, "author");
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    await initializeScientProject({ root: project });
    const cited = await add(author, work("Early therapy in sepsis"));
    await pinScientLibrarySource({
      projectRoot: project,
      library: author,
      sourceId: cited.sourceId,
      actor: "user",
    });
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "create-review", title: "Sepsis" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "add-sources", reviewId: reviewId!, sourceIds: [cited.sourceId] },
      actor: "user",
    });
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(project, copy, { recursive: true });

    // The collaborator's Library has a record carrying the same DOI by mistake, with a PDF.
    const collaborator = await newLibrary(base, "collaborator");
    const nearMatch = await add(collaborator, work("Soil carbon under drought"));
    const pdf = NodePath.join(base, "near.pdf");
    await NodeFSP.writeFile(pdf, "%PDF-1.7\nnear\n");
    await attachScientSourcePdf({
      root: collaborator,
      sourceId: nearMatch.sourceId,
      expectedRevision: nearMatch.revision,
      pdfPath: pdf,
    });

    const [pin] = await resolveScientProjectPins({
      projectRoot: copy,
      library: collaborator,
      mode: "write",
      actor: "user",
    });
    expect(pin?.resolution).toEqual({
      kind: "unresolved",
      projectSourceId: cited.sourceId,
      reason: "contradicted",
      candidateIds: [nearMatch.sourceId],
    });
    expect(await listScientSourceRecords(collaborator)).toHaveLength(1);
    const [served] = await listScientProjectPinnedWorks({
      projectRoot: copy,
      library: collaborator,
    });
    expect(served).toMatchObject({
      from: "snapshot",
      record: { title: "Early therapy in sepsis", attachments: [] },
    });
    const records = await listScientLibraryReviewRecords({
      projectRoot: copy,
      library: collaborator,
      reviewId: reviewId!,
      mode: "write",
    });
    expect(records?.map(({ from, record }) => [from, record?.title])).toEqual([
      ["snapshot", "Early therapy in sepsis"],
    ]);

    // A person decides: this pin is the collaborator's copy after all, or it is not.
    await setScientProjectPinNote({
      projectRoot: copy,
      citationKey: served!.citationKey,
      note: "Why we cite it",
      actor: "user",
    });
    const repair = { library: collaborator, projectRoot: copy, projectSourceId: cited.sourceId };
    expect(
      await linkScientProjectSource({ ...repair, sourceId: nearMatch.sourceId, actor: "user" }),
    ).toEqual({ outcome: "linked", sourceId: nearMatch.sourceId });
    const [linked] = await listScientProjectPinnedWorks({
      projectRoot: copy,
      library: collaborator,
    });
    expect(linked).toMatchObject({
      from: "library",
      citationKey: served!.citationKey,
      projectNote: "Why we cite it",
      record: { title: "Soil carbon under drought", attachments: [{ kind: "pdf" }] },
    });
    const linkedReview = await listScientLibraryReviewRecords({
      projectRoot: copy,
      library: collaborator,
      reviewId: reviewId!,
      mode: "read",
    });
    expect(linkedReview?.map(({ from }) => from)).toEqual(["library"]);

    expect(await unlinkScientProjectSource({ ...repair, actor: "user" })).toEqual({
      outcome: "unlinked",
    });
    await keepScientProjectSourceSeparate({
      ...repair,
      sourceIds: [nearMatch.sourceId],
      separate: true,
      actor: "agent",
    });
    const [kept] = await resolveScientProjectPins({
      projectRoot: copy,
      library: collaborator,
      mode: "read",
      actor: "user",
    });
    expect(kept?.resolution).toMatchObject({ reason: "contradicted", keptSeparate: true });
  });

  it("repairs a review record no pin names; Keep separate holds until withdrawn, and Undo of a link restores it", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-instance-map-")),
    );
    fixtures.push(base);
    const author = await newLibrary(base, "author");
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    await initializeScientProject({ root: project });
    const screened = await add(author, work("Early therapy in sepsis"));
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "create-review", title: "Sepsis" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "add-sources", reviewId: reviewId!, sourceIds: [screened.sourceId] },
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    const nearMatch = await add(collaborator, work("Soil carbon under drought"));
    const reviewRecord = async () =>
      (await listScientLibraryReviewRecords({
        projectRoot: project,
        library: collaborator,
        reviewId: reviewId!,
        mode: "read",
      }))![0]!;

    expect(await reviewRecord()).toMatchObject({
      from: "snapshot",
      unresolved: { reason: "contradicted", candidateIds: [nearMatch.sourceId] },
    });
    const repair = {
      library: collaborator,
      projectRoot: project,
      projectSourceId: screened.sourceId,
    };
    await keepScientProjectSourceSeparate({
      ...repair,
      sourceIds: [nearMatch.sourceId],
      separate: true,
      actor: "user",
    });
    // The rejected copy's metadata later agrees; the decision still holds.
    await updateScientSourceMetadata({
      root: collaborator,
      sourceId: nearMatch.sourceId,
      expectedRevision: nearMatch.revision,
      metadata: { ...editableMetadataFromRecord(nearMatch), title: "Early therapy in sepsis" },
      actor: "user",
    });
    expect(await reviewRecord()).toMatchObject({
      from: "snapshot",
      unresolved: { keptSeparate: true, candidateIds: [nearMatch.sourceId] },
    });

    await linkScientProjectSource({ ...repair, sourceId: nearMatch.sourceId, actor: "user" });
    expect(await reviewRecord()).toMatchObject({ from: "library" });
    expect(await unlinkScientProjectSource({ ...repair, actor: "user" })).toEqual({
      outcome: "unlinked",
    });
    expect(await reviewRecord()).toMatchObject({
      from: "snapshot",
      unresolved: { keptSeparate: true },
    });
  });

  it("holds Keep separate after its candidates stop matching, until Ask again", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-instance-map-")),
    );
    fixtures.push(base);
    const author = await newLibrary(base, "author");
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    await initializeScientProject({ root: project });
    const cited = await add(author, work("Early therapy in sepsis"));
    await pinScientLibrarySource({
      projectRoot: project,
      library: author,
      sourceId: cited.sourceId,
      actor: "user",
    });
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "create-review", title: "Sepsis" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: project,
      library: author,
      change: { action: "add-sources", reviewId: reviewId!, sourceIds: [cited.sourceId] },
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    const nearMatch = await add(collaborator, work("Soil carbon under drought"));
    const repair = { library: collaborator, projectRoot: project, projectSourceId: cited.sourceId };
    await keepScientProjectSourceSeparate({
      ...repair,
      sourceIds: [nearMatch.sourceId],
      separate: true,
      actor: "user",
    });
    // Its wrong DOI is corrected: nothing in this Library matches the pin any more.
    await updateScientSourceMetadata({
      root: collaborator,
      sourceId: nearMatch.sourceId,
      expectedRevision: nearMatch.revision,
      metadata: {
        ...editableMetadataFromRecord(nearMatch),
        identifiers: [{ scheme: "doi", value: "10.1000/soil" }],
      },
      actor: "user",
    });
    const held = { keptSeparate: true, candidateIds: [nearMatch.sourceId] };
    const [record] = (await listScientLibraryReviewRecords({
      projectRoot: project,
      library: collaborator,
      reviewId: reviewId!,
      mode: "read",
    }))!;
    expect(record).toMatchObject({ from: "snapshot", unresolved: held });
    const resolvePin = async () =>
      (
        await resolveScientProjectPins({
          projectRoot: project,
          library: collaborator,
          mode: "write",
          actor: "user",
        })
      )[0]!.resolution;
    expect(await resolvePin()).toMatchObject(held);
    expect(await listScientSourceRecords(collaborator)).toHaveLength(1);

    await keepScientProjectSourceSeparate({
      ...repair,
      sourceIds: [],
      separate: false,
      actor: "user",
    });
    expect(await resolvePin()).toMatchObject({ kind: "resolved", by: "hydrated" });
  });
});

describe("records the Library holds apart from a source", () => {
  async function newProject(base: string) {
    const project = NodePath.join(base, "project");
    await NodeFSP.mkdir(project);
    await initializeScientProject({ root: project });
    return project;
  }
  async function newBase() {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-held-apart-")),
    );
    fixtures.push(base);
    return base;
  }
  const trash = async (library: Library, sourceId: string) => {
    const record = (await readScientSourceRecord(library, sourceId))!;
    await removeScientSource({ root: library, sourceId, expectedRevision: record.revision });
  };

  // regression: review H1-b-1 finding 1, only the first match was vetted.
  it("never resolve it, also a second match the first one hid", async () => {
    const base = await newBase();
    const library = await newLibrary(base, "library");
    const project = await newProject(base);
    const cited = await add(library, work("Shared title"));
    // The same DOI on another record, and a third with the same title, author and year only.
    const sameDoi = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: { ...work("Shared title"), sourceKey: "same-doi" },
        refusedSourceIds: [cited.sourceId],
      })
    ).record!;
    const sameTitle = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: { ...work("Shared title"), sourceKey: "same-title", identifiers: [] },
        refusedSourceIds: [cited.sourceId, sameDoi.sourceId],
        allowPossibleMetadataMatch: true,
      })
    ).record!;
    await pinScientLibrarySource({
      projectRoot: project,
      library,
      sourceId: cited.sourceId,
      actor: "user",
    });
    for (const other of [sameDoi, sameTitle]) {
      await markScientLibrarySourcesDistinct({
        library,
        sourceIds: [cited.sourceId, other.sourceId],
        actor: "user",
      });
    }
    await trash(library, cited.sourceId);

    const [resolved] = await resolveScientProjectPins({
      projectRoot: project,
      library,
      mode: "write",
      actor: "user",
    });
    expect(resolved?.resolution).toEqual({
      kind: "unresolved",
      projectSourceId: cited.sourceId,
      reason: "removed",
      candidateIds: [cited.sourceId],
    });
  });

  /** Two papers a merge joins: the kept one has a publisher, the merged-away one has pages. */
  async function mergedPair() {
    const base = await newBase();
    const library = await newLibrary(base, "library");
    const project = await newProject(base);
    const kept = await add(library, { ...work("The kept paper"), publisher: "Kept Press" });
    const away = await add(library, {
      ...work("The merged-away paper"),
      identifiers: [{ scheme: "doi", value: "10.1000/away" }],
      pages: "11-19",
    });
    for (const { sourceId } of [kept, away]) {
      await pinScientLibrarySource({ projectRoot: project, library, sourceId, actor: "user" });
    }
    const copies = async () => {
      await resolveScientProjectPins({
        projectRoot: project,
        library,
        mode: "write",
        actor: "user",
      });
      const { pins } = await refreshScientProjectPinSnapshots({ projectRoot: project, library });
      const of = (sourceId: string) => pins.find((pin) => pin.sourceId === sourceId)!.work;
      return { kept: of(kept.sourceId), away: of(away.sourceId) };
    };
    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: [kept.sourceId, away.sourceId],
      survivorId: kept.sourceId,
    });
    if (merged.outcome !== "merged") throw new Error("Expected a merge.");
    // While the merge stands, both keys carry the one paper: its publisher and the pages it took.
    expect(await copies()).toMatchObject({
      kept: { publisher: "Kept Press", pages: "11-19" },
      away: { title: "The kept paper", publisher: "Kept Press", pages: "11-19" },
    });
    await undoScientLibraryMerge({ library, mergeId: merged.merge.mergeId });
    return { library, project, kept, away, copies, trash: (id: string) => trash(library, id) };
  }

  // regression: review IDEA-D1c-1, a refresh kept the other paper's value wherever a record had none.
  it("after an Undo, neither paper's copy keeps a value the merge brought from the other", async () => {
    const { copies, project } = await mergedPair();
    expect(await copies()).toMatchObject({
      kept: { title: "The kept paper", publisher: "Kept Press", pages: null },
      away: { title: "The merged-away paper", publisher: null, pages: "11-19" },
    });

    // The copy each key held while the merge stood is kept in the project, once per Undo.
    const displaced = async () =>
      (await readScientDisplacedCopies(await NodeFSP.realpath(project), { kind: "project" }))
        .map(({ differs, work }) => ({ differs, work }))
        .toSorted((left, right) => left.differs.length - right.differs.length);
    expect(await displaced()).toMatchObject([
      { differs: ["pages"], work: { title: "The kept paper", pages: "11-19" } },
      {
        differs: expect.arrayContaining(["title", "publisher"]),
        work: { title: "The kept paper", publisher: "Kept Press" },
      },
    ]);
    await copies();
    expect(await displaced()).toHaveLength(2);
  });

  it("the same when either paper is removed before the project refreshes", async () => {
    const { library, project, copies, kept, away, trash } = await mergedPair();
    await trash(away.sourceId);
    await trash(kept.sourceId);
    // regression: review H1-d-1 finding 1, the reader cited the stale copy until a refresh.
    const cited = await listScientProjectPinnedWorks({ projectRoot: project, library });
    expect(
      cited.map(({ from, record }) => [from, record.title, record.publisher, record.pages]),
    ).toEqual([
      ["snapshot", "The kept paper", "Kept Press", null],
      ["snapshot", "The merged-away paper", null, "11-19"],
    ]);
    expect(await copies()).toMatchObject({
      kept: { title: "The kept paper", publisher: "Kept Press", pages: null },
      away: { title: "The merged-away paper", publisher: null, pages: "11-19" },
    });
  });

  // regression: review H1-d-1 finding 2, the whole copy made unknown citation fields known.
  it("an older copy's unknown fields stay unknown for a paper hydrated from it", async () => {
    const base = await newBase();
    const author = await newLibrary(base, "author");
    const project = await newProject(base);
    const cited = await add(author, work("Cited from an older file"));
    await pinScientLibrarySource({
      projectRoot: project,
      library: author,
      sourceId: cited.sourceId,
      actor: "user",
    });
    // The file as an older Scient wrote it: the six fields, no pages, publisher or the rest.
    const pinsPath = NodePath.join(project, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    const { type, title, creators, issuedYear, identifiers, containerTitle } = file.pins[0].work;
    file.pins[0].work = { type, title, creators, issuedYear, identifiers, containerTitle };
    await NodeFSP.writeFile(pinsPath, `${JSON.stringify(file, null, 2)}\n`);
    const library = await newLibrary(base, "collaborator");
    const refreshed = async () => {
      await resolveScientProjectPins({
        projectRoot: project,
        library,
        mode: "write",
        actor: "user",
      });
      return (await refreshScientProjectPinSnapshots({ projectRoot: project, library })).pins[0]!;
    };
    expect(await refreshed()).not.toHaveProperty("work.pages");
    const hydrated = (await listScientSourceRecords(library))[0]!;
    const other = await add(library, {
      ...work("Another sparse paper"),
      identifiers: [{ scheme: "doi", value: "10.1000/another" }],
    });
    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: [hydrated.sourceId, other.sourceId],
      survivorId: hydrated.sourceId,
    });
    if (merged.outcome !== "merged") throw new Error("Expected a merge.");
    await undoScientLibraryMerge({ library, mergeId: merged.merge.mergeId });

    expect(await refreshed()).not.toHaveProperty("work.pages");
    // Deleted for good: this key's ID is the other computer's, so its copy is left alone and
    // stays incomplete; the fuller managed entry is still kept.
    await trash(library, hydrated.sourceId);
    await deleteScientSourcesPermanently({ root: library, sourceIds: [hydrated.sourceId] });
    const [read] = await listScientProjectPinnedWorks({ projectRoot: project, library });
    expect(read).toMatchObject({ from: "snapshot", incompleteSnapshot: true });
    expect(await refreshed()).not.toHaveProperty("work.pages");
  });

  // regression: review H1-b-1 finding 3, a copy of the source itself was replaced when it differed.
  it("a removed source's own copy is left as the project has it", async () => {
    const base = await newBase();
    const library = await newLibrary(base, "library");
    const project = await newProject(base);
    const cited = await add(library, work("Title as first imported"));
    await pinScientLibrarySource({
      projectRoot: project,
      library,
      sourceId: cited.sourceId,
      actor: "user",
    });
    // The title is corrected in the Library, and the source removed before this project refreshes.
    await updateScientSourceMetadata({
      root: library,
      sourceId: cited.sourceId,
      expectedRevision: cited.revision,
      metadata: { ...editableMetadataFromRecord(cited), title: "Title as corrected" },
      actor: "user",
    });
    await trash(library, cited.sourceId);

    const { changed, pins } = await refreshScientProjectPinSnapshots({
      projectRoot: project,
      library,
    });
    expect(changed).toBe(false);
    expect(pins[0]?.work.title).toBe("Title as first imported");
  });
});
