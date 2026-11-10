// @effect-diagnostics nodeBuiltinImport:off -- Lifecycle tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { editableMetadataFromRecord } from "./editable.ts";
import type { ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  detachScientSourcePdf,
  importScientSource,
  inspectScientSources,
  listScientSourceRecords,
  listScientSourceRevisions,
  listScientSourceTrash,
  readScientSourceRecord,
  removeScientSource,
  restoreScientSource,
  revertScientSource,
  SCIENT_SOURCE_HISTORY_DIRECTORY,
  SCIENT_SOURCE_HISTORY_LIMIT,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  sourceAttachmentAbsolutePath,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-life-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function candidate(key: string, doi: string): ScientSourceCandidate {
  return {
    sourceKey: key,
    type: "article",
    customType: null,
    title: `Work ${key}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: doi }],
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
  };
}

async function add(
  root: string,
  key: string,
  doi: string,
  pdf?: string,
): Promise<ScientSourceRecord> {
  let pdfPath: string | undefined;
  if (pdf) {
    pdfPath = NodePath.join(root, `${key}.pdf`);
    await NodeFSP.writeFile(pdfPath, `%PDF-1.7\n${pdf}\n`, "utf8");
  }
  const result = await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: candidate(key, doi),
    actor: "user",
    intake: "identifier",
    ...(pdfPath ? { pdfPath } : {}),
  });
  if (!result.record) throw new Error("Expected an imported source.");
  return result.record;
}

async function retitle(root: string, record: ScientSourceRecord, title: string) {
  const result = await updateScientSourceMetadata({
    root,
    sourceId: record.sourceId,
    expectedRevision: record.revision,
    metadata: { ...editableMetadataFromRecord(record), title },
    actor: "agent",
  });
  return result.record;
}

describe("Scient source trash", () => {
  it("restores a removed source as a new revision credited to the restorer", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a", "a");
    const pdf = sourceAttachmentAbsolutePath(root, record.attachments[0]!);

    await removeScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      actor: "agent",
    });
    expect(await listScientSourceTrash(root)).toMatchObject({
      entries: [{ sourceId: record.sourceId, removedBy: "agent" }],
    });
    await expect(NodeFSP.readFile(pdf, "utf8")).resolves.toBe("%PDF-1.7\na\n");

    const restored = await restoreScientSource({ root, sourceId: record.sourceId, actor: "user" });
    expect(restored).toMatchObject({
      outcome: "restored",
      record: { revision: 2, updatedBy: "user", attachments: record.attachments },
    });
    expect((await listScientSourceRecords(root)).map((value) => value.sourceId)).toEqual([
      record.sourceId,
    ]);
    expect((await listScientSourceTrash(root)).entries).toEqual([]);
    expect(await inspectScientSources(root)).not.toHaveProperty("trashedCount");
    await expect(restoreScientSource({ root, sourceId: record.sourceId })).resolves.toMatchObject({
      outcome: "not-found",
    });
  });

  it("refuses to restore over a re-imported source or a live duplicate identifier", async () => {
    const root = await project();
    const first = await add(root, "A", "10.1000/a");
    await removeScientSource({ root, sourceId: first.sourceId, expectedRevision: 1 });
    const reimported = await add(root, "A", "10.1000/a");
    expect(reimported.sourceId).toBe(first.sourceId);
    await expect(restoreScientSource({ root, sourceId: first.sourceId })).resolves.toMatchObject({
      outcome: "not-found",
    });

    const second = await add(root, "B", "10.1000/b");
    await removeScientSource({ root, sourceId: second.sourceId, expectedRevision: 1 });
    const sameDoi = await add(root, "C", "10.1000/b");
    await expect(restoreScientSource({ root, sourceId: second.sourceId })).resolves.toMatchObject({
      outcome: "duplicate",
      matchingSourceIds: [sameDoi.sourceId],
    });
    expect((await listScientSourceTrash(root)).entries).toHaveLength(1);
  });

  it("empties the trash and deletes only PDFs nothing else refers to", async () => {
    const root = await project();
    const kept = await add(root, "A", "10.1000/a", "shared");
    const removedShared = (
      await attachScientSourcePdf({
        root,
        sourceId: (await add(root, "B", "10.1000/b")).sourceId,
        expectedRevision: 1,
        pdfPath: NodePath.join(root, "A.pdf"),
      })
    ).record;
    const removedOwn = await add(root, "C", "10.1000/c", "own");
    const detached = await add(root, "D", "10.1000/d", "detached");
    await detachScientSourcePdf({
      root,
      sourceId: detached.sourceId,
      attachmentId: detached.attachments[0]!.attachmentId,
      expectedRevision: 1,
    });
    for (const record of [removedShared, removedOwn]) {
      await removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      });
    }

    await expect(
      deleteScientSourcesPermanently({ root, sourceIds: [removedOwn.sourceId] }),
    ).resolves.toEqual({ deletedSourceIds: [removedOwn.sourceId], removedFileCount: 2 });
    await expect(
      NodeFSP.stat(sourceAttachmentAbsolutePath(root, removedOwn.attachments[0]!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      NodeFSP.stat(sourceAttachmentAbsolutePath(root, detached.attachments[0]!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      NodeFSP.stat(NodePath.join(root, SCIENT_SOURCE_HISTORY_DIRECTORY, removedOwn.sourceId)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(deleteScientSourcesPermanently({ root })).resolves.toEqual({
      deletedSourceIds: [removedShared.sourceId],
      removedFileCount: 0,
    });
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, kept.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nshared\n");
  });

  it("keeps every stored PDF while any record cannot be read", async () => {
    const root = await project();
    const removed = await add(root, "A", "10.1000/a", "own");
    await removeScientSource({ root, sourceId: removed.sourceId, expectedRevision: 1 });
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY, "source_damaged.json"),
      "{ not json",
      "utf8",
    );

    await expect(deleteScientSourcesPermanently({ root })).resolves.toEqual({
      deletedSourceIds: [removed.sourceId],
      removedFileCount: 0,
    });
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, removed.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nown\n");
  });
});

describe("Scient source revisions", () => {
  it("reverts to an earlier revision as a new one and lists what each revision changed", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a");
    const edited = await retitle(root, record, "A corrected title");

    const reverted = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: edited.revision,
      toRevision: 1,
      actor: "agent",
    });
    expect(reverted).toMatchObject({
      outcome: "reverted",
      record: { revision: 3, title: "Work A", updatedBy: "agent", importedAt: record.importedAt },
      missingAttachmentCount: 0,
    });
    expect(await listScientSourceRevisions(root, record.sourceId)).toMatchObject([
      { revision: 3, savedBy: "agent", changes: ["title"], current: true },
      { revision: 2, savedBy: "agent", changes: ["title"], current: false },
      { revision: 1, savedBy: "user", changes: [], current: false },
    ]);
    await expect(
      revertScientSource({ root, sourceId: record.sourceId, expectedRevision: 2, toRevision: 1 }),
    ).resolves.toMatchObject({ outcome: "stale", record: { revision: 3 } });
    await expect(
      revertScientSource({ root, sourceId: record.sourceId, expectedRevision: 3, toRevision: 9 }),
    ).resolves.toMatchObject({ outcome: "not-found" });
    await expect(
      revertScientSource({ root, sourceId: record.sourceId, expectedRevision: 3, toRevision: 1 }),
    ).resolves.toMatchObject({ outcome: "unchanged", record: { revision: 3 } });
  });

  it("keeps the current citation key when reverting", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a");
    const keyed = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      metadata: { ...editableMetadataFromRecord(record), citationKey: "lovelace2026work" },
    });
    expect(keyed.record.citationKey).toBe("lovelace2026work");
    const reverted = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: keyed.record.revision,
      toRevision: 1,
    });
    expect(reverted.outcome).toBe("unchanged");
    expect(reverted.record.citationKey).toBe("lovelace2026work");
  });

  it("brings a detached PDF back until the trash is emptied", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a", "a");
    const detached = await detachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      attachmentId: record.attachments[0]!.attachmentId,
      expectedRevision: 1,
    });
    const back = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: detached.record!.revision,
      toRevision: 1,
    });
    expect(back).toMatchObject({ outcome: "reverted", missingAttachmentCount: 0 });
    expect(back.record.attachments).toEqual(record.attachments);

    const again = await detachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      attachmentId: record.attachments[0]!.attachmentId,
      expectedRevision: back.record.revision,
    });
    const other = await add(root, "B", "10.1000/b");
    await removeScientSource({ root, sourceId: other.sourceId, expectedRevision: 1 });
    await deleteScientSourcesPermanently({ root });
    await expect(
      revertScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: again.record!.revision,
        toRevision: 1,
      }),
    ).resolves.toMatchObject({
      outcome: "unchanged",
      record: { attachments: [] },
      missingAttachmentCount: 1,
    });
  });

  it("refuses a revert that would duplicate another source's identifier", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a");
    const changed = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      metadata: {
        ...editableMetadataFromRecord(record),
        identifiers: [{ scheme: "doi", value: "10.1000/z" }],
      },
    });
    const other = await add(root, "B", "10.1000/a");
    await expect(
      revertScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: changed.record.revision,
        toRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "duplicate", matchingSourceIds: [other.sourceId] });
  });

  it("caps kept history per source and never prunes the first revision", async () => {
    const root = await project();
    let record = await add(root, "A", "10.1000/a");
    for (let index = 0; index < SCIENT_SOURCE_HISTORY_LIMIT + 10; index += 1) {
      record = (
        await updateScientSourceNote({
          root,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          note: `Note ${index}`,
        })
      ).record;
    }
    const revisions = await listScientSourceRevisions(root, record.sourceId);
    expect(revisions).toHaveLength(SCIENT_SOURCE_HISTORY_LIMIT);
    expect(revisions?.at(0)).toMatchObject({ revision: record.revision, current: true });
    expect(revisions?.at(-1)).toMatchObject({ revision: 1 });
    expect(revisions?.at(-2)?.revision).toBe(record.revision - SCIENT_SOURCE_HISTORY_LIMIT + 2);
  });
});

describe("Scient source listing", () => {
  it("skips an unreadable record and reports it by project path", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a");
    const records = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
    await NodeFSP.writeFile(NodePath.join(records, "source_broken.json"), "{", "utf8");
    await NodeFSP.writeFile(
      NodePath.join(records, "source_wrong_shape.json"),
      JSON.stringify({ formatVersion: 1, sourceId: "source_wrong_shape" }),
      "utf8",
    );

    expect((await listScientSourceRecords(root)).map((value) => value.sourceId)).toEqual([
      record.sourceId,
    ]);
    const overview = await inspectScientSources(root);
    expect(overview.records).toHaveLength(1);
    expect(overview.unreadableRecords?.map((issue) => issue.path)).toEqual([
      ".scient/sources/records/source_broken.json",
      ".scient/sources/records/source_wrong_shape.json",
    ]);
    expect(overview.unreadableRecords?.[0]?.message).toBe("The file is not valid JSON.");
    await expect(readScientSourceRecord(root, record.sourceId)).resolves.toMatchObject({
      sourceId: record.sourceId,
    });
  });

  it("attaches after a revert without losing the restored PDF", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a");
    const pdfPath = NodePath.join(root, "late.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nlate\n", "utf8");
    const attached = await attachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      pdfPath,
    });
    const reverted = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: attached.record.revision,
      toRevision: 1,
    });
    expect(reverted.record.attachments).toEqual([]);
    const forward = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: reverted.record.revision,
      toRevision: attached.record.revision,
    });
    expect(forward.record.attachments).toEqual(attached.record.attachments);
  });
});
