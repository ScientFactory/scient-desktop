// @effect-diagnostics nodeBuiltinImport:off -- Lifecycle tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { editableMetadataFromRecord } from "./editable.ts";
import { SCIENT_SOURCE_FULL_TEXT_PROFILE, type ScientSourceFullText } from "./fullText.ts";
import { readScientSourceFullText, writeScientSourceFullText } from "./fullTextStore.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  type ScientSourceStoreLocation,
} from "./libraryRoot.ts";
import type { ScientSourceAttachment, ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import { scientSourcePdfMaterialPaths } from "./projectFiles.ts";
import {
  attachScientSourcePdf,
  deleteScientSourcesPermanently,
  deleteTrashedScientSource,
  detachScientSourcePdf,
  importScientSource,
  inspectScientLibrarySources,
  inspectScientSources,
  listScientSourceRecords,
  listScientSourceRevisions,
  listScientSourceTrash,
  readScientSourceRecord,
  removeScientSource,
  restoreScientSource,
  revertScientSource,
  SCIENT_SOURCE_HISTORY_LIMIT,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  sourceAttachmentAbsolutePath,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "./store.ts";
import {
  deleteFromTrashForGood,
  emptyScientSourceTrash,
  SCIENT_SOURCE_HISTORY_DIRECTORY,
  sourceCandidate,
  trashRemovalId,
} from "./testing/sourceFixtures.ts";

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
  return sourceCandidate({
    sourceKey: key,
    title: `Work ${key}`,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: doi }],
    containerTitle: "Journal",
    language: "en",
  });
}

async function add(
  root: ScientSourceStoreLocation,
  key: string,
  doi: string,
  pdf?: string,
): Promise<ScientSourceRecord> {
  let pdfPath: string | undefined;
  if (pdf) {
    pdfPath = NodePath.join(typeof root === "string" ? root : root.root, `${key}.pdf`);
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

async function addPdfMaterial(root: ScientSourceStoreLocation, attachment: ScientSourceAttachment) {
  const text: ScientSourceFullText = {
    formatVersion: 1,
    outcome: "extracted",
    sha256: attachment.sha256,
    byteLength: attachment.byteLength,
    profile: SCIENT_SOURCE_FULL_TEXT_PROFILE,
    extractor: { name: "pdfjs", version: "6.2.108" },
    extractedAt: "2026-11-10T00:00:00.000Z",
    pageCount: 1,
    complete: true,
    pages: [
      {
        page: 1,
        text: "Private extracted text",
        viewBox: [0, 0, 612, 792],
        rotation: 0,
        userUnit: 1,
      },
    ],
  };
  await writeScientSourceFullText(root, text);
  const paths = scientSourcePdfMaterialPaths(root, attachment.sha256);
  const annotations = JSON.stringify({
    formatVersion: 1,
    material: { sha256: attachment.sha256, byteLength: attachment.byteLength },
    paths: [],
    annotations: [],
    history: [
      {
        annotationId: "ann_00000001",
        revision: 1,
        highlighted: true,
        note: "Private annotation history",
        updatedAt: "2026-11-10T00:00:00.000Z",
        updatedBy: "user",
      },
    ],
  });
  await NodeFSP.mkdir(NodePath.dirname(paths.annotations), { recursive: true });
  await NodeFSP.writeFile(paths.annotations, annotations, "utf8");
  return { paths, text, annotations };
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
    const keptMaterial = await addPdfMaterial(root, kept.attachments[0]!);
    const removedMaterial = await addPdfMaterial(root, removedOwn.attachments[0]!);
    const detachedMaterial = await addPdfMaterial(root, detached.attachments[0]!);
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

    // A saved version keeps no PDF: the detached one goes with the chosen source's own.
    await expect(deleteFromTrashForGood(root, [removedOwn.sourceId])).resolves.toEqual({
      outcome: "deleted",
      deletedSourceIds: [removedOwn.sourceId],
      removedFileCount: 2,
    });
    for (const attachment of [removedOwn.attachments[0]!, detached.attachments[0]!]) {
      await expect(
        NodeFSP.stat(sourceAttachmentAbsolutePath(root, attachment)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      NodeFSP.stat(NodePath.join(root, SCIENT_SOURCE_HISTORY_DIRECTORY, removedOwn.sourceId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const material of [removedMaterial, detachedMaterial]) {
      for (const filePath of Object.values(material.paths)) {
        await expect(NodeFSP.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }

    const orphan = NodePath.join(
      root,
      ".scient/sources/files/sha256/ab",
      `ab${"0".repeat(62)}.pdf`,
    );
    await NodeFSP.mkdir(NodePath.dirname(orphan), { recursive: true });
    await NodeFSP.writeFile(orphan, "%PDF-1.7\norphan\n", "utf8");
    await expect(emptyScientSourceTrash(root)).resolves.toEqual({
      outcome: "deleted",
      deletedSourceIds: [removedShared.sourceId],
      removedFileCount: 1,
    });
    await expect(NodeFSP.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, kept.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nshared\n");
    expect(await readScientSourceFullText(root, keptMaterial.text.sha256)).toEqual(
      keptMaterial.text,
    );
    await expect(NodeFSP.readFile(keptMaterial.paths.annotations, "utf8")).resolves.toBe(
      keptMaterial.annotations,
    );
  });

  it.each(["named", "revision-checked"] as const)(
    "%s deletion collects every PDF no live or trashed source attaches",
    async (deletion) => {
      const libraryRoot = NodePath.join(await project(), "library");
      await ensureScientLibrary(libraryRoot);
      const root = scientLibraryLocation(libraryRoot);
      const unrelated = await add(root, "A", "10.1000/a", "unrelated");
      const unrelatedMaterial = await addPdfMaterial(root, unrelated.attachments[0]!);
      const detached = await detachScientSourcePdf({
        root,
        sourceId: unrelated.sourceId,
        attachmentId: unrelated.attachments[0]!.attachmentId,
        expectedRevision: unrelated.revision,
      });
      let removed = await add(root, "B", "10.1000/b", "historical-exclusive");
      const historicalPdf = removed.attachments[0]!;
      removed = (
        await detachScientSourcePdf({
          root,
          sourceId: removed.sourceId,
          attachmentId: historicalPdf.attachmentId,
          expectedRevision: removed.revision,
        })
      ).record!;
      const exclusivePath = NodePath.join(libraryRoot, "exclusive.pdf");
      await NodeFSP.writeFile(exclusivePath, "%PDF-1.7\nexclusive\n", "utf8");
      removed = (
        await attachScientSourcePdf({
          root,
          sourceId: removed.sourceId,
          expectedRevision: removed.revision,
          pdfPath: exclusivePath,
        })
      ).record;
      const exclusivePdf = removed.attachments[0]!;
      const live = await add(root, "C", "10.1000/c", "live-shared");
      const trashed = await add(root, "D", "10.1000/d", "trash-shared");
      const exclusiveMaterial = [
        await addPdfMaterial(root, historicalPdf),
        await addPdfMaterial(root, exclusivePdf),
      ];
      const sharedMaterial = [
        await addPdfMaterial(root, live.attachments[0]!),
        await addPdfMaterial(root, trashed.attachments[0]!),
      ];
      for (const shared of [live, trashed]) {
        removed = (
          await attachScientSourcePdf({
            root,
            sourceId: removed.sourceId,
            expectedRevision: removed.revision,
            pdfPath: sourceAttachmentAbsolutePath(root, shared.attachments[0]!),
          })
        ).record;
      }
      for (const record of [removed, trashed]) {
        await removeScientSource({
          root,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
        });
      }
      const removalId = await trashRemovalId(root, removed.sourceId);
      for (const retry of [false, true]) {
        const deleted =
          deletion === "named"
            ? await deleteScientSourcesPermanently({ root, removalIds: [removalId] })
            : await deleteTrashedScientSource({ root, sourceId: removed.sourceId, removalId });
        if (retry) {
          expect(deleted).toEqual(
            deletion === "named"
              ? { outcome: "deleted", deletedSourceIds: [], removedFileCount: 0 }
              : { outcome: "not-found", sourceId: removed.sourceId },
          );
        } else {
          expect(deleted).toMatchObject({ removedFileCount: 3 });
        }
      }
      await expect(deleteFromTrashForGood(root, [])).resolves.toEqual({
        outcome: "deleted",
        deletedSourceIds: [],
        removedFileCount: 0,
      });
      // Another source's saved version names the unrelated PDF, which keeps it no longer.
      for (const attachment of [historicalPdf, exclusivePdf, unrelated.attachments[0]!]) {
        await expect(
          NodeFSP.stat(sourceAttachmentAbsolutePath(root, attachment)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const material of [...exclusiveMaterial, unrelatedMaterial]) {
        for (const filePath of Object.values(material.paths)) {
          await expect(NodeFSP.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      for (const [record, bytes] of [
        [live, "%PDF-1.7\nlive-shared\n"],
        [trashed, "%PDF-1.7\ntrash-shared\n"],
      ] as const) {
        await expect(
          NodeFSP.readFile(sourceAttachmentAbsolutePath(root, record.attachments[0]!), "utf8"),
        ).resolves.toBe(bytes);
      }
      expect(detached.record!.attachments).toEqual([]);
      for (const material of sharedMaterial) {
        expect(await readScientSourceFullText(root, material.text.sha256)).toEqual(material.text);
        await expect(NodeFSP.readFile(material.paths.annotations, "utf8")).resolves.toBe(
          material.annotations,
        );
      }
    },
  );

  it("collects the PDFs of merged copies with the paper they joined", async () => {
    const libraryRoot = NodePath.join(await project(), "library");
    await ensureScientLibrary(libraryRoot);
    const root = scientLibraryLocation(libraryRoot);
    const survivor = await add(root, "B", "10.1000/b");
    const copy = await add(root, "C", "10.1000/c", "merged-exclusive");
    const copyMaterial = await addPdfMaterial(root, copy.attachments[0]!);
    await detachScientSourcePdf({
      root,
      sourceId: copy.sourceId,
      attachmentId: copy.attachments[0]!.attachmentId,
      expectedRevision: copy.revision,
    });
    const merged = await mergeScientLibrarySources({
      library: root,
      sourceIds: [survivor.sourceId, copy.sourceId],
      survivorId: survivor.sourceId,
    });
    if (merged.outcome !== "merged") throw new Error(`Not merged: ${merged.outcome}`);
    await removeScientSource({
      root,
      sourceId: survivor.sourceId,
      expectedRevision: merged.survivor.revision,
    });
    await expect(
      deleteTrashedScientSource({
        root,
        sourceId: survivor.sourceId,
        removalId: await trashRemovalId(root, survivor.sourceId),
      }),
    ).resolves.toMatchObject({ outcome: "deleted", removedFileCount: 1 });
    await expect(
      NodeFSP.stat(sourceAttachmentAbsolutePath(root, copy.attachments[0]!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listScientSourceTrash(root)).entries).toEqual([]);
    for (const filePath of Object.values(copyMaterial.paths)) {
      await expect(NodeFSP.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    ["project", "text", "directory"],
    ["library", "annotations", "directory"],
    ["library", "text", "file"],
    ["project", "annotations", "file"],
    ["library", "pdf", "directory"],
  ] as const)(
    "retains material behind an unsafe %s %s %s without following its symlink",
    async (home, materialKind, linkKind) => {
      const projectRoot = await project();
      let root: ScientSourceStoreLocation = projectRoot;
      if (home === "library") {
        const libraryRoot = NodePath.join(projectRoot, "library");
        await ensureScientLibrary(libraryRoot);
        root = scientLibraryLocation(libraryRoot);
      }
      const record = await add(root, "A", "10.1000/a", "private");
      const material = await addPdfMaterial(root, record.attachments[0]!);
      const pdfPath = sourceAttachmentAbsolutePath(root, record.attachments[0]!);
      const filePath = materialKind === "pdf" ? pdfPath : material.paths[materialKind];
      const unsafePath = linkKind === "directory" ? NodePath.dirname(filePath) : filePath;
      const outside = NodePath.join(await project(), "outside");
      await NodeFSP.rename(unsafePath, outside);
      await NodeFSP.symlink(outside, unsafePath, linkKind === "directory" ? "dir" : "file");
      const outsideFile =
        linkKind === "directory" ? NodePath.join(outside, NodePath.basename(filePath)) : outside;
      const bytes = await NodeFSP.readFile(outsideFile, "utf8");
      await removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      });
      await expect(deleteFromTrashForGood(root, [record.sourceId])).resolves.toMatchObject({
        removedFileCount: materialKind === "pdf" ? 0 : 1,
      });
      await expect(NodeFSP.readFile(outsideFile, "utf8")).resolves.toBe(bytes);
      expect((await NodeFSP.lstat(unsafePath)).isSymbolicLink()).toBe(true);
      if (materialKind === "pdf") {
        expect(await readScientSourceFullText(root, material.text.sha256)).toEqual(material.text);
        await expect(NodeFSP.readFile(material.paths.annotations, "utf8")).resolves.toBe(
          material.annotations,
        );
      } else {
        await expect(NodeFSP.stat(pdfPath)).rejects.toMatchObject({ code: "ENOENT" });
        const safeArtifact =
          materialKind === "text" ? material.paths.annotations : material.paths.text;
        await expect(NodeFSP.stat(safeArtifact)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(["all", "named", "revision-checked"] as const)(
    "%s deletion keeps every stored PDF while any record cannot be read",
    async (deletion) => {
      const root = await project();
      const removed = await add(root, "A", "10.1000/a", "own");
      await removeScientSource({ root, sourceId: removed.sourceId, expectedRevision: 1 });
      await NodeFSP.writeFile(
        NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY, "source_damaged.json"),
        "{ not json",
        "utf8",
      );

      const deleted =
        deletion === "revision-checked"
          ? await deleteTrashedScientSource({
              root,
              sourceId: removed.sourceId,
              removalId: await trashRemovalId(root, removed.sourceId),
            })
          : deletion === "named"
            ? await deleteFromTrashForGood(root, [removed.sourceId])
            : await emptyScientSourceTrash(root);
      expect(deleted).toMatchObject({ removedFileCount: 0 });
      await expect(
        NodeFSP.readFile(sourceAttachmentAbsolutePath(root, removed.attachments[0]!), "utf8"),
      ).resolves.toBe("%PDF-1.7\nown\n");
    },
  );

  it("never follows a symlinked record, reports it and keeps every PDF", async () => {
    const root = await project();
    const linked = await add(root, "A", "10.1000/a", "linked");
    const removed = await add(root, "B", "10.1000/b");
    const recordPath = NodePath.join(
      root,
      SCIENT_SOURCE_RECORDS_DIRECTORY,
      `${linked.sourceId}.json`,
    );
    const moved = NodePath.join(root, "moved-record.json");
    await NodeFSP.rename(recordPath, moved);
    await NodeFSP.symlink(moved, recordPath);
    await removeScientSource({ root, sourceId: removed.sourceId, expectedRevision: 1 });

    expect((await inspectScientSources(root)).unreadableRecords).toEqual([
      {
        path: `.scient/sources/records/${linked.sourceId}.json`,
        message: "The entry is not a safe regular file.",
      },
    ]);
    await expect(emptyScientSourceTrash(root)).resolves.toEqual({
      outcome: "deleted",
      deletedSourceIds: [removed.sourceId],
      removedFileCount: 0,
    });
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, linked.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nlinked\n");
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip: POSIX folder permissions.
  it.skipIf(NodeOS.platform() === "win32")(
    "finishes a permanent deletion that stopped before its history was gone",
    async () => {
      const libraryRoot = NodePath.join(await project(), "library");
      await ensureScientLibrary(libraryRoot);
      const root = scientLibraryLocation(libraryRoot);
      const record = await add(root, "A", "10.1000/a", "own");
      const edited = await updateScientSourceNote({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        note: "A kept version.",
      });
      await removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: edited.record.revision,
      });
      const history = NodePath.join(libraryRoot, "history", record.sourceId);
      await NodeFSP.chmod(history, 0o500);
      try {
        await expect(deleteFromTrashForGood(root, [record.sourceId])).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        await NodeFSP.chmod(history, 0o700);
      }
      // Begun, so neither listed nor restorable; the next deletion of anything finishes it.
      expect((await listScientSourceTrash(root)).entries).toEqual([]);
      await expect(restoreScientSource({ root, sourceId: record.sourceId })).resolves.toMatchObject(
        { outcome: "not-found" },
      );
      await expect(deleteFromTrashForGood(root, [])).resolves.toEqual({
        outcome: "deleted",
        deletedSourceIds: [record.sourceId],
        removedFileCount: 1,
      });
      await expect(NodeFSP.stat(history)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        NodeFSP.stat(NodePath.join(libraryRoot, "trash", `${record.sourceId}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        NodeFSP.stat(sourceAttachmentAbsolutePath(root, record.attachments[0]!)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip: POSIX folder permissions.
  it.skipIf(NodeOS.platform() === "win32").each(["the same request", "another paper's deletion"])(
    "collects a history-only PDF when %s finishes a stopped permanent deletion",
    async (finisher) => {
      const libraryRoot = NodePath.join(await project(), "library");
      await ensureScientLibrary(libraryRoot);
      const root = scientLibraryLocation(libraryRoot);
      const record = await add(root, "A", "10.1000/a", "history-only");
      const other = await add(root, "B", "10.1000/b");
      const detached = await detachScientSourcePdf({
        root,
        sourceId: record.sourceId,
        attachmentId: record.attachments[0]!.attachmentId,
        expectedRevision: record.revision,
      });
      for (const [sourceId, expectedRevision] of [
        [record.sourceId, detached.record!.revision],
        [other.sourceId, other.revision],
      ] as const) {
        await removeScientSource({ root, sourceId, expectedRevision });
      }
      const removalId = await trashRemovalId(root, record.sourceId);
      const pdf = sourceAttachmentAbsolutePath(root, record.attachments[0]!);
      // Collection stops after the history is gone: the PDF is now named nowhere on disk.
      const files = NodePath.dirname(pdf);
      await NodeFSP.chmod(files, 0o300);
      try {
        await expect(
          deleteTrashedScientSource({ root, sourceId: record.sourceId, removalId }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await NodeFSP.chmod(files, 0o700);
      }
      await expect(
        NodeFSP.stat(NodePath.join(libraryRoot, "history", record.sourceId)),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        finisher === "the same request"
          ? deleteTrashedScientSource({ root, sourceId: record.sourceId, removalId })
          : deleteTrashedScientSource({
              root,
              sourceId: other.sourceId,
              removalId: await trashRemovalId(root, other.sourceId),
            }),
      ).resolves.toMatchObject({ outcome: "deleted", removedFileCount: 1 });
      await expect(NodeFSP.stat(pdf)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps a re-import of a paper deleted for good out of that deletion", async () => {
    const libraryRoot = NodePath.join(await project(), "library");
    await ensureScientLibrary(libraryRoot);
    const root = scientLibraryLocation(libraryRoot);
    const first = await add(root, "A", "10.1000/a", "first");
    await removeScientSource({ root, sourceId: first.sourceId, expectedRevision: first.revision });
    await expect(
      deleteTrashedScientSource({
        root,
        sourceId: first.sourceId,
        removalId: await trashRemovalId(root, first.sourceId),
      }),
    ).resolves.toMatchObject({ outcome: "deleted" });

    // The person imports the same paper again; it takes the same ID beside the old marker.
    const again = await add(root, "A", "10.1000/a", "again");
    expect(again.sourceId).toBe(first.sourceId);
    const unrelated = await add(root, "B", "10.1000/b");
    for (const { sourceId, revision } of [again, unrelated]) {
      await removeScientSource({ root, sourceId, expectedRevision: revision });
    }
    expect((await listScientSourceTrash(root)).entries.map((entry) => entry.sourceId)).toContain(
      again.sourceId,
    );
    await expect(
      deleteTrashedScientSource({
        root,
        sourceId: unrelated.sourceId,
        removalId: await trashRemovalId(root, unrelated.sourceId),
      }),
    ).resolves.toMatchObject({ outcome: "deleted" });
    await expect(restoreScientSource({ root, sourceId: again.sourceId })).resolves.toMatchObject({
      outcome: "restored",
    });
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, again.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nagain\n");
  });

  it("never lets a request to delete one removal reach a later copy of the paper", async () => {
    const libraryRoot = NodePath.join(await project(), "library");
    await ensureScientLibrary(libraryRoot);
    const root = scientLibraryLocation(libraryRoot);
    const first = await add(root, "A", "10.1000/a", "first");
    await removeScientSource({ root, sourceId: first.sourceId, expectedRevision: first.revision });
    const confirmed = (await listScientSourceTrash(root)).entries[0]!.removalId;
    await expect(
      deleteTrashedScientSource({ root, sourceId: first.sourceId, removalId: confirmed }),
    ).resolves.toMatchObject({ outcome: "deleted" });

    // Imported again, it has the same ID and revision 1, and is moved to the Trash.
    const again = await add(root, "A", "10.1000/a", "again");
    expect([again.sourceId, again.revision]).toEqual([first.sourceId, first.revision]);
    await removeScientSource({ root, sourceId: again.sourceId, expectedRevision: again.revision });
    // The first request arrives again, as a delayed agent call or a second click would.
    await expect(
      deleteTrashedScientSource({ root, sourceId: first.sourceId, removalId: confirmed }),
    ).resolves.toMatchObject({ outcome: "stale" });
    await expect(
      deleteScientSourcesPermanently({ root, removalIds: [confirmed] }),
    ).resolves.toMatchObject({ deletedSourceIds: [] });
    expect((await listScientSourceTrash(root)).entries.map((entry) => entry.sourceId)).toEqual([
      again.sourceId,
    ]);
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, again.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\nagain\n");
  });

  it
    // oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip: POSIX folder permissions.
    .skipIf(NodeOS.platform() === "win32")
    .each(["its PDF folder cannot be read", "its cleanup note cannot be written"])(
    "keeps a deletion for good that stops because %s finishable",
    async (stop) => {
      const libraryRoot = NodePath.join(await project(), "library");
      await ensureScientLibrary(libraryRoot);
      const root = scientLibraryLocation(libraryRoot);
      const record = await add(root, "A", "10.1000/a", "own");
      await removeScientSource({ root, sourceId: record.sourceId, expectedRevision: 1 });
      const shown = await listScientSourceTrash(root);
      const pdf = sourceAttachmentAbsolutePath(root, record.attachments[0]!);
      const blocked =
        stop === "its PDF folder cannot be read"
          ? { folder: NodePath.dirname(pdf), mode: 0o300 }
          : { folder: NodePath.join(libraryRoot, "collected"), mode: 0o500 };
      await NodeFSP.mkdir(blocked.folder, { recursive: true });
      await NodeFSP.chmod(blocked.folder, blocked.mode);
      try {
        await expect(
          deleteScientSourcesPermanently({ root, trashRevision: shown.revision! }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await NodeFSP.chmod(blocked.folder, 0o700);
      }
      // Not listed, but the overview still leads to the Trash, which offers to finish it.
      const after = await listScientSourceTrash(root);
      expect(after).toMatchObject({ entries: [], unfinished: [shown.entries[0]!.removalId] });
      const overview = await inspectScientLibrarySources(root);
      expect(overview).toMatchObject({ unfinishedDeletions: 1 });
      expect(overview).not.toHaveProperty("trashedCount");
      await expect(NodeFSP.readFile(pdf, "utf8")).resolves.toBe("%PDF-1.7\nown\n");
      await expect(
        deleteScientSourcesPermanently({ root, removalIds: after.unfinished! }),
      ).resolves.toMatchObject({ deletedSourceIds: [record.sourceId], removedFileCount: 1 });
      await expect(NodeFSP.stat(pdf)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await listScientSourceTrash(root)).not.toHaveProperty("unfinished");
      expect(await inspectScientLibrarySources(root)).not.toHaveProperty("unfinishedDeletions");
    },
  );

  // oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip: POSIX folder permissions.
  it.skipIf(NodeOS.platform() === "win32")(
    "removes a collected PDF's text and highlights at a later deletion when they could not go",
    async () => {
      const root = await project();
      const record = await add(root, "A", "10.1000/a", "own");
      const other = await add(root, "B", "10.1000/b");
      const material = await addPdfMaterial(root, record.attachments[0]!);
      for (const { sourceId, revision } of [record, other]) {
        await removeScientSource({ root, sourceId, expectedRevision: revision });
      }
      const highlights = NodePath.dirname(material.paths.annotations);
      await NodeFSP.chmod(highlights, 0o500);
      try {
        await expect(deleteFromTrashForGood(root, [record.sourceId])).resolves.toMatchObject({
          removedFileCount: 1,
        });
      } finally {
        await NodeFSP.chmod(highlights, 0o700);
      }
      await expect(
        NodeFSP.stat(sourceAttachmentAbsolutePath(root, record.attachments[0]!)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.readFile(material.paths.annotations, "utf8")).resolves.toBe(
        material.annotations,
      );

      // Any later deletion, even one with nothing new to collect, finishes the removal.
      await deleteFromTrashForGood(root, [other.sourceId]);
      for (const filePath of Object.values(material.paths)) {
        await expect(NodeFSP.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(
        NodeFSP.stat(NodePath.join(root, ".scient/sources/collected")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("empties the trash only while it is the listing the person was shown", async () => {
    const root = await project();
    const shown = await add(root, "A", "10.1000/a", "a");
    const later = await add(root, "B", "10.1000/b", "b");
    await removeScientSource({ root, sourceId: shown.sourceId, expectedRevision: 1 });
    const listing = await listScientSourceTrash(root);
    const changed = { outcome: "changed", deletedSourceIds: [], removedFileCount: 0 };

    // Another window trashes a paper after the confirmation opened.
    await removeScientSource({ root, sourceId: later.sourceId, expectedRevision: 1 });
    await expect(
      deleteScientSourcesPermanently({ root, trashRevision: listing.revision! }),
    ).resolves.toEqual(changed);
    await expect(deleteScientSourcesPermanently({ root })).resolves.toEqual(changed);
    // The same entries again, but one was restored and trashed in between.
    const reread = await listScientSourceTrash(root);
    const restored = await restoreScientSource({ root, sourceId: later.sourceId });
    await removeScientSource({
      root,
      sourceId: later.sourceId,
      expectedRevision: restored.record!.revision,
    });
    await expect(
      deleteScientSourcesPermanently({ root, trashRevision: reread.revision! }),
    ).resolves.toEqual(changed);
    expect((await listScientSourceTrash(root)).entries.map((entry) => entry.sourceId)).toEqual([
      later.sourceId,
      shown.sourceId,
    ]);

    await expect(emptyScientSourceTrash(root)).resolves.toMatchObject({
      outcome: "deleted",
      removedFileCount: 2,
    });
    expect((await listScientSourceTrash(root)).entries).toEqual([]);
  });

  it("deletes one trashed source only for the removal the request saw", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a", "a");
    await removeScientSource({ root, sourceId: record.sourceId, expectedRevision: 1 });
    const seen = (await listScientSourceTrash(root)).entries[0]!.removalId;
    // Between the request and its deletion: restore, edit and remove again.
    const restored = await restoreScientSource({ root, sourceId: record.sourceId });
    const edited = await retitle(root, restored.record!, "Newer title");
    await removeScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: edited.revision,
    });

    await expect(
      deleteTrashedScientSource({ root, sourceId: record.sourceId, removalId: seen }),
    ).resolves.toEqual({ outcome: "stale", sourceId: record.sourceId, revision: edited.revision });
    expect((await listScientSourceTrash(root)).entries).toMatchObject([
      { sourceId: record.sourceId, revision: edited.revision, title: "Newer title" },
    ]);
    await expect(
      NodeFSP.readFile(sourceAttachmentAbsolutePath(root, record.attachments[0]!), "utf8"),
    ).resolves.toBe("%PDF-1.7\na\n");
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

  it("restores an earlier version's details and keeps My note and the current PDFs", async () => {
    const root = await project();
    const record = await add(root, "A", "10.1000/a", "a");
    const retitled = await retitle(root, record, "A wrong title");
    const noted = await updateScientSourceNote({
      root,
      sourceId: record.sourceId,
      expectedRevision: retitled.revision,
      note: "Read for the methods section.",
    });
    const pdfPath = NodePath.join(root, "late.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nlate\n", "utf8");
    const attached = await attachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      expectedRevision: noted.record.revision,
      pdfPath,
    });
    const detached = await detachScientSourcePdf({
      root,
      sourceId: record.sourceId,
      attachmentId: record.attachments[0]!.attachmentId,
      expectedRevision: attached.record.revision,
    });
    const now = detached.record!;
    expect(now.attachments.map((attachment) => attachment.sha256)).toEqual([
      attached.record.attachments.at(-1)!.sha256,
    ]);

    const back = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: now.revision,
      toRevision: 1,
    });
    expect(back).toMatchObject({
      outcome: "reverted",
      record: { title: "Work A", note: "Read for the methods section." },
    });
    expect(back.record.attachments).toEqual(now.attachments);
    // A version that differs only in My note or PDFs is already the current details.
    await expect(
      revertScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: back.record.revision,
        toRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
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
});
