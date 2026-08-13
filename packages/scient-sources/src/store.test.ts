// @effect-diagnostics nodeBuiltinImport:off -- Store tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { ScientSourceCandidate } from "./model.ts";
import {
  cancelSourceImportOperation,
  canonicalizeScientSourceRoot,
  createSourceImportOperation,
  importScientSource,
  inspectScientSourcePdf,
  inspectScientSources,
  listScientSourceRecords,
  readSourceImportOperation,
  removeScientSource,
  SCIENT_SOURCES_DIRECTORY,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  SCIENT_SOURCE_OPERATIONS_DIRECTORY,
  SCIENT_SOURCE_RECEIPTS_DIRECTORY,
  SCIENT_SOURCE_HISTORY_DIRECTORY,
  sourceAttachmentAbsolutePath,
  updateSourceImportOperationItem,
  updateScientSourceMetadata,
} from "./store.ts";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sources-"));
  fixtures.push(root);
  return root;
}

const candidate: ScientSourceCandidate = {
  sourceKey: "ABC123",
  type: "article",
  customType: null,
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
  externalReferences: [
    {
      system: "zotero",
      libraryId: "0",
      itemKey: "ABC123",
      itemVersion: 1,
      rawItemType: "journalArticle",
    },
  ],
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
  pdfAttachmentCount: 1,
};

async function writeSourceRecordFixture(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly title: string;
  readonly attachments?: ReadonlyArray<{
    readonly attachmentId: string;
    readonly kind: "pdf";
    readonly fileName: string;
    readonly mediaType: "application/pdf";
    readonly sha256: string;
    readonly byteLength: number;
    readonly relativePath: string;
    readonly importedAt: string;
  }>;
}) {
  const identity = await readScientProjectIdentity(input.root);
  const record = {
    formatVersion: 1 as const,
    sourceId: input.sourceId,
    projectId: identity.projectId,
    revision: 1,
    type: "article" as const,
    customType: null,
    title: input.title,
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
    attachments: input.attachments ?? [],
    fieldProvenance: [],
    importedAt: "2026-08-12T12:00:00.000Z",
  };
  const recordsDirectory = NodePath.join(input.root, SCIENT_SOURCE_RECORDS_DIRECTORY);
  await NodeFSP.mkdir(recordsDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(recordsDirectory, `${record.sourceId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

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

  it("removes a source and its unshared content-addressed PDF", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const pdfContents = "%PDF-1.7\nremove me\n";
    const sha256 = NodeCrypto.createHash("sha256").update(pdfContents).digest("hex");
    const relativePath = `files/sha256/${sha256.slice(0, 2)}/${sha256}.pdf`;
    const storedPdf = NodePath.join(root, SCIENT_SOURCES_DIRECTORY, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(storedPdf), { recursive: true });
    await NodeFSP.writeFile(storedPdf, pdfContents, "utf8");
    const attachment = {
      attachmentId: `pdf_${sha256.slice(0, 24)}`,
      kind: "pdf" as const,
      fileName: "source.pdf",
      mediaType: "application/pdf" as const,
      sha256,
      byteLength: Buffer.byteLength(pdfContents),
      relativePath,
      importedAt: "2026-08-12T12:00:00.000Z",
    };
    const record = await writeSourceRecordFixture({
      root,
      sourceId: "source_remove_fixture",
      title: "Remove me",
      attachments: [attachment],
    });
    await expect(
      removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      }),
    ).resolves.toEqual({
      outcome: "removed",
      sourceId: record.sourceId,
      revision: 1,
      removedAttachmentCount: 1,
      retainedAttachmentCount: 0,
    });
    expect(await listScientSourceRecords(root)).toEqual([]);
    await expect(NodeFSP.stat(storedPdf)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      }),
    ).resolves.toMatchObject({ outcome: "not-found", revision: null });
  });

  it("can re-import and edit a source whose earlier revisions remain after removal", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const firstImport = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const firstRecord = firstImport.record;
    if (!firstRecord) throw new Error("Expected an imported record.");

    const edited = await updateScientSourceMetadata({
      root,
      sourceId: firstRecord.sourceId,
      expectedRevision: firstRecord.revision,
      metadata: {
        type: firstRecord.type,
        customType: firstRecord.customType ?? null,
        title: "An earlier corrected title",
        creators: firstRecord.creators,
        issuedRaw: firstRecord.issuedRaw,
        issuedYear: firstRecord.issuedYear,
        identifiers: firstRecord.identifiers,
        abstract: firstRecord.abstract,
        containerTitle: firstRecord.containerTitle,
        publisher: firstRecord.publisher,
        volume: firstRecord.volume,
        issue: firstRecord.issue,
        pages: firstRecord.pages,
        language: firstRecord.language,
        url: firstRecord.url,
        tags: firstRecord.tags,
      },
    });
    expect(edited.record.revision).toBe(2);

    await removeScientSource({
      root,
      sourceId: edited.record.sourceId,
      expectedRevision: edited.record.revision,
    });
    const reimported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    if (!reimported.record) throw new Error("Expected the source to be re-imported.");
    expect(reimported.record).toMatchObject({ sourceId: firstRecord.sourceId, revision: 2 });

    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: reimported.record.sourceId,
        expectedRevision: reimported.record.revision,
        metadata: {
          type: reimported.record.type,
          customType: reimported.record.customType ?? null,
          title: "A new corrected title",
          creators: reimported.record.creators,
          issuedRaw: reimported.record.issuedRaw,
          issuedYear: reimported.record.issuedYear,
          identifiers: reimported.record.identifiers,
          abstract: reimported.record.abstract,
          containerTitle: reimported.record.containerTitle,
          publisher: reimported.record.publisher,
          volume: reimported.record.volume,
          issue: reimported.record.issue,
          pages: reimported.record.pages,
          language: reimported.record.language,
          url: reimported.record.url,
          tags: reimported.record.tags,
        },
      }),
    ).resolves.toMatchObject({ outcome: "updated", record: { revision: 3 } });
  });

  it("keeps a shared PDF and rejects removal from a stale source revision", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const pdfContents = "%PDF-1.7\nshared\n";
    const sha256 = NodeCrypto.createHash("sha256").update(pdfContents).digest("hex");
    const relativePath = `files/sha256/${sha256.slice(0, 2)}/${sha256}.pdf`;
    const storedPdf = NodePath.join(root, SCIENT_SOURCES_DIRECTORY, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(storedPdf), { recursive: true });
    await NodeFSP.writeFile(storedPdf, pdfContents, "utf8");
    const attachment = {
      attachmentId: `pdf_${sha256.slice(0, 24)}`,
      kind: "pdf" as const,
      fileName: "shared.pdf",
      mediaType: "application/pdf" as const,
      sha256,
      byteLength: Buffer.byteLength(pdfContents),
      relativePath,
      importedAt: "2026-08-12T12:00:00.000Z",
    };
    const record = await writeSourceRecordFixture({
      root,
      sourceId: "source_shared_primary",
      title: "Shared primary",
      attachments: [attachment],
    });
    const sharedRecord = await writeSourceRecordFixture({
      root,
      sourceId: "source_shared_fixture",
      title: "Shared secondary",
      attachments: [attachment],
    });

    await expect(
      removeScientSource({ root, sourceId: record.sourceId, expectedRevision: 99 }),
    ).resolves.toMatchObject({ outcome: "stale", revision: 1 });
    expect(await listScientSourceRecords(root)).toHaveLength(2);

    await expect(
      removeScientSource({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
      }),
    ).resolves.toMatchObject({
      outcome: "removed",
      removedAttachmentCount: 0,
      retainedAttachmentCount: 1,
    });
    expect(await NodeFSP.readFile(sourceAttachmentAbsolutePath(root, attachment), "utf8")).toBe(
      "%PDF-1.7\nshared\n",
    );
    expect((await listScientSourceRecords(root)).map((value) => value.sourceId)).toEqual([
      sharedRecord.sourceId,
    ]);
  });

  it("inspects PDF identity without writing source state", async () => {
    const root = await fixture();
    const pdfPath = NodePath.join(root, "source.pdf");
    const contents = "%PDF-1.7\nfixture\n";
    await NodeFSP.writeFile(pdfPath, contents, "utf8");

    const inspected = await inspectScientSourcePdf(pdfPath);

    expect(inspected).toEqual({
      sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
      byteLength: Buffer.byteLength(contents),
    });
    await expect(NodeFSP.stat(NodePath.join(root, SCIENT_SOURCES_DIRECTORY))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("canonicalizes project aliases before source coordination", async () => {
    const container = await fixture();
    const root = NodePath.join(container, "project");
    const alias = NodePath.join(container, "project-alias");
    await NodeFSP.mkdir(root);
    await initializeScientProject({ root });
    await NodeFSP.symlink(root, alias, "junction");

    expect(await canonicalizeScientSourceRoot(alias)).toBe(await NodeFSP.realpath(root));
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

  it("allows an explicit possible metadata match without overriding exact duplicates", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    await importScientSource({ root, operationId: NodeCrypto.randomUUID(), candidate });
    const possibleMatch = {
      ...candidate,
      sourceKey: "DEF456",
      identifiers: [],
      externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "DEF456" }],
    };

    const blocked = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: possibleMatch,
    });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: possibleMatch,
      allowPossibleMetadataMatch: true,
    });
    const exactIdentifier = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: {
        ...candidate,
        sourceKey: "GHI789",
        externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "GHI789" }],
      },
      allowPossibleMetadataMatch: true,
    });

    expect(blocked).toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "possible-metadata-match" },
    });
    expect(imported).toMatchObject({
      outcome: "imported",
      duplicate: { kind: "possible-metadata-match" },
    });
    expect(exactIdentifier).toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "same-identifier" },
    });
    expect(await listScientSourceRecords(root)).toHaveLength(2);
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

  it("edits metadata atomically and preserves the previous revision", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");

    const result = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: {
        type: "other",
        customType: "  Clinical guideline  ",
        title: "  A corrected source  ",
        creators: record.creators,
        issuedRaw: record.issuedRaw,
        issuedYear: record.issuedYear,
        identifiers: [{ scheme: "DOI", value: "https://doi.org/10.1000/CORRECTED" }],
        abstract: record.abstract,
        containerTitle: record.containerTitle,
        publisher: record.publisher,
        volume: record.volume,
        issue: record.issue,
        pages: record.pages,
        language: record.language,
        url: record.url,
        tags: [" reviewed ", "reviewed"],
      },
    });

    expect(result).toMatchObject({
      outcome: "updated",
      record: {
        revision: 2,
        type: "other",
        customType: "Clinical guideline",
        title: "A corrected source",
        identifiers: [{ scheme: "doi", value: "10.1000/corrected" }],
        tags: ["reviewed"],
      },
    });
    expect(result.record.fieldProvenance).toEqual(
      expect.arrayContaining([
        { field: "title", origin: "user", sourceField: null },
        { field: "customType", origin: "user", sourceField: null },
        { field: "identifiers", origin: "user", sourceField: null },
        { field: "tags", origin: "user", sourceField: null },
      ]),
    );
    expect(result.record.externalReferences).toEqual(record.externalReferences);
    expect(result.record.attachments).toEqual(record.attachments);
    const history = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(
          root,
          SCIENT_SOURCE_HISTORY_DIRECTORY,
          record.sourceId,
          `${record.revision}.json`,
        ),
        "utf8",
      ),
    ) as { revision: number; title: string };
    expect(history).toMatchObject({ revision: 1, title: candidate.title });
  });

  it("rejects incomplete custom types and records that would exceed the readable size limit", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");
    const metadata = {
      type: record.type,
      title: record.title,
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
    } as const;

    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        metadata: { ...metadata, type: "other", customType: "  " },
      }),
    ).rejects.toThrow("Enter the source type");
    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        metadata: { ...metadata, abstract: "x".repeat(2 * 1024 * 1024) },
      }),
    ).rejects.toThrow("exceeds the safe size limit");
    await expect(listScientSourceRecords(root)).resolves.toMatchObject([
      { revision: 1, title: candidate.title },
    ]);
  });

  it("does not advance a normalized no-op and recognizes a retry after a lost response", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");
    const metadata = {
      type: record.type,
      title: "Updated title",
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
    } as const;
    const updated = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      metadata,
    });
    const retry = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: 1,
      metadata,
    });

    expect(updated.outcome).toBe("updated");
    expect(retry).toMatchObject({ outcome: "unchanged", record: { revision: 2 } });
  });

  it("rejects stale and duplicate edits without changing the source", async () => {
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
      candidate: {
        ...candidate,
        sourceKey: "SECOND",
        title: "Another source",
        identifiers: [{ scheme: "doi", value: "10.1000/another" }],
        externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "SECOND" }],
      },
    });
    if (!first.record || !second.record) throw new Error("Expected imported records.");
    const metadata = {
      type: first.record.type,
      title: first.record.title,
      creators: first.record.creators,
      issuedRaw: first.record.issuedRaw,
      issuedYear: first.record.issuedYear,
      identifiers: second.record.identifiers,
      abstract: first.record.abstract,
      containerTitle: first.record.containerTitle,
      publisher: first.record.publisher,
      volume: first.record.volume,
      issue: first.record.issue,
      pages: first.record.pages,
      language: first.record.language,
      url: first.record.url,
      tags: first.record.tags,
    };

    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: first.record.sourceId,
        expectedRevision: 0,
        metadata: { ...metadata, identifiers: first.record.identifiers, title: "Stale title" },
      }),
    ).resolves.toMatchObject({ outcome: "stale", record: { revision: 1 } });
    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: first.record.sourceId,
        expectedRevision: 1,
        metadata,
      }),
    ).resolves.toMatchObject({ outcome: "duplicate", duplicate: { kind: "same-identifier" } });
    expect(
      (await listScientSourceRecords(root)).find(
        (value) => value.sourceId === first.record?.sourceId,
      ),
    ).toMatchObject({ revision: 1, title: candidate.title });
  });

  it("requires an explicit override for a possible metadata match", async () => {
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
      candidate: {
        ...candidate,
        sourceKey: "SECOND",
        title: "Different title",
        identifiers: [],
        externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "SECOND" }],
      },
    });
    if (!first.record || !second.record) throw new Error("Expected imported records.");
    const metadata = {
      type: second.record.type,
      title: first.record.title,
      creators: first.record.creators,
      issuedRaw: first.record.issuedRaw,
      issuedYear: first.record.issuedYear,
      identifiers: [],
      abstract: second.record.abstract,
      containerTitle: second.record.containerTitle,
      publisher: second.record.publisher,
      volume: second.record.volume,
      issue: second.record.issue,
      pages: second.record.pages,
      language: second.record.language,
      url: second.record.url,
      tags: second.record.tags,
    };

    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: second.record.sourceId,
        expectedRevision: 1,
        metadata,
      }),
    ).resolves.toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "possible-metadata-match" },
    });
    await expect(
      updateScientSourceMetadata({
        root,
        sourceId: second.record.sourceId,
        expectedRevision: 1,
        metadata,
        allowPossibleMetadataMatch: true,
      }),
    ).resolves.toMatchObject({ outcome: "updated", record: { revision: 2 } });
  });

  it("serializes concurrent metadata edits so only one revision advances", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const imported = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate,
    });
    const record = imported.record;
    if (!record) throw new Error("Expected an imported record.");
    const metadata = {
      type: record.type,
      title: record.title,
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
    };

    const results = await Promise.all([
      updateScientSourceMetadata({
        root,
        sourceId: record.sourceId,
        expectedRevision: 1,
        metadata: { ...metadata, title: "First correction" },
      }),
      updateScientSourceMetadata({
        root,
        sourceId: record.sourceId,
        expectedRevision: 1,
        metadata: { ...metadata, title: "Second correction" },
      }),
    ]);

    expect(results.map((result) => result.outcome).toSorted()).toEqual(["stale", "updated"]);
    expect((await listScientSourceRecords(root))[0]).toMatchObject({ revision: 2 });
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
          sourceKey: "DEF456",
          externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "DEF456" }],
        },
        pdfPath,
      }),
    ).rejects.toThrow("damaged source PDF");
  });

  it("persists resumable progress and an immutable cancellation receipt", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({
      root,
      operationId,
      adapter: "zotero",
      itemKeys: ["ABC123", "DEF456"],
    });
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

  it("reads operations written before adapters were persisted as Zotero operations", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    const operation = await createSourceImportOperation({
      root,
      operationId,
      adapter: "zotero",
      itemKeys: ["ABC123"],
    });
    const { adapter: _legacyMissingAdapter, ...legacyOperation } = operation;
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_SOURCE_OPERATIONS_DIRECTORY, `${operationId}.json`),
      `${JSON.stringify(legacyOperation, null, 2)}\n`,
      "utf8",
    );

    await expect(readSourceImportOperation(root, operationId)).resolves.toMatchObject({
      adapter: "zotero",
      operationId,
    });
    await expect(inspectScientSources(root)).resolves.toMatchObject({
      activeOperation: { adapter: "zotero", operationId },
    });
  });

  it("permits only one active import operation per project", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationIds = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];

    const attempts = await Promise.allSettled(
      operationIds.map((operationId, index) =>
        createSourceImportOperation({
          root,
          operationId,
          adapter: "zotero",
          itemKeys: [index === 0 ? "ABC123" : "DEF456"],
        }),
      ),
    );

    expect(attempts.map((attempt) => attempt.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const active = (await inspectScientSources(root)).activeOperation;
    expect(active?.state).toBe("running");
    if (!active) throw new Error("Expected an active operation.");
    await updateSourceImportOperationItem({
      root,
      operationId: active.operationId,
      itemKey: active.items[0]?.itemKey ?? "",
      state: "skipped",
    });
    await expect(
      createSourceImportOperation({
        root,
        operationId: NodeCrypto.randomUUID(),
        adapter: "zotero",
        itemKeys: ["GHI789"],
      }),
    ).resolves.toMatchObject({ state: "running" });
  });

  it("finalizes a fully processed operation with a completed receipt", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({
      root,
      operationId,
      adapter: "zotero",
      itemKeys: ["ABC123"],
    });

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

  it("keeps recovered finalization and cancellation consistent under concurrency", async () => {
    const root = await fixture();
    await initializeScientProject({ root });
    const operationId = NodeCrypto.randomUUID();
    const operation = await createSourceImportOperation({
      root,
      operationId,
      adapter: "zotero",
      itemKeys: ["ABC123"],
    });
    await NodeFSP.writeFile(
      NodePath.join(root, SCIENT_SOURCE_OPERATIONS_DIRECTORY, `${operationId}.json`),
      `${JSON.stringify(
        {
          ...operation,
          items: operation.items.map((item) => ({
            ...item,
            state: "skipped",
            message: "Already imported.",
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await Promise.all([inspectScientSources(root), cancelSourceImportOperation(root, operationId)]);

    const finalOperation = await readSourceImportOperation(root, operationId);
    const receipt = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(root, SCIENT_SOURCE_RECEIPTS_DIRECTORY, `${operationId}.json`),
        "utf8",
      ),
    ) as { outcome: "completed" | "cancelled" };
    expect(receipt.outcome).toBe(finalOperation?.state);
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
