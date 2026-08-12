// @effect-diagnostics nodeBuiltinImport:off -- Store tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { ScientSourceCandidate } from "./model.ts";
import {
  cancelSourceImportOperation,
  createSourceImportOperation,
  importScientSource,
  inspectScientSources,
  listScientSourceRecords,
  readSourceImportOperation,
  SCIENT_SOURCES_DIRECTORY,
  SCIENT_SOURCE_RECEIPTS_DIRECTORY,
  sourceAttachmentAbsolutePath,
  updateSourceImportOperationItem,
} from "./store.ts";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-"));
  fixtures.push(root);
  return root;
}

const candidate: ScientSourceCandidate = {
  type: "article",
  title: "A local-first source",
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/local" }],
  abstract: null,
  containerTitle: "Journal",
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: "en",
  url: null,
  tags: [],
  externalReference: {
    system: "zotero",
    libraryId: "0",
    itemKey: "ABC123",
    itemVersion: 1,
    rawItemType: "journalArticle",
  },
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
};

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient source store", () => {
  it("does not create source state in an ordinary folder", async () => {
    const root = await fixture();

    expect(await inspectScientSources(root)).toMatchObject({
      projectState: "ordinary",
      records: [],
    });
    await expect(listScientSourceRecords(root)).rejects.toThrow(
      "This folder is not an initialized Scient project.",
    );
    await expect(NodeFSP.stat(NodePath.join(root, SCIENT_SOURCES_DIRECTORY))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("imports metadata and a content-addressed PDF atomically", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "source.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nfixture\n", "utf8");
    const operationId = NodeCrypto.randomUUID();

    const imported = await importScientSource({ root, operationId, candidate, pdfPath });

    expect(imported.outcome).toBe("imported");
    expect(imported.record?.attachments).toHaveLength(1);
    const attachment = imported.record?.attachments[0];
    expect(attachment).toBeDefined();
    if (!attachment) throw new Error("Expected imported PDF attachment.");
    expect(await NodeFSP.readFile(sourceAttachmentAbsolutePath(root, attachment), "utf8")).toBe(
      "%PDF-1.7\nfixture\n",
    );
    expect(await listScientSourceRecords(root)).toHaveLength(1);
  });

  it("is idempotent for the same Zotero origin", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const first = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const second = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });

    expect(first.outcome).toBe("imported");
    expect(second).toMatchObject({ outcome: "duplicate", duplicate: { kind: "same-origin" } });
    expect(await listScientSourceRecords(root)).toHaveLength(1);
  });

  it("serializes concurrent imports of the same Zotero item", async () => {
    const root = await fixture();
    await initializeScientProject({ root });

    const results = await Promise.all([
      importScientSource({ root, operationId: NodeCrypto.randomUUID(), candidate }),
      importScientSource({ root, operationId: NodeCrypto.randomUUID(), candidate }),
    ]);

    expect(results.map((result) => result.outcome).toSorted()).toEqual(["duplicate", "imported"]);
    expect(await listScientSourceRecords(root)).toHaveLength(1);
  });

  it("refuses to reuse damaged content-addressed PDF state", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const pdfPath = NodePath.join(root, "source.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nfixture\n", "utf8");
    const first = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      pdfPath,
    });
    const attachment = first.record?.attachments[0];
    if (!attachment) throw new Error("Expected imported attachment.");
    await NodeFSP.writeFile(
      sourceAttachmentAbsolutePath(root, attachment),
      "%PDF-1.7\ndamaged\n",
      "utf8",
    );

    await expect(
      importScientSource({
        root,
        operationId: NodeCrypto.randomUUID(),
        candidate: {
          ...candidate,
          title: "A different local source",
          identifiers: [{ scheme: "doi", value: "10.1000/other" }],
          externalReference: { ...candidate.externalReference, itemKey: "DEF456" },
        },
        pdfPath,
      }),
    ).rejects.toThrow("damaged source PDF");
  });

  it("persists resumable progress and an immutable cancellation receipt", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({ root, operationId, itemKeys: ["ABC123", "DEF456"] });
    await updateSourceImportOperationItem({
      root,
      operationId,
      itemKey: "ABC123",
      state: "imported",
      sourceId: "source_123",
    });

    const cancelled = await cancelSourceImportOperation(root, operationId);

    expect(cancelled.state).toBe("cancelled");
    expect((await readSourceImportOperation(root, operationId))?.items[0]).toMatchObject({
      state: "imported",
      sourceId: "source_123",
    });
    const receipt = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(root, SCIENT_SOURCE_RECEIPTS_DIRECTORY, `${operationId}.json`),
        "utf8",
      ),
    ) as { unprocessedItemKeys: string[] };
    expect(receipt.unprocessedItemKeys).toEqual(["DEF456"]);
  });

  it("finalizes a fully processed operation with a completed receipt", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({ root, operationId, itemKeys: ["ABC123"] });

    const completed = await updateSourceImportOperationItem({
      root,
      operationId,
      itemKey: "ABC123",
      state: "imported",
      sourceId: "source_123",
    });

    expect(completed.state).toBe("completed");
    expect((await inspectScientSources(root)).activeOperation).toBeNull();
    const receipt = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(root, SCIENT_SOURCE_RECEIPTS_DIRECTORY, `${operationId}.json`),
        "utf8",
      ),
    ) as { outcome: string; importedSourceIds: string[]; unprocessedItemKeys: string[] };
    expect(receipt).toMatchObject({
      outcome: "completed",
      importedSourceIds: ["source_123"],
      unprocessedItemKeys: [],
    });
  });

  it("rejects attachment paths that are not portable across supported platforms", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected imported source record.");

    expect(() =>
      sourceAttachmentAbsolutePath(root, {
        attachmentId: "pdf_unsafe",
        kind: "pdf",
        fileName: "unsafe.pdf",
        mediaType: "application/pdf",
        sha256: "a".repeat(64),
        byteLength: 1,
        relativePath: "..\\outside.pdf",
        importedAt: record.importedAt,
      }),
    ).toThrow("not portable");
  });
});
