// @effect-diagnostics nodeBuiltinImport:off -- Library tests exercise the real library filesystem layout.
// @effect-diagnostics globalDate:off -- The index trusts timestamps by wall-clock age.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  bulkUpdateScientSources,
  organizeScientSources,
  readScientSourcesOrganization,
} from "./collections.ts";
import { listScientLibraryRecentChanges } from "./libraryChanges.ts";
import {
  ensureScientLibrary,
  listScientLibraryInstances,
  registerScientLibraryInstance,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import {
  createSourceImportOperation,
  decodePersistedScientSourceRecord,
  importScientSource,
  importScientSourceOperationItem,
  inspectScientLibrarySources,
  listScientSourceRecords,
  listScientSourceTrash,
  listScientSourceRevisions,
  readScientSourceRecord,
  removeScientSource,
  revertScientSource,
  setScientLibraryReadingState,
  sourceAttachmentAbsolutePath,
  updateScientSourceMetadata,
  updateScientSourceNote,
  updateSourceImportOperationItem,
  warmScientLibraryRecordIndex,
} from "./store.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

vi.mock("node:fs/promises", { spy: true });

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-")),
  );
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const candidate = (sourceKey: string, title: string): ScientSourceCandidate =>
  sourceCandidate({
    sourceKey,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
    containerTitle: "Journal",
    language: "en",
  });

async function newLibrary() {
  const stateDir = await fixture();
  const root = scientLibraryRootFor(stateDir);
  expect(root).toBe(NodePath.join(stateDir, "scient", "library"));
  const manifest = await ensureScientLibrary(root);
  return { root, manifest, library: scientLibraryLocation(root) };
}

describe("personal library store", () => {
  it("keeps records, PDFs, trash and collections in the library layout", async () => {
    const { root, manifest, library } = await newLibrary();
    expect(await ensureScientLibrary(root)).toEqual(manifest);
    const pdfPath = NodePath.join(NodePath.dirname(NodePath.dirname(root)), "paper.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nfixture\n");

    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: { ...candidate("ABC123", "A library source"), pdfAvailable: true },
      pdfPath,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");
    const file: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "records", `${record.sourceId}.json`), "utf8"),
    );
    expect(file).toMatchObject({ formatVersion: 2, sourceId: record.sourceId });
    expect(file).not.toHaveProperty("projectId");
    const attachment = record.attachments[0];
    if (!attachment) throw new Error("Expected the PDF attachment.");
    expect(sourceAttachmentAbsolutePath(library, attachment)).toContain(
      NodePath.join(root, "files", "sha256"),
    );

    const parent = await organizeScientSources({
      root: library,
      change: { action: "create-collection", name: "Methods", sourceIds: [record.sourceId] },
      actor: "user",
    });
    const child = await organizeScientSources({
      root: library,
      change: {
        action: "create-collection",
        name: "Chapter 2",
        ...(parent.collection ? { parentCollectionId: parent.collection.collectionId } : {}),
      },
      actor: "agent",
    });
    expect((await NodeFSP.readdir(NodePath.join(root, "collections"))).toSorted()).toEqual(
      [
        `${parent.collection?.collectionId}.json`,
        `${child.collection?.collectionId}.json`,
      ].toSorted(),
    );
    const organization = await readScientSourcesOrganization(library);
    expect(organization.issue).toBeUndefined();
    expect(
      organization.collections.map((collection) => [
        collection.name,
        collection.parentCollectionId,
        collection.sourceIds,
      ]),
    ).toEqual([
      ["Methods", undefined, [record.sourceId]],
      ["Chapter 2", parent.collection?.collectionId, []],
    ]);

    await removeScientSource({
      root: library,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
    });
    expect((await listScientSourceTrash(library)).entries.map((entry) => entry.sourceId)).toEqual([
      record.sourceId,
    ]);
    expect((await NodeFSP.readdir(root)).toSorted()).toEqual([
      "collections",
      "files",
      "history",
      "library.json",
      "library.lock",
      "records",
      "staging",
      "trash",
    ]);
  });

  it("keeps reading status on library records only", async () => {
    const { root, library } = await newLibrary();
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("READ1", "A library source"),
    });
    const filePath = NodePath.join(root, "records", `${imported.record?.sourceId}.json`);
    const { readingStatus, starred, ...older } = JSON.parse(
      await NodeFSP.readFile(filePath, "utf8"),
    );
    expect([readingStatus, starred]).toEqual(["unread", false]);
    expect(decodePersistedScientSourceRecord(older)).toMatchObject({
      readingStatus: "unread",
      starred: false,
    });

    const projectRoot = await fixture();
    await initializeScientProject({ root: projectRoot });
    const project = await importScientSource({
      root: projectRoot,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("READ2", "A project source"),
    });
    const projectFile = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(
          projectRoot,
          ".scient",
          "sources",
          "records",
          `${project.record?.sourceId}.json`,
        ),
        "utf8",
      ),
    );
    expect(projectFile).not.toHaveProperty("readingStatus");
    expect(
      decodePersistedScientSourceRecord({ ...projectFile, readingStatus: "read", starred: true }),
    ).not.toHaveProperty("readingStatus");
  });

  it("sets reading state on one or many sources without a revision, and a revert keeps it", async () => {
    const { library } = await newLibrary();
    const [first, second] = await Promise.all(
      ["READ3", "READ4"].map((key) =>
        importScientSource({
          root: library,
          operationId: NodeCrypto.randomUUID(),
          candidate: candidate(key, `Source ${key}`),
        }).then((imported) => imported.record!),
      ),
    );
    const retitled = await updateScientSourceMetadata({
      root: library,
      sourceId: first!.sourceId,
      expectedRevision: 1,
      metadata: { ...editableMetadataFromRecord(first!), title: "Second revision" },
    });
    expect(retitled.outcome).toBe("updated");

    const changes = await setScientLibraryReadingState({
      library,
      sourceIds: [first!.sourceId, second!.sourceId, "source_missing"],
      readingStatus: "read",
    });
    expect(changes).toEqual([
      { sourceId: first!.sourceId, outcome: "updated", readingStatus: "read", starred: false },
      { sourceId: second!.sourceId, outcome: "updated", readingStatus: "read", starred: false },
      { sourceId: "source_missing", outcome: "not-found" },
    ]);
    const starred = await setScientLibraryReadingState({
      library,
      sourceIds: [first!.sourceId],
      starred: true,
    });
    expect(starred).toEqual([
      { sourceId: first!.sourceId, outcome: "updated", readingStatus: "read", starred: true },
    ]);
    expect(
      await setScientLibraryReadingState({ library, sourceIds: [first!.sourceId], starred: true }),
    ).toMatchObject([{ outcome: "unchanged" }]);
    expect(await readScientSourceRecord(library, first!.sourceId)).toMatchObject({
      revision: 2,
      readingStatus: "read",
      starred: true,
    });
    expect(
      (await listScientSourceRevisions(library, first!.sourceId))?.map((entry) => entry.changes),
    ).toEqual([["title"], []]);

    const reverted = await revertScientSource({
      root: library,
      sourceId: first!.sourceId,
      expectedRevision: 2,
      toRevision: 1,
    });
    expect(reverted.outcome).toBe("reverted");
    const after = await readScientSourceRecord(library, first!.sourceId);
    expect(after).toMatchObject({
      revision: 3,
      title: first!.title,
      readingStatus: "read",
      starred: true,
    });
  });

  it("keeps what the person kept on a trashed paper when it is imported again", async () => {
    const { library } = await newLibrary();
    const pdfDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-reimport-"));
    fixtures.push(pdfDirectory);
    const pdf = async (name: string) => {
      const path = NodePath.join(pdfDirectory, `${name}.pdf`);
      await NodeFSP.writeFile(path, `%PDF-1.7\n${name}\n`);
      return path;
    };
    const again = async (name: string) =>
      importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("TRASHED1", "Source TRASHED1"),
        pdfPath: await pdf(name),
      });
    const first = (await again("first")).record!;
    const noted = await updateScientSourceNote({
      root: library,
      sourceId: first.sourceId,
      expectedRevision: first.revision,
      note: "Key figure on page 4.",
    });
    await setScientLibraryReadingState({ library, sourceIds: [first.sourceId], starred: true });
    await removeScientSource({
      root: library,
      sourceId: first.sourceId,
      expectedRevision: noted.record.revision,
    });

    const back = await again("second");
    expect(back).toMatchObject({
      outcome: "imported",
      record: {
        sourceId: first.sourceId,
        citationKey: first.citationKey,
        note: "Key figure on page 4.",
        starred: true,
      },
    });
    expect(back.record!.attachments).toHaveLength(2);
    expect(back.record!.attachments[0]).toEqual(first.attachments[0]);
    expect((await listScientSourceTrash(library)).entries).toEqual([]);
    for (const attachment of back.record!.attachments) {
      await expect(
        NodeFSP.stat(sourceAttachmentAbsolutePath(library, attachment)),
      ).resolves.toBeTruthy();
    }
  });

  it("keeps one version per My note editing session, however often it saves", async () => {
    const { library } = await newLibrary();
    const record = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("NOTE1", "Source NOTE1"),
      })
    ).record!;
    let current = record;
    const save = async (note: string, session: string) => {
      const result = await updateScientSourceNote({
        root: library,
        sourceId: record.sourceId,
        expectedRevision: current.revision,
        expectedNote: current.note ?? null,
        note,
        session,
      });
      current = result.record;
      return result;
    };
    for (const note of ["R", "Re", "Read", "Read for methods."]) await save(note, "session-1");
    expect(current.note).toBe("Read for methods.");
    expect(await listScientSourceRevisions(library, record.sourceId)).toHaveLength(2);

    // A real edit in between starts a new version, and so does another session.
    const retitled = await updateScientSourceMetadata({
      root: library,
      sourceId: record.sourceId,
      expectedRevision: current.revision,
      metadata: { ...editableMetadataFromRecord(current), title: "A corrected title" },
    });
    current = retitled.record;
    await save("Read for methods. Again.", "session-1");
    await save("Read for methods. Again!", "session-1");
    await save("Another editor.", "session-2");
    expect(
      (await listScientSourceRevisions(library, record.sourceId))?.map((entry) => entry.changes),
    ).toEqual([["note"], ["note"], ["title"], ["note"], []]);
    expect(current.note).toBe("Another editor.");
  });

  it("refuses a revision-checked write that missed a later autosave of the same version", async () => {
    const { library } = await newLibrary();
    let current = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("NOTE2", "Source NOTE2"),
      })
    ).record!;
    const save = async (note: string) => {
      current = (
        await updateScientSourceNote({
          root: library,
          sourceId: current.sourceId,
          expectedRevision: current.revision,
          expectedNote: current.note ?? null,
          note,
          session: "editor",
        })
      ).record;
    };
    await save("First thought.");
    // An agent or a Zotero refresh reads this, then the editor saves again.
    const seen = current;
    await save("First thought, revised.");

    const zotero = await updateScientSourceMetadata({
      root: library,
      sourceId: seen.sourceId,
      expectedRevision: seen.revision,
      metadata: { ...editableMetadataFromRecord(seen), title: "Zotero's title" },
      note: "Zotero's note",
    });
    const agent = await updateScientSourceNote({
      root: library,
      sourceId: seen.sourceId,
      expectedRevision: seen.revision,
      note: `${seen.note} Added by the agent.`,
      actor: "agent",
    });
    expect([agent.outcome, zotero.outcome]).toEqual(["stale", "stale"]);
    expect(await readScientSourceRecord(library, seen.sourceId)).toMatchObject({
      note: "First thought, revised.",
      title: "Source NOTE2",
    });
    expect(
      (await listScientSourceRevisions(library, seen.sourceId))?.map((entry) => entry.changes),
    ).toEqual([["note"], []]);
  });

  // The next autosave lands right after Undo's n-th read of the paper's record: before it plans,
  // between the plan's read and its history read, and after both. Later reads hold the write lock.
  it.each([1, 2, 3])("undoes a bulk edit while My note is being typed (%i)", async (n) => {
    const { root, library } = await newLibrary();
    let current = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("NOTE3", "Source NOTE3"),
      })
    ).record!;
    const bulk = await bulkUpdateScientSources({
      root: library,
      change: { sourceIds: [current.sourceId], addTags: ["Screened"] },
      actor: "user",
    });
    current = (await readScientSourceRecord(library, current.sourceId))!;
    const save = async (note: string) => {
      current = (
        await updateScientSourceNote({
          root: library,
          sourceId: current.sourceId,
          expectedRevision: current.revision,
          expectedNote: current.note ?? null,
          note,
          session: "editor",
        })
      ).record;
    };
    for (const note of ["T", "Ty"]) await save(note);
    const recordFile = NodePath.join(root, "records", `${current.sourceId}.json`);
    const { readFile } = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    let reads = 0;
    let typed: Promise<void> | undefined;
    using _typing = vi.spyOn(NodeFSP, "readFile").mockImplementation((async (
      path: Parameters<typeof readFile>[0],
      options?: Parameters<typeof readFile>[1],
    ) => {
      const bytes = await readFile(path, options);
      if (String(path) === recordFile && typed === undefined && (reads += 1) === n) {
        await (typed = save("Typed."));
      }
      return bytes;
    }) as typeof readFile);
    const undone = await bulkUpdateScientSources({
      root: library,
      change: { undoBatchId: bulk.undo?.batchId ?? "" },
      actor: "user",
    });
    expect(typed).toBeDefined();
    expect(undone.conflicts ?? []).toEqual([]);
    expect(await readScientSourceRecord(library, current.sourceId)).toMatchObject({
      tags: [],
      note: "Typed.",
    });
  });

  it("edits a source starred after a write that stopped once its earlier version was kept", async () => {
    const { root, library } = await newLibrary();
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("STOP1", "Source STOP1"),
    });
    const sourceId = imported.record!.sourceId;
    // What a note edit stopped between keeping revision 1 and writing revision 2 leaves.
    const history = NodePath.join(root, "history", sourceId, "1.json");
    await NodeFSP.mkdir(NodePath.dirname(history), { recursive: true });
    await NodeFSP.copyFile(NodePath.join(root, "records", `${sourceId}.json`), history);
    await setScientLibraryReadingState({ library, sourceIds: [sourceId], starred: true });

    const noted = await updateScientSourceNote({
      root: library,
      sourceId,
      expectedRevision: 1,
      note: "Written after the star.",
    });
    expect(noted.outcome).toBe("updated");
    expect(await readScientSourceRecord(library, sourceId)).toMatchObject({
      revision: 2,
      starred: true,
      note: "Written after the star.",
    });
  });

  it("refuses a library record that names a project", () => {
    expect(() =>
      decodePersistedScientSourceRecord({
        formatVersion: 2,
        sourceId: "source_1",
        projectId: "project_1",
      }),
    ).toThrow("must not name a project");
  });

  it("answers from its index until a record file changes", async () => {
    const { library } = await newLibrary();
    for (const key of ["ONE", "TWO"]) {
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate(key, `Source ${key}`),
      });
    }
    // An hour later every timestamp is old enough for the index to trust it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const first = await listScientSourceRecords(library);
    expect(await listScientSourceRecords(library)).toBe(first);
    vi.useRealTimers();

    const kept = first[0];
    if (!kept) throw new Error("Expected a record.");
    await updateScientSourceNote({
      root: library,
      sourceId: kept.sourceId,
      expectedRevision: kept.revision,
      note: "Read this first.",
    });
    const after = await listScientSourceRecords(library);
    expect(after).toHaveLength(2);
    expect(after.find((record) => record.sourceId === kept.sourceId)?.note).toBe(
      "Read this first.",
    );
  });

  it("sees a record file edited in place once the folder is no longer trusted alone", async () => {
    const { root, library } = await newLibrary();
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("EDIT", "Before"),
    });
    if (!imported.record) throw new Error("Expected an imported record.");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect((await listScientSourceRecords(library))[0]?.title).toBe("Before");

    const filePath = NodePath.join(root, "records", `${imported.record.sourceId}.json`);
    const file = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as Record<string, unknown>;
    await NodeFSP.writeFile(filePath, JSON.stringify({ ...file, title: "After" }));
    vi.setSystemTime(Date.now() + 60 * 1000);
    expect((await listScientSourceRecords(library))[0]?.title).toBe("After");
  });

  it("changes the list revision when a record is rewritten between its stat and its read", async () => {
    const { root, library } = await newLibrary();
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("RACE", "Before"),
    });
    if (!imported.record) throw new Error("Expected an imported record.");
    const before = await inspectScientLibrarySources(library);
    const filePath = NodePath.join(root, "records", `${imported.record.sourceId}.json`);
    const statsBefore = await NodeFSP.lstat(filePath, { bigint: true });
    const file = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as Record<string, unknown>;
    await NodeFSP.writeFile(filePath, JSON.stringify({ ...file, title: "After" }));
    const { lstat } = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    // The scan's stat saw the file before the rewrite; its read sees the new contents.
    using _stale = vi
      .spyOn(NodeFSP, "lstat")
      .mockImplementation((async (
        path: Parameters<typeof lstat>[0],
        options?: Parameters<typeof lstat>[1],
      ) => (path === filePath ? statsBefore : lstat(path, options))) as typeof lstat);
    const after = await inspectScientLibrarySources(library);
    expect(after.records[0]?.title).toBe("After");
    expect(after.recordsRevision).toBeDefined();
    expect(after.recordsRevision).not.toBe(before.recordsRevision);
  });

  it("warms the record index only at its threshold, and a stopped warming keeps none", async () => {
    // Edited in place, a file leaves its folder's timestamps alone: only an index built before
    // the edit still answers with the old title.
    const editedTitle = async (warm: (library: ScientLibraryLocation) => Promise<unknown>) => {
      const { root, library } = await newLibrary();
      const imported = await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("ONE", "Source ONE"),
      });
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("TWO", "Source TWO"),
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      await warm(library);
      const filePath = NodePath.join(root, "records", `${imported.record!.sourceId}.json`);
      const file = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as Record<string, unknown>;
      await NodeFSP.writeFile(filePath, JSON.stringify({ ...file, title: "After" }));
      const records = await listScientSourceRecords(library);
      vi.useRealTimers();
      return records.find((record) => record.sourceId === imported.record!.sourceId)?.title;
    };

    expect(
      await editedTitle(async (library) => {
        expect(await warmScientLibraryRecordIndex(library, { minimumRecords: 3 })).toEqual({
          recordFiles: 2,
          warmed: false,
        });
        const stopped = new AbortController();
        stopped.abort();
        await expect(
          warmScientLibraryRecordIndex(library, { minimumRecords: 2, signal: stopped.signal }),
        ).rejects.toThrow();
      }),
    ).toBe("After");
    expect(
      await editedTitle(async (library) => {
        expect(await warmScientLibraryRecordIndex(library, { minimumRecords: 2 })).toEqual({
          recordFiles: 2,
          warmed: true,
        });
      }),
    ).toBe("Source ONE");
  });

  it("lists and counts the Trash and past imports without reading unchanged files again", async () => {
    const { root, library } = await newLibrary();
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({
      root: library,
      operationId,
      adapter: "file",
      intake: "file",
      itemKeys: ["ONE", "TWO", "THREE"],
    });
    const imported = [];
    for (const key of ["ONE", "TWO", "THREE"]) {
      const result = await importScientSourceOperationItem({
        root: library,
        operationId,
        candidate: candidate(key, `Source ${key}`),
      });
      imported.push(result.record!);
      await updateSourceImportOperationItem({
        root: library,
        operationId,
        itemKey: key,
        state: "imported",
        sourceId: result.record!.sourceId,
      });
    }
    const [one, two] = imported as [ScientSourceRecord, ScientSourceRecord];
    await removeScientSource({
      root: library,
      sourceId: one.sourceId,
      expectedRevision: one.revision,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const read = async () => ({
      trashedCount: (await inspectScientLibrarySources(library)).trashedCount,
      changes: (await listScientLibraryRecentChanges(library, 10)).changes.map(
        (change) => change.kind,
      ),
    });
    expect(await read()).toEqual({ trashedCount: 1, changes: ["trash", "import"] });

    const readFile = vi.mocked(NodeFSP.readFile);
    readFile.mockClear();
    expect(await read()).toEqual({ trashedCount: 1, changes: ["trash", "import"] });
    const readAgain = readFile.mock.calls
      .map(([path]) => NodePath.relative(root, String(path)).split(NodePath.sep)[0])
      .filter((folder) => folder === "trash" || folder === "receipts");
    expect(readAgain).toEqual([]);

    await removeScientSource({
      root: library,
      sourceId: two.sourceId,
      expectedRevision: two.revision,
    });
    expect(await read()).toEqual({ trashedCount: 2, changes: ["trash", "trash", "import"] });
  });

  it("finds an import's later entry the same as a paper it just added or one already there", async () => {
    const { library } = await newLibrary();
    const older = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate: candidate("OLD", "Source OLD"),
    });
    const operationId = NodeCrypto.randomUUID();
    const keys = ["NEW", "NEW-AGAIN", "OLD-AGAIN"];
    await createSourceImportOperation({
      root: library,
      operationId,
      adapter: "file",
      intake: "file",
      itemKeys: keys,
    });
    const item = (key: string, sameAs: string) =>
      importScientSourceOperationItem({
        root: library,
        operationId,
        candidate: {
          ...candidate(sameAs, `Source ${sameAs}`),
          sourceKey: key,
        },
      });
    const added = await item("NEW", "NEW");
    expect(added.outcome).toBe("imported");
    expect(await item("NEW-AGAIN", "NEW")).toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "same-identifier", matchingSourceIds: [added.record!.sourceId] },
    });
    expect(await item("OLD-AGAIN", "OLD")).toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "same-identifier", matchingSourceIds: [older.record!.sourceId] },
    });
  });

  it("gives each checkout of a project its own instance", async () => {
    const { library } = await newLibrary();
    const checkout = await fixture();
    const copy = await fixture();
    const first = await registerScientLibraryInstance({
      library,
      projectId: "project_a",
      projectRoot: checkout,
    });
    expect(
      await registerScientLibraryInstance({
        library,
        projectId: "project_a",
        projectRoot: checkout,
      }),
    ).toEqual(first);
    const second = await registerScientLibraryInstance({
      library,
      projectId: "project_a",
      projectRoot: copy,
    });
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(await listScientLibraryInstances(library)).toEqual([first, second]);
  });
});
