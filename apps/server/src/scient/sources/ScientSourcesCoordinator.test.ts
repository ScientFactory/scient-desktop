// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceStagedMaterial,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  stagedScientSourcePdfAbsolutePath,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  advanceSourceImport,
  assessSourcePreflightDuplicate,
  beginLocalPdfImport,
  getScientSourceAttachmentPreviewMaterial,
  removeSource,
  uploadLocalPdfSource,
  updateScientSource,
} from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

const candidate: ScientSourceCandidate = {
  sourceKey: "PREVIEW1",
  type: "article",
  customType: null,
  title: "Previewable source",
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [
    {
      system: "zotero",
      libraryId: "0",
      itemKey: "PREVIEW1",
      itemVersion: 1,
      rawItemType: "journalArticle",
    },
  ],
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
  pdfAttachmentCount: 1,
};

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ScientSourcesCoordinator", () => {
  it("imports a local PDF through the same durable source operation model", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-local-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "A_local-study.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nlocal source\n", "utf8");

    const uploaded = await uploadLocalPdfSource({
      root,
      sourcePath: pdfPath,
      fileName: "A_local-study.pdf",
    });
    expect(uploaded.item).toMatchObject({
      candidate: {
        type: "other",
        title: "A local study",
        externalReferences: [],
        pdfAvailable: true,
      },
      duplicate: { kind: "new" },
    });

    const operationId = NodeCrypto.randomUUID();
    const operation = await beginLocalPdfImport({
      root,
      operationId,
      itemKeys: [uploaded.item.candidate.sourceKey],
      possibleMetadataMatchOverrides: [],
    });
    expect(operation.adapter).toBe("local-files");

    const completed = await advanceSourceImport({ root, operationId });
    expect(completed).toMatchObject({ state: "completed", adapter: "local-files" });
    const records = await listScientSourceRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      title: "A local study",
      externalReferences: [],
      attachments: [{ kind: "pdf", fileName: "A_local-study.pdf" }],
    });
    await expect(
      readScientSourceStagedMaterial(root, uploaded.item.candidate.sourceKey),
    ).rejects.toThrow();
  });

  it("refuses a staged PDF that changed after the researcher reviewed it", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-changed-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "reviewed.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nreviewed content\n", "utf8");

    const uploaded = await uploadLocalPdfSource({
      root,
      sourcePath: pdfPath,
      fileName: "reviewed.pdf",
    });
    const material = await readScientSourceStagedMaterial(root, uploaded.item.candidate.sourceKey);
    await NodeFSP.writeFile(
      await stagedScientSourcePdfAbsolutePath(root, material),
      "%PDF-1.7\nchanged content\n",
      "utf8",
    );

    const operationId = NodeCrypto.randomUUID();
    await beginLocalPdfImport({
      root,
      operationId,
      itemKeys: [uploaded.item.candidate.sourceKey],
      possibleMetadataMatchOverrides: [],
    });
    const completed = await advanceSourceImport({ root, operationId });

    expect(completed).toMatchObject({
      state: "completed",
      items: [
        {
          state: "failed",
          message: "The source PDF changed after review. Select it again before importing.",
        },
      ],
    });
    await expect(listScientSourceRecords(root)).resolves.toEqual([]);
    await expect(
      readScientSourceStagedMaterial(root, uploaded.item.candidate.sourceKey),
    ).rejects.toThrow();
  });

  it("resolves an imported attachment without requiring a persisted chat thread", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-preview-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "paper.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\npreview\n", "utf8");
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      pdfPath,
    });
    const attachment = imported.record?.attachments[0];
    if (!attachment) throw new Error("Expected an imported attachment.");

    const material = await getScientSourceAttachmentPreviewMaterial({
      root,
      attachmentId: attachment.attachmentId,
    });

    expect(material.attachment).toEqual(attachment);
    expect(material.absolutePath).toContain(
      [".scient", "sources", "files", "sha256"].join(NodePath.sep),
    );
    expect(await NodeFSP.readFile(material.absolutePath, "utf8")).toBe("%PDF-1.7\npreview\n");
    await expect(
      getScientSourceAttachmentPreviewMaterial({ root, attachmentId: "pdf_missing" }),
    ).rejects.toThrow("The source attachment was not found in this project.");
  });

  it("reports byte-identical PDFs during preflight instead of changing the answer at import", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-preflight-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "paper.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nidentical\n", "utf8");
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      pdfPath,
    });
    if (!imported.record) throw new Error("Expected an imported record.");

    await expect(
      assessSourcePreflightDuplicate({
        candidate: {
          ...candidate,
          sourceKey: "PREVIEW2",
          title: "A separately catalogued source",
          identifiers: [],
          externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "PREVIEW2" }],
        },
        existing: [imported.record],
        pdfPath,
      }),
    ).resolves.toMatchObject({ kind: "same-pdf" });
  });

  it("updates canonical source metadata through the environment coordinator", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-edit-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");

    const result = await updateScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: {
        type: record.type,
        title: "Corrected through the coordinator",
        creators: record.creators,
        issuedRaw: record.issuedRaw,
        issuedYear: record.issuedYear,
        identifiers: record.identifiers,
        abstract: record.abstract,
        containerTitle: record.containerTitle,
        publisher: record.publisher,
        volume: record.volume,
        issue: record.issue,
        pages: record.pages,
        language: record.language,
        url: record.url,
        tags: record.tags,
      },
    });

    expect(result).toMatchObject({
      outcome: "updated",
      record: { revision: 2, title: "Corrected through the coordinator" },
    });
  });

  it("removes a source through the environment coordinator", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-remove-"));
    fixtures.push(root);
    await initializeScientProject({ root });
    const identity = await readScientProjectIdentity(root);
    const record = {
      formatVersion: 1,
      sourceId: "source_coordinator_remove",
      projectId: identity.projectId,
      revision: 1,
      type: "article",
      customType: null,
      title: "Remove through coordinator",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: [],
      externalReferences: [],
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-08-12T12:00:00.000Z",
    };
    const recordsDirectory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
    await NodeFSP.mkdir(recordsDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(recordsDirectory, `${record.sourceId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    await expect(
      removeSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      }),
    ).resolves.toMatchObject({ outcome: "removed", sourceId: record.sourceId });
  });
});
