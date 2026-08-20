import type {
  ScientSourceImportOperation,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
  ZoteroConnectionStatus,
  ZoteroLibraryPage,
} from "@t3tools/contracts";

import { readSourcesLabScenario } from "./state";

const now = "2026-08-12T09:30:00.000Z";

function record(input: {
  readonly sourceId: string;
  readonly title: string | null;
  readonly creator: string | null;
  readonly year: number | null;
  readonly withPdf?: boolean;
}) {
  const attachmentId = `attachment_${input.sourceId}`;
  return {
    formatVersion: 1 as const,
    sourceId: input.sourceId,
    projectId: "project_zotero_lab",
    revision: 1,
    type: "article" as const,
    title: input.title,
    creators: input.creator
      ? [
          {
            creatorType: "author",
            givenName: null,
            familyName: input.creator,
            literalName: null,
          },
        ]
      : [],
    issuedRaw: input.year === null ? null : String(input.year),
    issuedYear: input.year,
    identifiers: input.title
      ? [{ scheme: "doi", value: `10.5555/${input.sourceId.replace("source_", "")}` }]
      : [],
    abstract: null,
    containerTitle: "Journal of Reproducible Research",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: "en",
    url: null,
    tags: ["zotero", "lab-fixture"],
    externalReferences: [
      {
        system: "zotero",
        libraryId: "0",
        itemKey: input.sourceId.toUpperCase(),
        itemVersion: 1,
        rawItemType: "journalArticle",
      },
    ],
    attachments: input.withPdf
      ? [
          {
            attachmentId,
            kind: "pdf" as const,
            fileName: `${input.sourceId}.pdf`,
            mediaType: "application/pdf" as const,
            sha256: "0".repeat(64),
            byteLength: 128_000,
            relativePath: `.scient/sources/${input.sourceId}.pdf`,
            importedAt: now,
          },
        ]
      : [],
    fieldProvenance: [],
    importedAt: now,
  };
}

const completeRecord = record({
  sourceId: "source_sleep",
  title: "Sleep duration and cognitive performance in medical students",
  creator: "Cohen",
  year: 2024,
  withPdf: true,
});

const metadataRecord = record({
  sourceId: "source_methods",
  title: "Reproducible methods for longitudinal clinical studies",
  creator: "Nguyen",
  year: 2023,
});

const warningRecord = record({
  sourceId: "source_incomplete",
  title: null,
  creator: null,
  year: null,
});

function completedOperation(): ScientSourceImportOperation {
  return {
    formatVersion: 1,
    operationId: "operation_zotero_lab",
    projectId: "project_zotero_lab",
    adapter: "zotero",
    actor: "user",
    intake: "zotero",
    state: "completed",
    createdAt: now,
    updatedAt: now,
    items: [
      {
        itemKey: "SOURCE_SLEEP",
        state: "imported",
        sourceId: completeRecord.sourceId,
        message: null,
      },
      {
        itemKey: "SOURCE_METHODS",
        state: "imported",
        sourceId: metadataRecord.sourceId,
        message: null,
      },
    ],
  };
}

function overview(): ScientSourcesOverviewResult {
  const selected = readSourcesLabScenario();
  const records =
    selected === "empty"
      ? []
      : selected === "warning"
        ? [warningRecord, completeRecord]
        : [completeRecord, metadataRecord, warningRecord];
  return {
    projectState: "initialized",
    issues: [],
    records,
    activeOperation: selected === "recent-import" ? completedOperation() : null,
    recordDiagnostics:
      selected === "empty"
        ? []
        : [
            {
              sourceId: warningRecord.sourceId,
              diagnostics: [
                { field: "title", severity: "warning", message: "Title is missing." },
                { field: "creators", severity: "warning", message: "Creator is missing." },
              ],
            },
          ],
  };
}

export async function readScientSources(_root: string): Promise<ScientSourcesOverviewResult> {
  return overview();
}

export async function readZoteroStatus(): Promise<ZoteroConnectionStatus> {
  return { state: "ready", apiVersion: 3, message: "Fixture Zotero library is ready." };
}

export async function readZoteroLibrary(input: {
  readonly query: string;
  readonly start: number;
  readonly limit: number;
}): Promise<ZoteroLibraryPage> {
  const query = input.query.trim().toLowerCase();
  const items = [completeRecord, metadataRecord]
    .filter((item) => !query || item.title?.toLowerCase().includes(query))
    .map((item) => ({
      type: item.type,
      title: item.title,
      creators: item.creators,
      issuedRaw: item.issuedRaw,
      issuedYear: item.issuedYear,
      identifiers: item.identifiers,
      abstract: item.abstract,
      containerTitle: item.containerTitle,
      publisher: item.publisher,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      language: item.language,
      url: item.url,
      tags: item.tags,
      sourceKey: item.sourceId,
      externalReferences: item.externalReferences,
      fieldProvenance: item.fieldProvenance,
      pdfAvailable: item.attachments.length > 0,
      pdfFileName: item.attachments[0]?.fileName ?? null,
      pdfAttachmentCount: item.attachments.length,
    }));
  return {
    scope: { kind: "library" as const },
    items,
    start: 0,
    nextStart: items.length,
    total: items.length,
    hasMore: false,
  };
}

export async function preflightZoteroItems(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}): Promise<ScientSourcesPreflightResult> {
  const library = await readZoteroLibrary({ query: "", start: 0, limit: 50 });
  return {
    items: library.items
      .filter((item) => input.itemKeys.includes(item.externalReferences[0]!.itemKey))
      .map((candidate) => ({
        candidate,
        duplicate: { kind: "new", matchingSourceIds: [], reason: "Ready to import." },
        metadataDiagnostics: [],
      })),
  };
}

export async function beginZoteroItemsImport(_input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}): Promise<ScientSourceImportOperation> {
  return completedOperation();
}

export async function advanceZoteroItemsImport(_input: {
  readonly root: string;
  readonly operationId: string;
}): Promise<ScientSourceImportOperation> {
  return completedOperation();
}

export async function cancelZoteroItemsImport(_input: {
  readonly root: string;
  readonly operationId: string;
}): Promise<ScientSourceImportOperation> {
  return { ...completedOperation(), state: "cancelled" };
}
