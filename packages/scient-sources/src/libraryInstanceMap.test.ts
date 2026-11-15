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
      ownRecordId: alternate.sourceId,
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

    expect(await unlinkScientProjectSource(repair)).toEqual({ outcome: "unlinked" });
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
    expect(await unlinkScientProjectSource(repair)).toEqual({ outcome: "unlinked" });
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
      ownRecordId: cited.sourceId,
    });
  });

  // regression: review H1-b-1 finding 2, the repair looked the record up by the project's ID.
  it("a copy taken from one is repaired from the record the project's ID is mapped to", async () => {
    const base = await newBase();
    const author = await newLibrary(base, "author");
    const project = await newProject(base);
    const elsewhere = await add(author, work("The cited study"));
    await pinScientLibrarySource({
      projectRoot: project,
      library: author,
      sourceId: elsewhere.sourceId,
      actor: "user",
    });
    // On this computer the same work has another ID, which the project's ID is mapped to.
    const library = await newLibrary(base, "collaborator");
    const own = await add(library, work("The cited study"));
    const other = await add(library, {
      ...work("Another study"),
      identifiers: [{ scheme: "doi", value: "10.1000/another" }],
    });
    const refresh = async () => {
      await resolveScientProjectPins({
        projectRoot: project,
        library,
        mode: "write",
        actor: "user",
      });
      const { pins } = await refreshScientProjectPinSnapshots({ projectRoot: project, library });
      return pins[0]!;
    };
    expect((await refresh()).workFrom).toBeUndefined();
    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: [other.sourceId, own.sourceId],
      survivorId: other.sourceId,
    });
    if (merged.outcome !== "merged") throw new Error("Expected a merge.");
    expect(await refresh()).toMatchObject({
      work: { title: "Another study" },
      workFrom: other.sourceId,
    });

    await undoScientLibraryMerge({ library, mergeId: merged.merge.mergeId });
    await trash(library, own.sourceId);

    const repaired = await refresh();
    expect(repaired.work.title).toBe("The cited study");
    expect(repaired.workFrom).toBeUndefined();
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
