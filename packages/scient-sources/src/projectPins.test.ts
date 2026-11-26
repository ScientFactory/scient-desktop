// @effect-diagnostics nodeBuiltinImport:off -- Pin tests exercise real project and library folders.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { cslJsonItem, formatBibliography } from "./bibliography/index.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import { resolveScientProjectSources } from "./libraryInstanceMap.ts";
import { changeScientLibraryReview, refreshScientLibraryReviewSnapshot } from "./libraryReviews.ts";
import { withScientFileLock, withScientLibraryLock } from "./libraryLock.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import {
  bindScientProjectCitationKeys,
  changeScientProjectPins,
  listScientProjectPinnedWorks,
  decodeScientProjectPinsText,
  pinScientLibrarySource,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  renameScientProjectPinKey,
  resolveScientProjectPins,
  scientProjectPinsText,
  setScientProjectPinNote,
  unpinScientLibrarySource,
  unpinScientProjectWork,
} from "./projectPins.ts";
import {
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  readScientSourceRecord,
  removeScientSource,
  updateScientSourceMetadata,
} from "./store.ts";

vi.mock("./libraryLock.ts", { spy: true });

const fixtures: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pins-")),
  );
  fixtures.push(root);
  return root;
}

async function newLibrary(base: string, name: string) {
  const root = scientLibraryRootFor(NodePath.join(base, name));
  await ensureScientLibrary(root);
  return { root, library: scientLibraryLocation(root) };
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
    abstract: "Not copied into pins.",
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

async function addRecord(
  library: ReturnType<typeof scientLibraryLocation>,
  sourceKey: string,
  overrides: Partial<ScientSourceCandidate> = {},
): Promise<ScientSourceRecord> {
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(sourceKey, overrides),
    allowPossibleMetadataMatch: true,
  });
  if (!imported.record) throw new Error(`Expected ${sourceKey} to import.`);
  return imported.record;
}

async function renameKey(
  library: ReturnType<typeof scientLibraryLocation>,
  record: ScientSourceRecord,
  citationKey: string,
) {
  const current = await readScientSourceRecord(library, record.sourceId);
  if (!current) throw new Error("Expected the record.");
  const result = await updateScientSourceMetadata({
    root: library,
    sourceId: current.sourceId,
    expectedRevision: current.revision,
    metadata: { ...editableMetadataFromRecord(current), citationKey },
  });
  expect(result.outcome).toBe("updated");
}

async function tree(root: string): Promise<ReadonlyArray<string>> {
  return (await NodeFSP.readdir(root, { recursive: true })).toSorted();
}

describe("project pins", () => {
  it("copies the preferred key once, with a suffix on a clash in the project", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020deep" });
    const second = await addRecord(library, "B", { citationKey: "other2021" });

    const pinned = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: first.sourceId,
      actor: "agent",
      note: "Why I cite this here.",
    });
    expect(pinned).toMatchObject({
      outcome: "pinned",
      pin: { citationKey: "smith2020deep", note: "Why I cite this here." },
    });
    expect(pinned.outcome === "pinned" && pinned.pin.work).toEqual({
      type: "article",
      title: "Study A",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: "Journal",
      customType: null,
      issuedRaw: "2020",
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      more: {},
      tags: [],
    });

    await renameKey(library, first, "lovelace2020");
    await renameKey(library, second, "Smith2020Deep");
    const clashing = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: second.sourceId,
      actor: "user",
    });
    expect(clashing).toMatchObject({ outcome: "pinned", pin: { citationKey: "Smith2020Deepa" } });
    expect(
      await pinScientLibrarySource({
        projectRoot,
        library,
        sourceId: first.sourceId,
        actor: "user",
      }),
    ).toMatchObject({ outcome: "existing", pin: { citationKey: "smith2020deep" } });

    const refreshed = await refreshScientProjectPinSnapshots({ projectRoot, library });
    expect(refreshed.changed).toBe(false);
    expect(refreshed.pins.map((pin) => pin.citationKey)).toEqual([
      "smith2020deep",
      "Smith2020Deepa",
    ]);
    expect((await readScientSourceRecord(library, first.sourceId))?.note ?? null).toBeNull();

    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: "SMITH2020DEEP",
        note: null,
        base: "Why I cite this here.",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "updated", pin: { citationKey: "smith2020deep" } });
    expect((await readScientProjectPins(projectRoot))[0]).not.toHaveProperty("note");
    expect(
      await unpinScientLibrarySource({ projectRoot, citationKey: "smith2020deepa", actor: "user" }),
    ).toMatchObject({ outcome: "unpinned" });
    expect((await readScientProjectPins(projectRoot)).map((pin) => pin.citationKey)).toEqual([
      "smith2020deep",
    ]);
  });

  it("pins and unpins many at once with the outcomes and pins.json one at a time gives", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const [first, second, kept, gone] = [
      await addRecord(library, "A"),
      await addRecord(library, "B"),
      await addRecord(library, "C"),
      await addRecord(library, "D"),
    ];
    const one = await newProject(base, "one-by-one");
    const many = await newProject(base, "at-once");
    for (const projectRoot of [one, many]) {
      for (const record of [kept, gone]) {
        await pinScientLibrarySource({
          projectRoot,
          library,
          sourceId: record.sourceId,
          actor: "user",
        });
      }
    }
    const goneKey = (await readScientProjectPins(one)).find(
      (pin) => pin.sourceId === gone.sourceId,
    )!.citationKey;
    // The pin of a source removed from the Library is now a snapshot row.
    await removeScientSource({
      root: library,
      sourceId: gone.sourceId,
      expectedRevision: gone.revision,
    });
    const changes = [
      { action: "pin", sourceId: first.sourceId },
      { action: "pin", sourceId: second.sourceId },
      { action: "pin", sourceId: kept.sourceId },
      { action: "pin", sourceId: "src_missing" },
      { action: "pin", sourceId: "../outside" },
      { action: "unpin", citationKey: goneKey },
      { action: "unpin", citationKey: "nobody2020" },
      { action: "pin", sourceId: first.sourceId },
    ] as const;

    const loop = [];
    for (const change of changes) {
      loop.push(
        await (
          change.action === "pin"
            ? pinScientLibrarySource({
                projectRoot: one,
                library,
                sourceId: change.sourceId,
                actor: "user",
              })
            : unpinScientLibrarySource({
                projectRoot: one,
                citationKey: change.citationKey,
                actor: "user",
              })
        ).catch(() => ({ outcome: "refused" as const })),
      );
    }
    const batch = await changeScientProjectPins({
      projectRoot: many,
      library,
      changes,
      actor: "user",
    });

    const summary = (
      results: ReadonlyArray<{
        readonly outcome: string;
        readonly pin?: { readonly citationKey: string };
      }>,
    ) => results.map((result) => [result.outcome, result.pin?.citationKey]);
    expect(summary(batch)).toEqual(summary(loop));
    expect(summary(batch).map(([outcome]) => outcome)).toEqual([
      "pinned",
      "pinned",
      "existing",
      "not-found",
      "refused",
      "unpinned",
      "not-pinned",
      "existing",
    ]);
    const pinsOf = async (projectRoot: string) =>
      (await readScientProjectPins(projectRoot)).map(({ pinnedAt: _at, ...pin }) => pin);
    expect(await pinsOf(many)).toEqual(await pinsOf(one));
  });

  it("rewrites pins.json byte for byte and keeps fields from a newer Scient", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const record = await addRecord(library, "A", {
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
    });
    await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    file.pins[0].work.edition = "2nd";
    file.pins[0].shelf = "methods";
    file.teamLibraryId = "team_1";
    const withNewerFields = `${JSON.stringify(file, null, 2)}\n`;
    await NodeFSP.writeFile(pinsPath, withNewerFields);

    expect((await refreshScientProjectPinSnapshots({ projectRoot, library })).changed).toBe(false);
    await setScientProjectPinNote({
      projectRoot,
      citationKey: "lovelace2020study",
      note: "Kept.",
      actor: "user",
    });
    expect(JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"))).toMatchObject({
      teamLibraryId: "team_1",
      pins: [{ note: "Kept.", shelf: "methods", work: { edition: "2nd" } }],
    });
    await setScientProjectPinNote({
      projectRoot,
      citationKey: "lovelace2020study",
      note: null,
      base: "Kept.",
      actor: "user",
    });
    expect(await NodeFSP.readFile(pinsPath, "utf8")).toBe(withNewerFields);

    await renameKey(library, record, "lovelace2020renamed");
    const current = await readScientSourceRecord(library, record.sourceId);
    if (!current) throw new Error("Expected the record.");
    await updateScientSourceMetadata({
      root: library,
      sourceId: current.sourceId,
      expectedRevision: current.revision,
      metadata: { ...editableMetadataFromRecord(current), title: "Study A, revised" },
    });
    const refreshed = await refreshScientProjectPinSnapshots({ projectRoot, library });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.pins[0]).toMatchObject({
      citationKey: "lovelace2020study",
      work: { title: "Study A, revised" },
    });
  });

  it("resolves project source IDs in the design's order", async () => {
    const base = await fixture();
    const { library, root } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const byDoi = await addRecord(library, "DOI", {
      identifiers: [{ scheme: "doi", value: "10.1000/doi" }],
    });
    const byMetadata = await addRecord(library, "META", { title: "Metadata only" });
    const twinOne = await addRecord(library, "TWIN1", { title: "Twin study" });
    const twinTwo = await addRecord(library, "TWIN2", { title: "Twin study" });
    const loser = await addRecord(library, "LOSER", { title: "Merged away" });
    const survivor = await addRecord(library, "SURVIVOR", { title: "Merged into" });
    expect(
      await mergeScientLibrarySources({
        library,
        sourceIds: [loser.sourceId, survivor.sourceId],
        survivorId: survivor.sourceId,
      }),
    ).toMatchObject({ outcome: "merged" });
    const work = (title: string, identifiers: ScientSourceRecord["identifiers"] = []) => ({
      type: "article",
      title,
      creators: [ada],
      issuedYear: 2020,
      identifiers,
      containerTitle: null,
    });

    const sources = [
      { projectSourceId: loser.sourceId, work: null },
      {
        projectSourceId: "source_elsewhere_doi",
        work: work("Study DOI", [{ scheme: "doi", value: "https://doi.org/10.1000/DOI" }]),
      },
      { projectSourceId: "source_elsewhere_meta", work: work("Metadata only") },
      { projectSourceId: "source_elsewhere_twin", work: work("Twin study") },
    ];
    expect(
      await resolveScientProjectSources({ library, projectRoot, mode: "write", sources }),
    ).toEqual([
      {
        kind: "resolved",
        projectSourceId: loser.sourceId,
        sourceId: survivor.sourceId,
        by: "same-id",
      },
      {
        kind: "resolved",
        projectSourceId: "source_elsewhere_doi",
        sourceId: byDoi.sourceId,
        by: "identifier",
      },
      {
        kind: "resolved",
        projectSourceId: "source_elsewhere_meta",
        sourceId: byMetadata.sourceId,
        by: "metadata",
      },
      {
        kind: "unresolved",
        projectSourceId: "source_elsewhere_twin",
        reason: "ambiguous",
        candidateIds: expect.arrayContaining([twinOne.sourceId, twinTwo.sourceId]),
      },
    ]);
    expect(await NodeFSP.readdir(NodePath.join(root, "projects"))).toHaveLength(1);

    const fromMap = await resolveScientProjectSources({
      library,
      projectRoot,
      mode: "read",
      sources: sources.slice(1, 3).map(({ projectSourceId }) => ({ projectSourceId, work: null })),
    });
    expect(fromMap.map((resolution) => resolution.kind === "resolved" && resolution.by)).toEqual([
      "instance-map",
      "instance-map",
    ]);

    // Another change holds the Library lock; sources all in the map are answered without it.
    let release = () => {};
    let held = () => {};
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = withScientLibraryLock(root, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const whileHeld = await resolveScientProjectSources({
      library,
      projectRoot,
      mode: "write",
      sources: sources.slice(1, 3).map(({ projectSourceId }) => ({ projectSourceId, work: null })),
    });
    release();
    await holder;
    expect(whileHeld).toEqual(fromMap);

    // A merge or Undo half done (its receipt still pending) may have moved a record and not
    // yet its alias: the answer comes from the locked resolver.
    const receipt = NodePath.join(root, "merges", "pending", "undo_merge_test.json");
    await NodeFSP.mkdir(NodePath.dirname(receipt), { recursive: true });
    await NodeFSP.writeFile(receipt, "{}");
    const lock = vi.mocked(withScientLibraryLock);
    lock.mockClear();
    expect(
      await resolveScientProjectSources({
        library,
        projectRoot,
        mode: "write",
        sources: sources
          .slice(1, 3)
          .map(({ projectSourceId }) => ({ projectSourceId, work: null })),
      }),
    ).toEqual(fromMap);
    expect(lock).toHaveBeenCalled();
    await NodeFSP.rm(receipt);
  });

  it("hydrates unmatched report pins once, preserving their full citation without a Library", async () => {
    const base = await fixture();
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(author.library, "A", {
      type: "report",
      incompleteCreatorRoles: ["author"],
      more: { number: "TR-42", edition: "2", "publisher-place": "London" },
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
    });
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    const before = await tree(collaborator.root);

    const read = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "read",
      actor: "agent",
    });
    expect(read.map(({ resolution }) => resolution)).toEqual([
      {
        kind: "unresolved",
        projectSourceId: record.sourceId,
        reason: "no-match",
        candidateIds: [],
      },
    ]);
    const offline = await listScientProjectPinnedWorks({ projectRoot, library: null });
    expect(offline).toMatchObject([
      { citationKey: "lovelace2020study", from: "snapshot", record: { title: "Study A" } },
    ]);
    const saved = offline[0]!;
    expect(saved.incompleteSnapshot).toBe(false);
    expect(cslJsonItem(saved, { includeAbstracts: false, includeNotes: false })).toEqual(
      cslJsonItem(
        { record, citationKey: saved.citationKey },
        { includeAbstracts: false, includeNotes: false },
      ),
    );
    expect(cslJsonItem(saved, { includeNotes: false })).toMatchObject({
      type: "report",
      number: "TR-42",
      edition: "2",
      "publisher-place": "London",
    });
    const bibliography = formatBibliography([saved], "bibtex", {
      includeAbstracts: false,
      includeNotes: false,
    });
    expect(bibliography).toContain("author = {Lovelace, Ada and others}");
    expect(bibliography).toContain("number = {TR-42}");
    expect(bibliography).toContain("edition = {2}");
    expect(bibliography).toContain("address = {London}");
    const pins = await readScientProjectPins(projectRoot);
    expect(decodeScientProjectPinsText(scientProjectPinsText(pins))).toEqual(pins);
    expect(
      await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
    ).toEqual(offline);
    expect(await tree(collaborator.root)).toEqual(before);

    const written = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    expect(written[0]?.resolution).toMatchObject({ kind: "resolved", by: "hydrated" });
    const hydrated = await listScientSourceRecords(collaborator.library);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      citationKey: "lovelace2020study",
      title: "Study A",
      abstract: null,
      attachments: [],
      identifiers: [{ scheme: "doi", value: "10.1000/a" }],
      origin: { actor: "agent", intake: "file" },
      readingStatus: "unread",
      incompleteCreatorRoles: ["author"],
      more: { number: "TR-42", edition: "2", "publisher-place": "London" },
    });

    const again = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    expect(again[0]?.resolution).toEqual({
      kind: "resolved",
      projectSourceId: record.sourceId,
      sourceId: hydrated[0]?.sourceId,
      by: "instance-map",
    });
    expect(await listScientSourceRecords(collaborator.library)).toHaveLength(1);
    expect(
      await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
    ).toMatchObject([{ from: "library", record: { sourceId: hydrated[0]?.sourceId } }]);
    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    const [after] = await listScientProjectPinnedWorks({
      projectRoot,
      library: collaborator.library,
    });
    expect(after?.incompleteSnapshot).toBe(false);
    expect(
      formatBibliography([after!], "bibtex", { includeAbstracts: false, includeNotes: false }),
    ).toBe(bibliography);
    expect((await readScientProjectPins(projectRoot))[0]?.work).toEqual(pins[0]?.work);
  });

  it.each(["populated", "empty"] as const)(
    "keeps extended details unknown for an old %s snapshot through hydration, repinning and refresh",
    async (contents) => {
      const base = await fixture();
      const author = await newLibrary(base, "author");
      const projectRoot = await newProject(base);
      const record = await addRecord(author.library, "legacy", {
        type: "report",
        more: { number: "TR-42", edition: "2", "publisher-place": "London" },
      });
      await pinScientLibrarySource({
        projectRoot,
        library: author.library,
        sourceId: record.sourceId,
        actor: "user",
      });
      const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
      const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
      delete file.pins[0].work.more;
      if (contents === "empty") {
        file.pins[0].work = {
          ...file.pins[0].work,
          title: null,
          creators: [],
          issuedYear: null,
          issuedRaw: null,
          containerTitle: null,
        };
      }
      await NodeFSP.writeFile(pinsPath, `${JSON.stringify(file, null, 2)}\n`);
      expect(await listScientProjectPinnedWorks({ projectRoot, library: null })).toMatchObject([
        { incompleteSnapshot: true },
      ]);
      const collaborator = await newLibrary(base, "collaborator");
      await resolveScientProjectPins({
        projectRoot,
        library: collaborator.library,
        mode: "write",
        actor: "user",
      });
      await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
      expect((await readScientProjectPins(projectRoot))[0]?.work).not.toHaveProperty("more");
      expect(
        await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
      ).toMatchObject([{ incompleteSnapshot: true }]);
      const hydrated = (await listScientSourceRecords(collaborator.library))[0]!;
      const repinnedProject = await newProject(base, "repinned");
      await pinScientLibrarySource({
        projectRoot: repinnedProject,
        library: collaborator.library,
        sourceId: hydrated.sourceId,
        actor: "user",
      });
      expect((await readScientProjectPins(repinnedProject))[0]?.work).not.toHaveProperty("more");
      expect(
        await listScientProjectPinnedWorks({ projectRoot: repinnedProject, library: null }),
      ).toMatchObject([{ incompleteSnapshot: true }]);
      if (record.more === undefined) throw new Error("The fixture report details are missing.");
      await updateScientSourceMetadata({
        root: collaborator.library,
        sourceId: hydrated.sourceId,
        expectedRevision: hydrated.revision,
        metadata: { ...editableMetadataFromRecord(hydrated), more: record.more },
      });
      await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
      expect((await readScientProjectPins(projectRoot))[0]?.work.more).toEqual(record.more);
      expect(
        await listScientProjectPinnedWorks({ projectRoot, library: collaborator.library }),
      ).toMatchObject([{ incompleteSnapshot: false }]);
    },
  );

  it("keeps every unsupplied citation input unknown when a partially enriched legacy source is repinned", async () => {
    const base = await fixture();
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(author.library, "legacy-report", {
      type: "report",
      more: { number: "TR-42", edition: "2" },
    });
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    const { type, title, creators, issuedYear, identifiers, containerTitle } = file.pins[0].work;
    file.pins[0].work = { type, title, creators, issuedYear, identifiers, containerTitle };
    await NodeFSP.writeFile(pinsPath, JSON.stringify(file));
    const collaborator = await newLibrary(base, "collaborator");
    await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "user",
    });
    const [hydrated] = await listScientSourceRecords(collaborator.library);
    if (!hydrated) throw new Error("The legacy source was not hydrated.");
    const changed = await updateScientSourceMetadata({
      root: collaborator.library,
      sourceId: hydrated.sourceId,
      expectedRevision: hydrated.revision,
      metadata: { ...editableMetadataFromRecord(hydrated), more: { number: "TR-42" } },
    });
    expect(changed.outcome).toBe("updated");
    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    const repinned = await newProject(base, "repinned");
    await pinScientLibrarySource({
      projectRoot: repinned,
      library: collaborator.library,
      sourceId: hydrated.sourceId,
      actor: "user",
    });
    for (const root of [projectRoot, repinned]) {
      const [pin] = await readScientProjectPins(root);
      expect(pin?.work.more).toEqual({ number: "TR-42" });
      for (const unknown of [
        "customType",
        "issuedRaw",
        "publisher",
        "volume",
        "issue",
        "pages",
        "language",
        "url",
        "tags",
      ])
        expect(pin?.work).not.toHaveProperty(unknown);
      expect(
        await listScientProjectPinnedWorks({
          projectRoot: root,
          library: collaborator.library,
        }),
      ).toMatchObject([{ incompleteSnapshot: true }]);
      expect(
        await listScientProjectPinnedWorks({
          projectRoot: root,
          library: null,
        }),
      ).toMatchObject([{ incompleteSnapshot: true }]);
    }
  });

  it("keeps a snapshot's explicitly empty detail map known through hydration and repinning", async () => {
    const base = await fixture();
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(author.library, "known-empty");
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const collaborator = await newLibrary(base, "collaborator");
    await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "user",
    });
    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    const hydrated = (await listScientSourceRecords(collaborator.library))[0]!;
    const repinnedProject = await newProject(base, "repinned");
    await pinScientLibrarySource({
      projectRoot: repinnedProject,
      library: collaborator.library,
      sourceId: hydrated.sourceId,
      actor: "user",
    });
    for (const root of [projectRoot, repinnedProject]) {
      expect((await readScientProjectPins(root))[0]?.work.more).toEqual({});
      expect(
        await listScientProjectPinnedWorks({ projectRoot: root, library: null }),
      ).toMatchObject([{ incompleteSnapshot: false }]);
    }
  });

  it("never re-creates a removed work, even when the instance map is lost", async () => {
    const base = await fixture();
    const { root, library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const work = {
      type: "article",
      title: "Removed study",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: null,
    };
    const resolve = () =>
      resolveScientProjectSources({
        library,
        projectRoot,
        mode: "write",
        sources: [{ projectSourceId: "source_elsewhere", work }],
        hydrate: { actor: "agent" },
      });
    const [first] = await resolve();
    if (first?.kind !== "resolved") throw new Error("Expected the pin to hydrate.");
    const hydrated = await readScientSourceRecord(library, first.sourceId);
    if (!hydrated) throw new Error("Expected the hydrated record.");
    // The user edits it, so only its ID still ties it to the pin.
    await updateScientSourceMetadata({
      root: library,
      sourceId: hydrated.sourceId,
      expectedRevision: hydrated.revision,
      metadata: {
        ...editableMetadataFromRecord(hydrated),
        title: "Renamed",
        issuedRaw: "1999",
        issuedYear: 1999,
      },
    });
    const removed = await removeScientSource({
      root: library,
      sourceId: hydrated.sourceId,
      expectedRevision: hydrated.revision + 1,
    });
    expect(removed.outcome).toBe("removed");
    await NodeFSP.rm(NodePath.join(root, "projects"), { recursive: true });

    expect(await resolve()).toEqual([
      {
        kind: "unresolved",
        projectSourceId: "source_elsewhere",
        reason: "removed",
        candidateIds: [hydrated.sourceId],
      },
    ]);
    expect(await listScientSourceRecords(library)).toHaveLength(0);
    expect((await listScientSourceTrash(library)).entries).toHaveLength(1);
  });

  it("hydrates one record for two project sources of the same work", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const work = {
      type: "article",
      title: "Twice pinned",
      creators: [ada],
      issuedYear: 2020,
      identifiers: [],
      containerTitle: null,
    };
    const resolutions = await resolveScientProjectSources({
      library,
      projectRoot,
      mode: "write",
      sources: [
        { projectSourceId: "source_one", work },
        { projectSourceId: "source_two", work },
      ],
      hydrate: { actor: "agent" },
    });
    const records = await listScientSourceRecords(library);
    expect(records).toHaveLength(1);
    expect(resolutions).toMatchObject([
      { kind: "resolved", sourceId: records[0]?.sourceId, by: "hydrated" },
      { kind: "resolved", sourceId: records[0]?.sourceId, by: "metadata" },
    ]);
  });

  it("fills a linked record's missing citation details but preserves local values and explicit clears", async () => {
    const base = await fixture();
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const doi = [{ scheme: "doi", value: "10.1000/dated" }];
    const dated = await addRecord(author.library, "dated", {
      identifiers: doi,
      issuedRaw: "2021-03-04",
      issuedYear: 2021,
      more: { number: "foreign", edition: "2", "publisher-place": "London" },
    });
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: dated.sourceId,
      actor: "user",
    });
    // Another computer's copy: a year and no stored date, which import writes independently.
    const other = await newLibrary(base, "other");
    const local = await addRecord(other.library, "dated", {
      identifiers: doi,
      issuedRaw: null,
      issuedYear: 2021,
      more: { number: "local" },
    });

    const [work] = await listScientProjectPinnedWorks({ projectRoot, library: other.library });
    expect(work).toMatchObject({ from: "library", record: { issuedRaw: "2021-03-04" } });
    expect(cslJsonItem(work!, { includeNotes: false })).toMatchObject({
      number: "local",
      edition: "2",
      "publisher-place": "London",
    });
    await refreshScientProjectPinSnapshots({ projectRoot, library: other.library });
    expect((await readScientProjectPins(projectRoot))[0]?.work.issuedRaw).toBe("2021-03-04");
    expect((await readScientProjectPins(projectRoot))[0]?.work.more).toEqual({
      number: "local",
      edition: "2",
      "publisher-place": "London",
    });
    const edited = await updateScientSourceMetadata({
      root: other.library,
      sourceId: local.sourceId,
      expectedRevision: local.revision,
      metadata: {
        ...editableMetadataFromRecord(local),
        more: { number: "local", edition: "3", "publisher-place": "Oxford" },
      },
    });
    if (edited.outcome !== "updated") throw new Error("Expected citation details to update.");
    await updateScientSourceMetadata({
      root: other.library,
      sourceId: local.sourceId,
      expectedRevision: edited.record.revision,
      metadata: { ...editableMetadataFromRecord(edited.record), more: { number: "local" } },
    });
    await refreshScientProjectPinSnapshots({ projectRoot, library: other.library });
    const [cleared] = await listScientProjectPinnedWorks({ projectRoot, library: null });
    expect(cleared?.record.more).toEqual({ number: "local" });
  });

  it("reads a pins.json another writer changed, also once its decoded version is kept", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020" });
    const second = await addRecord(library, "B", { citationKey: "jones2021" });
    await pinScientLibrarySource({ projectRoot, library, sourceId: first.sourceId, actor: "user" });
    // Far past the file's timestamps, so the read keeps its decoded version.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2099-01-01T00:00:00.000Z"));
    const keys = async () =>
      (await readScientProjectPins(projectRoot)).map((pin) => pin.citationKey);
    expect(await keys()).toEqual(["smith2020"]);
    await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: second.sourceId,
      actor: "user",
    });
    expect(await keys()).toEqual(["jones2021", "smith2020"]);

    const pinsFile = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const text = await NodeFSP.readFile(pinsFile, "utf8");
    await NodeFSP.writeFile(pinsFile, text.replaceAll("jones2021", "jones2022"));
    expect(await keys()).toEqual(["jones2022", "smith2020"]);
  });

  it("renames a pin's project key, refusing one another pin uses", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020" });
    const second = await addRecord(library, "B", { citationKey: "jones2021" });
    for (const record of [first, second]) {
      await pinScientLibrarySource({
        projectRoot,
        library,
        sourceId: record.sourceId,
        actor: "agent",
      });
    }

    expect(
      await renameScientProjectPinKey({ projectRoot, citationKey: "smith2020", to: "Jones2021" }),
    ).toEqual({ outcome: "taken" });
    expect(
      await renameScientProjectPinKey({
        projectRoot,
        citationKey: "SMITH2020",
        to: "lovelace2020",
      }),
    ).toMatchObject({ outcome: "renamed", pin: { sourceId: first.sourceId } });
    expect((await readScientProjectPins(projectRoot)).map((pin) => pin.citationKey)).toEqual([
      "jones2021",
      "lovelace2020",
    ]);
    expect((await readScientSourceRecord(library, first.sourceId))?.citationKey).toBe("smith2020");
  });

  it("unpins a merged paper under each key it has when unpinned, never one given to another paper", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const loser = await addRecord(library, "A", { citationKey: "smith2020" });
    const survivor = await addRecord(library, "B", { citationKey: "jones2021" });
    const other = await addRecord(library, "C", { citationKey: "other2022" });
    for (const record of [loser, survivor, other]) {
      await pinScientLibrarySource({
        projectRoot,
        library,
        sourceId: record.sourceId,
        actor: "user",
      });
    }
    await mergeScientLibrarySources({
      library,
      sourceIds: [loser.sourceId, survivor.sourceId],
      survivorId: survivor.sourceId,
    });
    // Another window, as this unpin waits for the pins lock: jones2021 now cites the other paper.
    const pins = await readScientProjectPins(projectRoot);
    const replaced = pins
      .filter((pin) => pin.sourceId !== survivor.sourceId && pin.sourceId !== other.sourceId)
      .concat({
        ...pins.find((pin) => pin.sourceId === other.sourceId)!,
        citationKey: "jones2021",
      });
    const actual = await vi.importActual<typeof import("./libraryLock.ts")>("./libraryLock.ts");
    vi.mocked(withScientFileLock).mockImplementationOnce(async (lockPath, run, options) => {
      await NodeFSP.writeFile(
        NodePath.join(projectRoot, ".scient", "library", "pins.json"),
        scientProjectPinsText(replaced),
      );
      return actual.withScientFileLock(lockPath, run, options);
    });

    expect(
      await unpinScientProjectWork({
        projectRoot,
        library,
        citationKey: "smith2020",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "unpinned", alsoUnpinned: [] });
    expect(await readScientProjectPins(projectRoot)).toMatchObject([
      { citationKey: "jones2021", sourceId: other.sourceId },
    ]);
  });

  it("binds each key a manuscript cites a work by, never taking one that cites another", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const deep = await addRecord(library, "A", { citationKey: "lecun2015deep" });
    const other = await addRecord(library, "B", { citationKey: "smith2020" });
    await pinScientLibrarySource({ projectRoot, library, sourceId: other.sourceId, actor: "user" });
    const bind = (citationKeys: ReadonlyArray<string>) =>
      bindScientProjectCitationKeys({
        projectRoot,
        library,
        sourceId: deep.sourceId,
        citationKeys,
        actor: "user",
      });

    expect(await bind(["lecun2015deep", "lecun2015deep_copy", "SMITH2020"])).toEqual({
      outcome: "bound",
      bindings: [
        { citationKey: "lecun2015deep", outcome: "added" },
        { citationKey: "lecun2015deep_copy", outcome: "added" },
        { citationKey: "SMITH2020", outcome: "taken" },
      ],
    });
    const pinsAfter = async () =>
      (await readScientProjectPins(projectRoot)).map((pin) => [pin.citationKey, pin.sourceId]);
    const bound = await pinsAfter();
    expect(bound).toEqual([
      ["lecun2015deep", deep.sourceId],
      ["lecun2015deep_copy", deep.sourceId],
      ["smith2020", other.sourceId],
    ]);
    // The same keys again change nothing.
    expect((await bind(["lecun2015deep_copy", "lecun2015deep"])).outcome).toBe("bound");
    expect(await pinsAfter()).toEqual(bound);
    // Both keys reach the one work's bibliography entries.
    expect(
      (await listScientProjectPinnedWorks({ projectRoot, library })).map((work) => [
        work.citationKey,
        work.record.sourceId,
      ]),
    ).toEqual(bound);
  });

  it("pins a work whose every key cites another source under a key of its own", async () => {
    const base = await fixture();
    const { library } = await newLibrary(base, "state");
    const projectRoot = await newProject(base);
    const first = await addRecord(library, "A", { citationKey: "smith2020" });
    const second = await addRecord(library, "B", { citationKey: "smith2020b" });
    await pinScientLibrarySource({ projectRoot, library, sourceId: first.sourceId, actor: "user" });

    const bound = await bindScientProjectCitationKeys({
      projectRoot,
      library,
      sourceId: second.sourceId,
      citationKeys: ["smith2020"],
      actor: "user",
    });
    expect(bound).toEqual({
      outcome: "bound",
      bindings: [{ citationKey: "smith2020", outcome: "taken" }],
      projectKey: "smith2020b",
    });
    expect((await readScientProjectPins(projectRoot)).map((pin) => pin.sourceId)).toEqual([
      first.sourceId,
      second.sourceId,
    ]);
  });
});

describe("pins of works with thousands of authors", () => {
  const consortium = Array.from({ length: 7_992 }, (_, index) => ({
    ...ada,
    givenName: `Author ${index + 1}`,
  }));
  const pinsPath = (projectRoot: string) =>
    NodePath.join(projectRoot, ".scient", "library", "pins.json");
  const storedWork = async (projectRoot: string) =>
    JSON.parse(await NodeFSP.readFile(pinsPath(projectRoot), "utf8")).pins[0].work;

  /** A project whose pin lists every author, as Scient wrote it before saved copies were cut. */
  async function legacyPin(base: string) {
    const author = await newLibrary(base, "author");
    const projectRoot = await newProject(base);
    const record = await addRecord(author.library, "trial", {
      creators: consortium,
      identifiers: [{ scheme: "doi", value: "10.1000/trial" }],
    });
    const pinned = await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: record.sourceId,
      actor: "user",
    });
    if (pinned.outcome === "not-found") throw new Error("Expected the pin.");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath(projectRoot), "utf8"));
    const { creatorCount: _count, incompleteCreatorRoles: _roles, ...work } = file.pins[0].work;
    file.pins[0].work = { ...work, creators: consortium };
    await NodeFSP.writeFile(pinsPath(projectRoot), `${JSON.stringify(file, null, 2)}\n`);
    return { author, projectRoot, record, citationKey: pinned.pin.citationKey };
  }

  it("keeps a pin's only full author list until a record holds it", async () => {
    const base = await fixture();
    const { projectRoot, citationKey } = await legacyPin(base);
    const collaborator = await newLibrary(base, "collaborator");

    await setScientProjectPinNote({
      projectRoot,
      citationKey,
      note: "Primary trial.",
      actor: "user",
    });
    expect((await storedWork(projectRoot)).creators).toEqual(consortium);

    await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    const [hydrated] = await listScientSourceRecords(collaborator.library);
    expect(hydrated?.creators).toEqual(consortium);

    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    const work = await storedWork(projectRoot);
    expect(work.creators).toEqual(consortium.slice(0, 256));
    expect(work.creatorCount).toBe(7_992);
    expect(work.incompleteCreatorRoles).toEqual(["author"]);
  });

  it("keeps the whole author count through a record hydrated from the cut copy", async () => {
    const base = await fixture();
    const { author, projectRoot, record } = await legacyPin(base);
    const created = await changeScientLibraryReview({
      projectRoot,
      library: author.library,
      change: { action: "create-review", title: "Trials" },
      actor: "user",
    });
    const reviewId = created.reviewId!;
    await changeScientLibraryReview({
      projectRoot,
      library: author.library,
      change: { action: "add-sources", reviewId, sourceIds: [record.sourceId] },
      actor: "user",
    });
    await refreshScientProjectPinSnapshots({ projectRoot, library: author.library });
    const reviewEntry = async () =>
      JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(projectRoot, ".scient", "library", "reviews", `${reviewId}.works.json`),
          "utf8",
        ),
      ).records[record.sourceId];
    expect((await reviewEntry()).creatorCount).toBe(7_992);

    const collaborator = await newLibrary(base, "collaborator");
    await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    const [hydrated] = await listScientSourceRecords(collaborator.library);
    expect(hydrated?.creators).toHaveLength(256);

    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    await refreshScientLibraryReviewSnapshot({
      projectRoot,
      library: collaborator.library,
      reviewId,
    });
    expect(await storedWork(projectRoot)).toMatchObject({
      creators: consortium.slice(0, 256),
      creatorCount: 7_992,
      incompleteCreatorRoles: ["author"],
    });
    expect((await reviewEntry()).creatorCount).toBe(7_992);
  });

  it("cites a pin's full author list over a shortened record that begins the same", async () => {
    const base = await fixture();
    const { projectRoot } = await legacyPin(base);
    const collaborator = await newLibrary(base, "collaborator");
    await addRecord(collaborator.library, "trial", {
      creators: consortium.slice(0, 256),
      incompleteCreatorRoles: ["author"],
      identifiers: [{ scheme: "doi", value: "10.1000/trial" }],
    });

    const [work] = await listScientProjectPinnedWorks({
      projectRoot,
      library: collaborator.library,
    });
    expect(work?.from).toBe("library");
    expect(work?.record.creators).toEqual(consortium);
    expect(work?.record).not.toHaveProperty("incompleteCreatorRoles");
    expect(work?.incompleteSnapshot).toBe(false);
  });

  it("reads past a pin it cannot read or a count it cannot use, and keeps that pin as written", async () => {
    const base = await fixture();
    const { author, projectRoot, citationKey } = await legacyPin(base);
    const other = await addRecord(author.library, "other");
    await pinScientLibrarySource({
      projectRoot,
      library: author.library,
      sourceId: other.sourceId,
      actor: "user",
    });
    const file = JSON.parse(await NodeFSP.readFile(pinsPath(projectRoot), "utf8"));
    const trial = file.pins.find((pin: { citationKey: string }) => pin.citationKey === citationKey);
    trial.work.creatorCount = 0;
    const unreadable = {
      ...trial,
      citationKey: "unreadable2020",
      sourceId: "src_unreadable",
      work: { ...trial.work, creators: [{ creatorType: "" }] },
    };
    file.pins.push(unreadable);
    await NodeFSP.writeFile(pinsPath(projectRoot), `${JSON.stringify(file, null, 2)}\n`);

    const pins = await readScientProjectPins(projectRoot);
    expect(pins.map((pin) => pin.sourceId).toSorted()).toEqual(
      [trial.sourceId, other.sourceId].toSorted(),
    );
    expect(pins.find((pin) => pin.citationKey === citationKey)?.work).not.toHaveProperty(
      "creatorCount",
    );

    await setScientProjectPinNote({
      projectRoot,
      citationKey,
      note: "Primary trial.",
      actor: "user",
    });
    const written = JSON.parse(await NodeFSP.readFile(pinsPath(projectRoot), "utf8"));
    expect(written.pins).toContainEqual(unreadable);
    expect(written.pins).toHaveLength(3);
  });

  it("serves a pin from its copy when its full list is too long for a record", async () => {
    const base = await fixture();
    const { projectRoot } = await legacyPin(base);
    const larger = Array.from({ length: 18_000 }, (_, index) => ({
      ...ada,
      givenName: `Author ${index + 1}`,
    }));
    const file = JSON.parse(await NodeFSP.readFile(pinsPath(projectRoot), "utf8"));
    file.pins[0].work.creators = larger;
    await NodeFSP.writeFile(pinsPath(projectRoot), `${JSON.stringify(file, null, 2)}\n`);
    const collaborator = await newLibrary(base, "collaborator");

    const [resolved] = await resolveScientProjectPins({
      projectRoot,
      library: collaborator.library,
      mode: "write",
      actor: "agent",
    });
    expect(resolved?.resolution).toMatchObject({ kind: "unresolved", reason: "no-match" });
    expect(await listScientSourceRecords(collaborator.library)).toEqual([]);
    const [work] = await listScientProjectPinnedWorks({
      projectRoot,
      library: collaborator.library,
    });
    expect(work).toMatchObject({ from: "snapshot", incompleteSnapshot: false });
    expect(work?.record.creators).toEqual(larger);
  });

  it("keeps the whole author count over a short record listing more names than the copy", async () => {
    const base = await fixture();
    const { author, projectRoot } = await legacyPin(base);
    await refreshScientProjectPinSnapshots({ projectRoot, library: author.library });
    const collaborator = await newLibrary(base, "collaborator");
    await addRecord(collaborator.library, "trial", {
      creators: consortium.slice(0, 500),
      incompleteCreatorRoles: ["author"],
      identifiers: [{ scheme: "doi", value: "10.1000/trial" }],
    });

    await refreshScientProjectPinSnapshots({ projectRoot, library: collaborator.library });
    expect(await storedWork(projectRoot)).toMatchObject({
      creators: consortium.slice(0, 256),
      creatorCount: 7_992,
      incompleteCreatorRoles: ["author"],
    });
  });
});
