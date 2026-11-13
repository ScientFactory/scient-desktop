// @effect-diagnostics nodeBuiltinImport:off -- Package tests move real folders between projects and Libraries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { organizeScientSources, readScientSourcesOrganization } from "./collections.ts";
import {
  listScientReviewConflicts,
  resolveScientReviewConflict,
} from "./libraryReviewConflicts.ts";
import { changeScientLibraryReview, readScientLibraryReviewRecord } from "./libraryReviews.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  exportScientProjectPackage,
  importScientProjectPackage,
  scientProjectPackageInternals,
  undoScientProjectPackageImport,
} from "./projectPackage.ts";
import {
  pinScientLibrarySource,
  readScientProjectPinNoteHistory,
  readScientProjectPins,
  setScientProjectPinNote,
} from "./projectPins.ts";
import {
  attachScientSourcePdf,
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  recordScientSourceCheck,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";
import { editableMetadataFromRecord } from "./editable.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function computer(base: string, name: string) {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return scientLibraryLocation(root);
}

async function project(base: string, name: string): Promise<string> {
  const root = NodePath.join(base, name);
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  return NodeFSP.realpath(root);
}

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-package-")),
  );
  fixtures.push(base);
  return { base, mine: await computer(base, "mine"), source: await project(base, "source") };
}

const ada = { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null };

function candidate(key: string, overrides: Partial<ScientSourceCandidate> = {}) {
  return {
    sourceKey: key,
    type: "article",
    customType: null,
    title: `Study ${key}`,
    creators: [ada],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [],
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
    ...overrides,
  } satisfies ScientSourceCandidate;
}

async function add(
  library: ScientLibraryLocation,
  key: string,
  overrides: Partial<ScientSourceCandidate> = {},
) {
  const imported = await importScientSource({
    root: library,
    operationId: `op_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    candidate: candidate(key, overrides),
    allowPossibleMetadataMatch: true,
  });
  return imported.record!;
}

async function pinned(library: ScientLibraryLocation, root: string, sourceId: string) {
  const result = await pinScientLibrarySource({
    projectRoot: root,
    library,
    sourceId,
    actor: "user",
  });
  if (result.outcome === "not-found") throw new Error("Expected a pin.");
  return result.pin;
}

async function withPdf(library: ScientLibraryLocation, base: string, sourceId: string) {
  const pdf = NodePath.join(base, `${sourceId}.pdf`);
  await NodeFSP.writeFile(pdf, `%PDF-1.7\n${sourceId}\n`);
  const record = (await listScientSourceRecords(library)).find(
    (entry) => entry.sourceId === sourceId,
  )!;
  return attachScientSourcePdf({
    root: library,
    sourceId,
    expectedRevision: record.revision,
    pdfPath: pdf,
  });
}

const exportTo = (root: string, library: ScientLibraryLocation, folder: string) =>
  exportScientProjectPackage({ projectRoot: root, library, relativePath: folder });

const importInto = (root: string, library: ScientLibraryLocation, folder: string) =>
  importScientProjectPackage({ projectRoot: root, library, folder, actor: "user" });

describe("importing a project package", () => {
  it("checks a target found by its ID or an earlier mapping before joining it", async () => {
    const { base, mine, source } = await setup();
    const doi = { scheme: "doi", value: "10.1000/paper" };
    const paper = await add(mine, "paper", { title: "Shared paper", identifiers: [doi] });
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const correct = async (library: ScientLibraryLocation, sourceId: string, title: string) => {
      const record = (await listScientSourceRecords(library)).find(
        (entry) => entry.sourceId === sourceId,
      )!;
      await updateScientSourceMetadata({
        root: library,
        sourceId,
        expectedRevision: record.revision,
        metadata: {
          ...editableMetadataFromRecord(record),
          title,
          identifiers: [{ scheme: "doi", value: `10.1000/${sourceId}` }],
        },
      });
    };

    // A copy of this Library where the same ID now names another work.
    const copied = scientLibraryLocation(NodePath.join(base, "copied"));
    await NodeFSP.cp(mine.root, copied.root, { recursive: true });
    await correct(copied, paper.sourceId, "A different work");
    expect(await importInto(await project(base, "one"), copied, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
      pdfs: { added: 1 },
    });
    expect(
      (await listScientSourceRecords(copied)).find((entry) => entry.sourceId === paper.sourceId)
        ?.attachments,
    ).toHaveLength(1);

    // A target this project mapped on an earlier import, corrected since to another work.
    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    await importInto(received, theirs, handoff);
    const [mapped] = await listScientSourceRecords(theirs);
    await correct(theirs, mapped!.sourceId, "Another work entirely");
    expect(await importInto(received, theirs, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
    });
    expect(await listScientSourceRecords(theirs)).toHaveLength(2);
  });

  it("never takes title likeness for identity, so a PDF lands on its own work", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", { title: "Shared title" });
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    // Another computer holds a different work with the same title, lead author and year.
    const theirs = await computer(base, "theirs");
    const lookalike = await add(theirs, "lookalike", { title: "Shared title" });
    const received = await project(base, "received");
    expect(await importInto(received, theirs, handoff)).toMatchObject({
      sources: { added: 1, matched: 0 },
      pdfs: { added: 1 },
    });
    const records = await listScientSourceRecords(theirs);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.sourceId === lookalike.sourceId)?.attachments).toEqual(
      [],
    );
  });

  it("joins another copy's note history and pins written meanwhile, under one lock", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    const key = (await pinned(mine, source, paper.sourceId)).citationKey;
    const note = (text: string, base: string | null, root = source) =>
      setScientProjectPinNote({
        projectRoot: root,
        citationKey: key,
        note: text,
        base,
        actor: "agent",
      });
    await note("A", null);
    // A collaborator's copy branches here, then each side goes on.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    await note("B", "A");
    await note("C", "B");
    await note("D", "A", copy);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    expect(await importInto(copy, mine, handoff)).toMatchObject({
      pins: { notesKept: 1, historyAdded: 2 },
    });
    const history = await readScientProjectPinNoteHistory({ projectRoot: copy, citationKey: key });
    expect(history?.map((version) => version.note)).toEqual(["A", "B", "C", "D"]);
    expect(history?.at(-1)).toMatchObject({ note: "D", by: "agent" });

    // A project with no pins yet: another window writes the first one just before the import
    // gets the project's pins lock. Both pins stay.
    const fresh = await project(base, "fresh");
    const imported = await importScientProjectPackage({
      projectRoot: fresh,
      library: mine,
      folder: handoff,
      actor: "user",
      afterPinsLock: async () => {
        const file = JSON.parse(
          await NodeFSP.readFile(NodePath.join(source, ".scient/library/pins.json"), "utf8"),
        );
        file.pins = [{ ...file.pins[0], sourceId: "src_meanwhile", citationKey: "meanwhile" }];
        await NodeFSP.writeFile(
          NodePath.join(fresh, ".scient/library/pins.json"),
          `${JSON.stringify(file, null, 2)}\n`,
        );
      },
    });
    expect(imported).toMatchObject({ pins: { added: 1, addedKeys: [key] } });
    expect((await readScientProjectPins(fresh)).map((pin) => pin.citationKey).toSorted()).toEqual(
      [key, "meanwhile"].toSorted(),
    );
  });

  it("keeps both of two highlight branches that changed apart", () => {
    const { joinAnnotationFiles } = scientProjectPackageInternals;
    const mark = (revision: number, note: string) => ({
      annotationId: "ann_1",
      revision,
      anchor: { page: 1 },
      highlighted: true,
      note,
      updatedAt: `2026-11-0${revision}T00:00:00.000Z`,
      updatedBy: "user",
      deletedAt: null,
    });
    const entry = (revision: number, note: string) => {
      const { anchor: _anchor, deletedAt: _deleted, ...rest } = mark(revision, note);
      return rest;
    };
    const file = (current: ReturnType<typeof mark>, history: ReadonlyArray<object>) => ({
      formatVersion: 1,
      material: { sha256: "0".repeat(64), byteLength: 1 },
      paths: [],
      annotations: [current],
      history,
    });
    const notesOf = (joined: { file: Record<string, unknown> }) => ({
      current: (joined.file["annotations"] as Array<{ note: string; revision: number }>)[0],
      history: (joined.file["history"] as Array<{ note: string }>).map((version) => version.note),
    });

    // Both reached revision 2 from "a", with different notes.
    const equal = scientProjectPackageInternals.joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(2, "there"), [entry(1, "a")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(equal.conflicts).toBe(1);
    expect(notesOf(equal)).toMatchObject({ current: { note: "here", revision: 3 } });
    expect(notesOf(equal).history).toEqual(expect.arrayContaining(["a", "there"]));
    // Marked as brought, so the reader offers it.
    expect(
      (equal.file["history"] as Array<{ note: string; importedAt?: string }>).find(
        (version) => version.note === "there",
      )?.importedAt,
    ).toBe("2026-11-13T00:00:00.000Z");

    // The other went further, but not from this Library's note.
    const higher = joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(3, "there"), [entry(1, "a"), entry(2, "b")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(notesOf(higher)).toMatchObject({ current: { note: "here", revision: 4 } });
    expect(notesOf(higher).history).toEqual(expect.arrayContaining(["a", "b", "there"]));

    // The other went on from this Library's note: it simply wins.
    const ahead = joinAnnotationFiles(
      file(mark(2, "here"), [entry(1, "a")]),
      file(mark(3, "there"), [entry(1, "a"), entry(2, "here")]),
      "2026-11-13T00:00:00.000Z",
    );
    expect(ahead.conflicts).toBe(0);
    expect(notesOf(ahead).current).toMatchObject({ note: "there", revision: 3 });
  });

  it("carries a retraction notice and a structured abstract as brought, not checked here", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", {
      identifiers: [{ scheme: "doi", value: "10.1000/retracted" }],
      abstractSections: [
        { title: "Background", paragraphs: ["Why."] },
        { title: "Results", paragraphs: ["What."] },
      ],
    });
    await recordScientSourceCheck({
      root: mine,
      sourceId: paper.sourceId,
      expectedRevision: paper.revision,
      verification: { state: "verified", checkedAt: "2026-11-01T00:00:00.000Z" },
      editorialStatus: {
        state: "retracted",
        notices: [{ kind: "retraction", doi: "10.1000/notice" }],
        checkedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const theirs = await computer(base, "theirs");
    await importInto(await project(base, "received"), theirs, handoff);
    const [record] = await listScientSourceRecords(theirs);
    expect(record?.editorialStatus).toMatchObject({
      state: "retracted",
      checkedAt: "2026-11-01T00:00:00.000Z",
      carriedAt: expect.any(String),
    });
    expect(record?.verification).toMatchObject({
      state: "verified",
      carriedAt: expect.any(String),
    });
    expect(record?.abstractSections?.map((section) => section.title)).toEqual([
      "Background",
      "Results",
    ]);
  });

  it("brings a retraction and an abstract to a paper this computer checked as clear", async () => {
    const { base, mine, source } = await setup();
    const doi = { scheme: "doi", value: "10.1000/retracted" };
    const paper = await add(mine, "paper", { identifiers: [doi], abstract: "Why it matters." });
    await recordScientSourceCheck({
      root: mine,
      sourceId: paper.sourceId,
      expectedRevision: paper.revision,
      verification: { state: "verified", checkedAt: "2026-11-05T00:00:00.000Z" },
      editorialStatus: {
        state: "retracted",
        notices: [{ kind: "retraction", doi: "10.1000/notice" }],
        checkedAt: "2026-11-05T00:00:00.000Z",
      },
    });
    await pinned(mine, source, paper.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    const theirs = await computer(base, "theirs");
    const local = await add(theirs, "local", { title: paper.title, identifiers: [doi] });
    await recordScientSourceCheck({
      root: theirs,
      sourceId: local.sourceId,
      expectedRevision: local.revision,
      verification: { state: "verified", checkedAt: "2026-11-01T00:00:00.000Z" },
      editorialStatus: { state: "none", notices: [], checkedAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(await importInto(await project(base, "received"), theirs, handoff)).toMatchObject({
      sources: { added: 0, matched: 1 },
    });
    const [record] = await listScientSourceRecords(theirs);
    expect(record?.editorialStatus).toMatchObject({
      state: "retracted",
      notices: [{ kind: "retraction", doi: "10.1000/notice" }],
      carriedAt: expect.any(String),
    });
    // This computer's own check stays its own.
    expect(record?.verification).toEqual({
      state: "verified",
      checkedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(record?.abstract).toBe("Why it matters.");
  });

  it("keeps collection ancestry, so two Methods folders stay apart", async () => {
    const { base, mine, source } = await setup();
    const trial = await add(mine, "trial");
    const overview = await add(mine, "overview");
    for (const record of [trial, overview]) await pinned(mine, source, record.sourceId);
    const make = async (name: string, parentCollectionId?: string, sourceIds: string[] = []) =>
      (
        await organizeScientSources({
          root: mine,
          change: {
            action: "create-collection",
            name,
            sourceIds,
            ...(parentCollectionId ? { parentCollectionId } : {}),
          },
          actor: "user",
        })
      ).collection!.collectionId;
    await make("Methods", await make("Trials"), [trial.sourceId]);
    await make("Methods", await make("Reviews"), [overview.sourceId]);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    const theirs = await computer(base, "theirs");
    await importInto(await project(base, "received"), theirs, handoff);
    const { collections } = await readScientSourcesOrganization(theirs);
    const titleOf = new Map(
      (await listScientSourceRecords(theirs)).map((record) => [record.sourceId, record.title]),
    );
    const path = (collectionId: string | undefined): string => {
      const collection = collections.find((entry) => entry.collectionId === collectionId)!;
      return collection.parentCollectionId
        ? `${path(collection.parentCollectionId)}/${collection.name}`
        : collection.name;
    };
    expect(
      collections
        .filter((collection) => collection.sourceIds.length > 0)
        .map((collection) => [
          path(collection.collectionId),
          collection.sourceIds.map((id) => titleOf.get(id)),
        ])
        .toSorted(),
    ).toEqual([
      ["Reviews/Methods", ["Study overview"]],
      ["Trials/Methods", ["Study trial"]],
    ]);
  });

  it("reconciles snapshots apart from decisions, and reports a review it could not copy", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    await pinned(mine, source, paper.sourceId);
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: { action: "create-review", title: "Screening" },
      actor: "user",
    });
    await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: {
        action: "log-search",
        reviewId: reviewId!,
        database: "PubMed",
        query: "q",
        searchedOn: "2026-11-01",
        sourceIds: [paper.sourceId],
      },
      actor: "user",
    });
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const reviews = (root: string) => NodePath.join(root, ".scient/library/reviews");
    const snapshot = (root: string) => NodePath.join(reviews(root), `${reviewId}.works.json`);

    // The same decisions, but this copy lost its snapshot: it is added back.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    await NodeFSP.rm(snapshot(copy));
    expect(await importInto(copy, mine, handoff)).toMatchObject({
      reviews: { added: 0, conflicts: 0, snapshotsAdded: 1 },
    });
    expect(await NodeFSP.readFile(snapshot(copy), "utf8")).toBe(
      await NodeFSP.readFile(snapshot(source), "utf8"),
    );
    // The same decisions with another snapshot: the package's is kept as another version.
    await NodeFSP.writeFile(snapshot(copy), `${await NodeFSP.readFile(snapshot(copy), "utf8")} `);
    expect(await importInto(copy, mine, handoff)).toMatchObject({ reviews: { conflicts: 1 } });

    // A review that cannot be written is reported, never counted, and not half published.
    const blocked = await project(base, "blocked");
    await NodeFSP.mkdir(snapshot(blocked), { recursive: true });
    const result = await importInto(blocked, mine, handoff);
    expect(result).toMatchObject({
      reviews: { added: 0 },
      failed: [{ part: "review", item: reviewId }],
    });
    expect(await NodeFSP.readdir(reviews(blocked))).toEqual([`${reviewId}.works.json`]);
  });

  it("keeps a sharded snapshot's version readable, and choosing it loses no record", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper", { title: "Snapshot-only study" });
    await pinned(mine, source, paper.sourceId);
    const { reviewId } = await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: { action: "create-review", title: "Screening" },
      actor: "user",
    });
    // Another copy of the project, from before the search was logged.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.cp(source, copy, { recursive: true });
    await changeScientLibraryReview({
      projectRoot: source,
      library: mine,
      change: {
        action: "log-search",
        reviewId: reviewId!,
        database: "PubMed",
        query: "q",
        searchedOn: "2026-11-01",
        sourceIds: [paper.sourceId],
      },
      actor: "user",
    });
    // The snapshot in its sharded layout, as a large review keeps it.
    const reviews = NodePath.join(source, ".scient/library/reviews");
    await NodeFSP.mkdir(NodePath.join(reviews, `${reviewId}.works`));
    await NodeFSP.rename(
      NodePath.join(reviews, `${reviewId}.works.json`),
      NodePath.join(reviews, `${reviewId}.works`, "0.json"),
    );
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);

    const theirs = await computer(base, "theirs");
    expect(await importInto(copy, theirs, handoff)).toMatchObject({ reviews: { conflicts: 1 } });
    // The source is not in this Library: only the kept snapshot knows it.
    for (const record of await listScientSourceRecords(theirs)) {
      await removeScientSource({
        root: theirs,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      });
    }
    const [conflict] = await listScientReviewConflicts({ projectRoot: copy, reviewId: reviewId! });
    expect(
      await resolveScientReviewConflict({
        projectRoot: copy,
        library: theirs,
        reviewId: reviewId!,
        conflictId: conflict!.conflictId,
        pick: "use-other",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      await readScientLibraryReviewRecord({
        projectRoot: copy,
        library: theirs,
        mode: "read",
        reviewId: reviewId!,
        sourceId: paper.sourceId,
      }),
    ).toMatchObject({ from: "snapshot", record: { title: "Snapshot-only study" } });
  });

  it("keeps a receipt, and Undo removes what the import added", async () => {
    const { base, mine, source } = await setup();
    const paper = await add(mine, "paper");
    await withPdf(mine, base, paper.sourceId);
    await pinned(mine, source, paper.sourceId);
    await organizeScientSources({
      root: mine,
      change: { action: "create-collection", name: "Methods", sourceIds: [paper.sourceId] },
      actor: "user",
    });
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    expect(await NodeFSP.readFile(NodePath.join(handoff, "README.md"), "utf8")).toContain(
      '"import-package"',
    );

    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    const kept = await add(theirs, "kept");
    const imported = await importInto(received, theirs, handoff);
    if (imported.outcome !== "imported") throw new Error("Expected an import.");
    const { projectId } = JSON.parse(
      await NodeFSP.readFile(NodePath.join(received, ".scient/project.json"), "utf8"),
    );
    const undo = () =>
      undoScientProjectPackageImport({
        projectRoot: received,
        projectId,
        library: theirs,
        importId: imported.importId,
        actor: "user",
      });
    expect(await undo()).toEqual({ outcome: "undone", kept: [] });
    expect(await readScientProjectPins(received)).toEqual([]);
    expect((await listScientSourceRecords(theirs)).map((record) => record.sourceId)).toEqual([
      kept.sourceId,
    ]);
    expect((await listScientSourceTrash(theirs)).entries).toHaveLength(1);
    expect((await readScientSourcesOrganization(theirs)).collections).toEqual([]);
    expect(await undo()).toEqual({ outcome: "already-undone" });
  });

  it("Undo keeps what was changed since, and what a later import also uses", async () => {
    const { base, mine, source } = await setup();
    const edited = await add(mine, "edited");
    const noted = await add(mine, "noted");
    for (const record of [edited, noted]) await pinned(mine, source, record.sourceId);
    const handoff = NodePath.join(base, "handoff");
    await exportTo(source, mine, handoff);
    const imports = async (received: string, library: ScientLibraryLocation) => {
      const imported = await importInto(received, library, handoff);
      if (imported.outcome !== "imported") throw new Error("Expected an import.");
      const { projectId } = JSON.parse(
        await NodeFSP.readFile(NodePath.join(received, ".scient/project.json"), "utf8"),
      );
      return () =>
        undoScientProjectPackageImport({
          projectRoot: received,
          projectId,
          library,
          importId: imported.importId,
          actor: "user",
        });
    };

    // A source edited and a pin's note changed after the import stay; the rest goes.
    const theirs = await computer(base, "theirs");
    const received = await project(base, "received");
    const undo = await imports(received, theirs);
    const records = await listScientSourceRecords(theirs);
    const editedHere = records.find((record) => record.title === edited.title)!;
    await updateScientSourceMetadata({
      root: theirs,
      sourceId: editedHere.sourceId,
      expectedRevision: editedHere.revision,
      metadata: { ...editableMetadataFromRecord(editedHere), pages: "1-9" },
    });
    const notedPin = (await readScientProjectPins(received)).find(
      (pin) => pin.work.title === noted.title,
    )!;
    await setScientProjectPinNote({
      projectRoot: received,
      citationKey: notedPin.citationKey,
      note: "Mine now",
      actor: "user",
    });
    const result = await undo();
    expect(result).toMatchObject({ outcome: "undone" });
    expect(result.outcome === "undone" && result.kept.toSorted()).toEqual(
      [`pin ${notedPin.citationKey}`, `source ${editedHere.sourceId}`].toSorted(),
    );
    expect((await listScientSourceRecords(theirs)).map((record) => record.sourceId)).toEqual([
      editedHere.sourceId,
    ]);
    expect((await readScientProjectPins(received)).map((pin) => pin.citationKey)).toEqual([
      notedPin.citationKey,
    ]);

    // A second import of the same package joins what the first added: undoing the first keeps it.
    const other = await computer(base, "other");
    const again = await project(base, "again");
    const undoFirst = await imports(again, other);
    await imports(again, other);
    expect(await undoFirst()).toMatchObject({ outcome: "undone" });
    expect(await listScientSourceRecords(other)).toHaveLength(2);
    expect(await readScientProjectPins(again)).toHaveLength(2);
  });
});
