// @effect-diagnostics nodeBuiltinImport:off -- Library tests exercise the real library filesystem layout.
// @effect-diagnostics globalDate:off -- The index trusts timestamps by wall-clock age.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { organizeScientSources, readScientSourcesOrganization } from "./collections.ts";
import {
  ensureScientLibrary,
  listScientLibraryInstances,
  registerScientLibraryInstance,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  decodePersistedScientSourceRecord,
  importScientSource,
  listScientSourceRecords,
  listScientSourceTrash,
  removeScientSource,
  sourceAttachmentAbsolutePath,
  updateScientSourceNote,
} from "./store.ts";

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

const candidate = (sourceKey: string, title: string): ScientSourceCandidate => ({
  sourceKey,
  type: "article",
  customType: null,
  title,
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
  abstract: null,
  containerTitle: "Journal",
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: "en",
  url: null,
  tags: [],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
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
