import * as NodeCrypto from "node:crypto";

import { enrichScientSourceCandidate } from "./SourceMetadataEnricher.ts";
import {
  discardLocalPdfImportMaterial,
  getLocalPdfImportMaterial,
  prepareLocalPdfSource,
  prepareProjectPdfSource,
  refreshExistingSourceCandidate,
} from "./LocalPdfSourceAdapter.ts";
import {
  abstractDocumentFromSections,
  changedEditableMetadataFields,
  editableMetadataFromRecord,
  normalizeScientSourceAbstractDocument,
  normalizeScientSourceEditableMetadata,
  sourceMetadataDiagnostics,
  assessSourceDuplicate,
  scientSourceSummaryFromRecord,
  type ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourceEditableField,
  type ScientSourceEditableMetadata,
  type ScientSourceFieldProvenance,
  type ScientSourceRecord,
  type ZoteroImportScope,
} from "@scientfactory/scient-sources";
import {
  cancelSourceImportOperation,
  canonicalizeScientSourceRoot,
  createSourceImportOperation,
  importScientSource,
  importScientSourceOperationItem,
  attachScientSourcePdf,
  detachScientSourcePdf,
  inspectScientSourcePdf,
  inspectScientSources,
  listScientSourceRecords,
  readScientSourceRecord,
  readSourceImportOperation,
  retryFailedSourceImportOperationItems,
  removeScientSource,
  updateSourceImportOperationItem,
  updateScientSourceMetadata,
  updateScientSourceNote,
  updateScientSourceReview,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";

import {
  getZoteroItem,
  getZoteroImportMaterial,
  inspectZoteroConnection,
  listZoteroCollections,
  listZoteroLibrary,
  listZoteroScopeItemKeys,
} from "./ZoteroLocalAdapter.ts";
import { resolveJournalIcon } from "./JournalIconResolver.ts";

const operationLanes = new Map<string, Promise<unknown>>();

async function withOperationLane<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = operationLanes.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  operationLanes.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (operationLanes.get(key) === tail) operationLanes.delete(key);
  }
}

export { inspectZoteroConnection, listZoteroCollections, listZoteroLibrary };

function hasMisclassifiedLegacyPdfSubject(record: ScientSourceRecord): boolean {
  return record.fieldProvenance.some(
    (entry) =>
      entry.field === "abstract" &&
      entry.origin === "local-pdf" &&
      entry.sourceField === "document-info/subject",
  );
}

function normalizeSourceRecordForRead(record: ScientSourceRecord): ScientSourceRecord {
  // Older records may contain provider markup or a PDF Subject that an early
  // local adapter misclassified. Correct the detail response without rewriting
  // project evidence merely because it was read.
  const storedSections = abstractDocumentFromSections(record.abstractSections);
  const abstract = hasMisclassifiedLegacyPdfSubject(record)
    ? null
    : record.abstractSections
      ? storedSections
      : normalizeScientSourceAbstractDocument(record.abstract);
  const { abstractSections: _storedAbstractSections, ...withoutAbstractSections } = record;
  return abstract
    ? {
        ...withoutAbstractSections,
        abstract: abstract.text,
        abstractSections: [...abstract.sections],
      }
    : { ...withoutAbstractSections, abstract: null };
}

export async function getScientSourcesOverview(root: string) {
  const overview = await inspectScientSources(root);
  return {
    ...overview,
    records: overview.records.map(scientSourceSummaryFromRecord),
    recordDiagnostics: overview.records.map((record) => ({
      sourceId: record.sourceId,
      diagnostics: sourceMetadataDiagnostics(record),
    })),
  };
}

export async function getScientSourceDetail(input: {
  readonly root: string;
  readonly sourceId: string;
}): Promise<ScientSourceRecord> {
  const record = await readScientSourceRecord(input.root, input.sourceId);
  if (!record) throw new Error("The source was not found in this project.");
  return normalizeSourceRecordForRead(record);
}

export async function getScientSourceAttachmentPreviewMaterial(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId: string;
}) {
  const record = await readScientSourceRecord(input.root, input.sourceId);
  const attachment = record?.attachments.find(
    (candidate) => candidate.attachmentId === input.attachmentId,
  );
  if (attachment) {
    return {
      absolutePath: sourceAttachmentAbsolutePath(input.root, attachment),
      attachment,
    };
  }
  throw new Error("The source attachment was not found in this project.");
}

export async function getScientSourceJournalIconMaterial(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly cacheRoot: string;
}) {
  const record = await readScientSourceRecord(input.root, input.sourceId);
  return record ? resolveJournalIcon({ record, cacheRoot: input.cacheRoot }) : null;
}

export async function updateScientSource(input: Parameters<typeof updateScientSourceMetadata>[0]) {
  return updateScientSourceMetadata(input);
}

export async function updateSourceNote(input: Parameters<typeof updateScientSourceNote>[0]) {
  return updateScientSourceNote(input);
}

export async function updateSourceReview(input: Parameters<typeof updateScientSourceReview>[0]) {
  return updateScientSourceReview(input);
}

export async function addAgentSource(input: {
  readonly root: string;
  readonly candidate: ScientSourceCandidate;
  readonly allowPossibleMetadataMatch?: boolean;
  readonly enrich?: boolean;
  readonly pdfPath?: string;
  readonly pdfFileName?: string;
  readonly expectedPdf?: { readonly sha256: string; readonly byteLength: number };
}) {
  const candidate = input.enrich
    ? await enrichScientSourceCandidate(input.candidate)
    : input.candidate;
  const candidateWithPdfName =
    input.pdfPath && input.pdfFileName
      ? { ...candidate, pdfFileName: input.pdfFileName }
      : candidate;
  return importScientSource({
    root: input.root,
    operationId: `agent_${NodeCrypto.randomUUID()}`,
    candidate: candidateWithPdfName,
    actor: "agent",
    intake: input.pdfPath ? "local-pdf" : "identifier",
    review: "pending",
    allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
    ...(input.pdfPath ? { pdfPath: input.pdfPath } : {}),
    ...(input.expectedPdf ? { expectedPdf: input.expectedPdf } : {}),
  });
}

export async function prepareAgentProjectPdf(input: {
  readonly sourceKey: string;
  readonly sourcePath: string;
  readonly fileName: string;
}) {
  return prepareProjectPdfSource(input);
}

export async function attachSourcePdf(input: Parameters<typeof attachScientSourcePdf>[0]) {
  return attachScientSourcePdf(input);
}

export async function detachSourcePdf(input: Parameters<typeof detachScientSourcePdf>[0]) {
  return detachScientSourcePdf(input);
}

function candidateEvidenceFields(candidate: ScientSourceCandidate): ReadonlySet<string> {
  return new Set(
    candidate.fieldProvenance.map((entry) =>
      entry.field.startsWith("identifiers.") ? "identifiers" : entry.field,
    ),
  );
}

function proposedMetadataValue<A>(input: {
  readonly field: ScientSourceEditableField;
  readonly evidence: ReadonlySet<string>;
  readonly current: A;
  readonly candidate: A;
  readonly present: boolean;
  readonly takenFields: Set<ScientSourceEditableField>;
}): A {
  if (input.evidence.has(input.field) && input.present) {
    input.takenFields.add(input.field);
    return input.candidate;
  }
  return input.current;
}

function provenanceEditableField(field: string): string {
  return field.startsWith("identifiers.") ? "identifiers" : field;
}

function mergeRefreshedFieldProvenance(input: {
  readonly current: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly candidate: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly takenFields: ReadonlySet<ScientSourceEditableField>;
}): ReadonlyArray<ScientSourceFieldProvenance> {
  const taken = (field: string) =>
    input.takenFields.has(provenanceEditableField(field) as ScientSourceEditableField);
  return [
    ...input.current.filter((entry) => !taken(entry.field)),
    ...input.candidate.filter((entry) => taken(entry.field)),
  ];
}

function proposeRefreshedSourceUpdate(input: {
  readonly record: ScientSourceRecord;
  readonly candidate: ScientSourceCandidate;
}): {
  readonly metadata: ScientSourceEditableMetadata;
  readonly takenFields: ReadonlySet<ScientSourceEditableField>;
} {
  const current = editableMetadataFromRecord(input.record);
  const candidate = input.candidate;
  const evidence = candidateEvidenceFields(candidate);
  const takenFields = new Set<ScientSourceEditableField>();
  const customTypeEvidence = evidence.has("type") ? new Set(["customType"]) : evidence;
  const hasIssuedEvidence = evidence.has("issuedRaw") || evidence.has("issuedYear");
  const issuedYear =
    hasIssuedEvidence && candidate.issuedYear !== null ? candidate.issuedYear : current.issuedYear;
  if (hasIssuedEvidence && candidate.issuedYear !== null) takenFields.add("issuedYear");
  const metadata = normalizeScientSourceEditableMetadata({
    type: proposedMetadataValue({
      field: "type",
      evidence,
      current: current.type,
      candidate: candidate.type,
      present: true,
      takenFields,
    }),
    customType: proposedMetadataValue({
      field: "customType",
      evidence: customTypeEvidence,
      current: current.customType ?? null,
      candidate: candidate.customType ?? null,
      present: candidate.type === "other" && Boolean(candidate.customType?.trim()),
      takenFields,
    }),
    title: proposedMetadataValue({
      field: "title",
      evidence,
      current: current.title,
      candidate: candidate.title,
      present: Boolean(candidate.title?.trim()),
      takenFields,
    }),
    creators: proposedMetadataValue({
      field: "creators",
      evidence,
      current: current.creators,
      candidate: candidate.creators,
      present: candidate.creators.length > 0,
      takenFields,
    }),
    issuedRaw: proposedMetadataValue({
      field: "issuedRaw",
      evidence,
      current: current.issuedRaw,
      candidate: candidate.issuedRaw,
      present: Boolean(candidate.issuedRaw?.trim()),
      takenFields,
    }),
    issuedYear,
    identifiers: proposedMetadataValue({
      field: "identifiers",
      evidence,
      current: current.identifiers,
      candidate: candidate.identifiers,
      present: candidate.identifiers.length > 0,
      takenFields,
    }),
    abstract: proposedMetadataValue({
      field: "abstract",
      evidence,
      current: current.abstract,
      candidate: candidate.abstract,
      present: Boolean(candidate.abstract?.trim()),
      takenFields,
    }),
    containerTitle: proposedMetadataValue({
      field: "containerTitle",
      evidence,
      current: current.containerTitle,
      candidate: candidate.containerTitle,
      present: Boolean(candidate.containerTitle?.trim()),
      takenFields,
    }),
    publisher: proposedMetadataValue({
      field: "publisher",
      evidence,
      current: current.publisher,
      candidate: candidate.publisher,
      present: Boolean(candidate.publisher?.trim()),
      takenFields,
    }),
    volume: proposedMetadataValue({
      field: "volume",
      evidence,
      current: current.volume,
      candidate: candidate.volume,
      present: Boolean(candidate.volume?.trim()),
      takenFields,
    }),
    issue: proposedMetadataValue({
      field: "issue",
      evidence,
      current: current.issue,
      candidate: candidate.issue,
      present: Boolean(candidate.issue?.trim()),
      takenFields,
    }),
    pages: proposedMetadataValue({
      field: "pages",
      evidence,
      current: current.pages,
      candidate: candidate.pages,
      present: Boolean(candidate.pages?.trim()),
      takenFields,
    }),
    language: proposedMetadataValue({
      field: "language",
      evidence,
      current: current.language,
      candidate: candidate.language,
      present: Boolean(candidate.language?.trim()),
      takenFields,
    }),
    url: proposedMetadataValue({
      field: "url",
      evidence,
      current: current.url,
      candidate: candidate.url,
      present: Boolean(candidate.url?.trim()),
      takenFields,
    }),
    tags: proposedMetadataValue({
      field: "tags",
      evidence,
      current: current.tags,
      candidate: candidate.tags,
      present: candidate.tags.length > 0,
      takenFields,
    }),
  });
  return { metadata, takenFields };
}

export function proposeRefreshedSourceMetadata(input: {
  readonly record: ScientSourceRecord;
  readonly candidate: ScientSourceCandidate;
}): ScientSourceEditableMetadata {
  return proposeRefreshedSourceUpdate(input).metadata;
}

export async function applyRefreshedSourceMetadata(input: {
  readonly root: string;
  readonly record: ScientSourceRecord;
  readonly candidate: ScientSourceCandidate;
}) {
  const currentMetadata = editableMetadataFromRecord(input.record);
  const proposed = proposeRefreshedSourceUpdate({
    record: input.record,
    candidate: input.candidate,
  });
  const metadata = proposed.metadata;
  const changedFields = changedEditableMetadataFields(currentMetadata, metadata);
  if (changedFields.length === 0) {
    return {
      outcome: "unchanged" as const,
      record: input.record,
      changedFields,
      message: "Metadata is already up to date.",
    };
  }

  const result = await updateScientSourceMetadata({
    root: input.root,
    sourceId: input.record.sourceId,
    expectedRevision: input.record.revision,
    metadata,
    fieldProvenance: mergeRefreshedFieldProvenance({
      current: input.record.fieldProvenance,
      candidate: input.candidate.fieldProvenance,
      takenFields: proposed.takenFields,
    }),
    // A refresh may make a weak title/creator/year resemblance more obvious,
    // but only an exact work identifier is strong enough to block this write.
    allowPossibleMetadataMatch: true,
    // Imported records can contain incomplete metadata, such as an unknown
    // custom source type. Refresh may improve other fields without first
    // requiring the user to repair pre-existing validation issues.
    allowExistingValidationIssues: true,
  });
  if (result.outcome === "updated") {
    return {
      outcome: "refreshed" as const,
      record: result.record,
      changedFields,
      message: "Source metadata was refreshed.",
    };
  }
  if (result.outcome === "stale") {
    return {
      outcome: "stale" as const,
      record: result.record,
      changedFields: [],
      message: "This source changed while its metadata was being refreshed.",
    };
  }
  if (result.outcome === "duplicate") {
    return {
      outcome: "duplicate" as const,
      record: result.record,
      changedFields: [],
      message: "Refresh stopped because the resulting identifier belongs to another source.",
    };
  }
  return {
    outcome: "unchanged" as const,
    record: result.record,
    changedFields: [],
    message: "Metadata is already up to date.",
  };
}

export async function refreshScientSourceMetadata(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly expectedRevision: number;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  const record = await readScientSourceRecord(root, input.sourceId);
  if (!record) throw new Error("The source was not found in this project.");
  if (record.revision !== input.expectedRevision) {
    return {
      outcome: "stale" as const,
      record,
      changedFields: [],
      message: "This source changed after you opened it.",
    };
  }

  const pdf = record.attachments.find((attachment) => attachment.kind === "pdf") ?? null;
  const hasResolvableIdentifier = record.identifiers.some((identifier) =>
    ["doi", "pmid"].includes(identifier.scheme.trim().toLowerCase()),
  );
  if (!pdf && !hasResolvableIdentifier) {
    return {
      outcome: "unavailable" as const,
      record,
      changedFields: [],
      message: "Add a PDF, DOI, or PMID before refreshing this source's metadata.",
    };
  }

  const candidate = await refreshExistingSourceCandidate({
    record,
    pdfPath: pdf ? sourceAttachmentAbsolutePath(root, pdf) : null,
  });
  const latest = await readScientSourceRecord(root, input.sourceId);
  if (!latest) throw new Error("The source was removed while its metadata was being checked.");
  if (latest.revision !== input.expectedRevision) {
    return {
      outcome: "stale" as const,
      record: latest,
      changedFields: [],
      message: "This source changed while its metadata was being checked.",
    };
  }
  return applyRefreshedSourceMetadata({ root, record: latest, candidate });
}

export async function removeSource(input: Parameters<typeof removeScientSource>[0]) {
  return removeScientSource(input);
}

export async function assessSourcePreflightDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly pdfPath: string | null;
}): Promise<ScientSourceDuplicateAssessment> {
  const preliminary = assessSourceDuplicate({
    candidate: input.candidate,
    existing: input.existing,
  });
  if (
    !input.pdfPath ||
    (preliminary.kind !== "new" && preliminary.kind !== "possible-metadata-match")
  ) {
    return preliminary;
  }
  const pdf = await inspectScientSourcePdf(input.pdfPath);
  return assessSourceDuplicate({
    candidate: input.candidate,
    existing: input.existing,
    pdfSha256: pdf.sha256,
  });
}

export async function preflightZoteroImport(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const records = await listScientSourceRecords(input.root);
  const hasImportedPdf = records.some((record) =>
    record.attachments.some((attachment) => attachment.kind === "pdf"),
  );
  const items = [];
  for (const itemKey of new Set(input.itemKeys)) {
    const { candidate, pdfPath } = hasImportedPdf
      ? await getZoteroImportMaterial(itemKey)
      : { candidate: await getZoteroItem(itemKey), pdfPath: null };
    const duplicate = await assessSourcePreflightDuplicate({
      candidate,
      existing: records,
      pdfPath,
    });
    items.push({
      candidate,
      duplicate,
      metadataDiagnostics: sourceMetadataDiagnostics(candidate),
    });
  }
  return { items };
}

export async function beginZoteroImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
}) {
  return createSourceImportOperation({ ...input, adapter: "zotero" });
}

export async function beginZoteroScopedImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
}) {
  const existing = await readSourceImportOperation(input.root, input.operationId);
  if (existing) {
    if (existing.adapter !== "zotero") {
      throw new Error("This operation ID already belongs to another import adapter.");
    }
    return existing;
  }
  const itemKeys = await listZoteroScopeItemKeys(input.scope);
  return createSourceImportOperation({
    root: input.root,
    operationId: input.operationId,
    adapter: "zotero",
    itemKeys,
  });
}

export async function uploadLocalPdfSource(input: {
  readonly root: string;
  readonly sourcePath: string;
  readonly fileName: string;
}) {
  return { item: await prepareLocalPdfSource(input) };
}

export async function beginLocalPdfImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
}) {
  for (const sourceKey of new Set(input.itemKeys)) {
    await getLocalPdfImportMaterial(input.root, sourceKey);
  }
  return createSourceImportOperation({ ...input, adapter: "local-files" });
}

export async function discardLocalPdfSources(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const keys = [...new Set(input.itemKeys)];
  await Promise.all(keys.map((sourceKey) => discardLocalPdfImportMaterial(input.root, sourceKey)));
  return { discarded: keys.length };
}

export async function advanceSourceImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return withOperationLane(`${root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    const pending = operation.items.find((item) => item.state === "pending");
    if (!pending) return operation;
    try {
      const { candidate, pdfPath, expectedPdf } =
        operation.adapter === "zotero"
          ? { ...(await getZoteroImportMaterial(pending.itemKey)), expectedPdf: undefined }
          : await getLocalPdfImportMaterial(root, pending.itemKey);
      const result = await importScientSourceOperationItem({
        root,
        operationId: input.operationId,
        candidate,
        actor: operation.actor,
        intake: operation.intake,
        review: operation.actor === "agent" ? "pending" : "none",
        ...(pdfPath ? { pdfPath } : {}),
        ...(expectedPdf ? { expectedPdf } : {}),
        allowPossibleMetadataMatch: pending.allowPossibleMetadataMatch ?? false,
      });
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: result.outcome === "imported" ? "imported" : "skipped",
        duplicateKind: result.duplicate.kind,
        ...(result.record ? { sourceId: result.record.sourceId } : {}),
        message: result.duplicate.reason,
      });
      if (operation.adapter === "local-files") {
        await discardLocalPdfImportMaterial(root, pending.itemKey);
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The source could not be imported.";
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: "failed",
        message,
      });
      return updated;
    }
  });
}

export async function cancelSourceImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return withOperationLane(`${root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    const cancelled = await cancelSourceImportOperation(root, input.operationId);
    if (operation.adapter === "local-files") {
      await Promise.all(
        operation.items
          .filter((item) => item.state === "pending" || item.state === "failed")
          .map((item) => discardLocalPdfImportMaterial(root, item.itemKey).catch(() => undefined)),
      );
    }
    return cancelled;
  });
}

export async function retrySourceImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return retryFailedSourceImportOperationItems(root, input.operationId, input.itemKeys);
}
