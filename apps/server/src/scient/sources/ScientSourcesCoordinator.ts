// @effect-diagnostics nodeBuiltinImport:off -- This owned Promise-based Sources coordinator assigns its store operation ID synchronously.
// @effect-diagnostics globalDate:off -- Check records keep the interoperable ISO timestamp the store uses.
import * as NodeCrypto from "node:crypto";

import { observeSourceImport, type SourceImportObserver } from "./SourceImportObservation.ts";
import { enrichScientSourceCandidate } from "./SourceMetadataEnricher.ts";
import {
  applyResolvedSourceMetadata,
  creatorDisplayName,
  resolveSourceIdentifier,
  titlesAgree,
  type ResolveSourceIdentifier,
} from "./SourceIdentifierResolver.ts";
import {
  discardLocalPdfImportMaterial,
  getLocalPdfImportMaterial,
  prepareLocalPdfSource,
  prepareProjectPdfSource,
  refreshExistingSourceCandidate,
} from "./LocalPdfSourceAdapter.ts";
import {
  sourceIdentifierLabel as identifierLabel,
  sourceIdentifierRegistryName as registryName,
  abstractDocumentFromSections,
  changedEditableMetadataFields,
  editableMetadataFromRecord,
  editorialStatusFromNotices,
  normalizeScientSourceAbstractDocument,
  normalizeScientSourceEditableMetadata,
  sourceMetadataDiagnostics,
  assessSourceDuplicate,
  scientSourceSummaryFromRecord,
  type ScientSourceActor,
  type ScientSourceAttachmentRetrieval,
  type ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourceEditableField,
  type ScientSourceEditableMetadata,
  type ScientSourceEditorialStatus,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourceImportOperation,
  type ScientSourceOrigin,
  type ScientSourceRecord,
  type ScientSourceVerification,
  type ZoteroConnection,
  type ZoteroImportScope,
} from "@scientfactory/scient-sources";
import {
  bulkUpdateScientSources,
  createScientSourceCollection,
  organizeScientSources,
  readScientSourcesOrganization,
} from "@scientfactory/scient-sources/collections";
import {
  readScientSourceCategories,
  scientSourceCategorySummaryFor,
} from "@scientfactory/scient-sources/categories-store";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import {
  changeScientSystematicReview,
  listScientSystematicReviews,
  readScientSystematicReview,
} from "@scientfactory/scient-sources/systematic-review";
import {
  cancelSourceImportOperation,
  canonicalizeScientSourceRoot,
  createSourceImportOperation,
  deleteScientSourcesPermanently,
  listScientSourceRevisions,
  listScientSourceTrash,
  restoreScientSource,
  revertScientSource,
  importScientSource,
  importScientSourceOperationItem,
  attachScientSourcePdf,
  detachScientSourcePdf,
  inspectScientSourcePdf,
  inspectScientSources,
  listScientSourceRecords,
  readScientSourceRecord,
  readSourceImportOperation,
  recordScientSourceCheck,
  retryFailedSourceImportOperationItems,
  removeScientSource,
  updateSourceImportOperationItem,
  updateScientSourceMetadata,
  updateScientSourceNote,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";

import {
  inspectZotero,
  localOnlyZoteroAccess,
  zoteroTransport,
  type ZoteroAccess,
} from "./ZoteroConnections.ts";
import {
  getZoteroItemWith,
  listZoteroCollectionsWith,
  listZoteroLibraryWith,
  listZoteroScopeItemKeysWith,
  readZoteroAttachmentFiles,
  readZoteroItemMaterial,
  type ZoteroTransport,
} from "./ZoteroLibraryReader.ts";
import { resolveJournalIcon } from "./JournalIconResolver.ts";
import { renameCitationKeyInProject, scanCitationKeyRenameDocuments } from "./LibraryCitation.ts";
import {
  syncManagedBibliography,
  type ManagedBibliographyFileName,
} from "./ManagedBibliography.ts";
import {
  beginBibliographyFileImport,
  discardBibliographyFileImport,
  fileImportVerification,
  getBibliographyFileImportMaterial,
  readBibliographyFile,
  resolveProjectBibliographyFile,
} from "./BibliographyFileAdapter.ts";
import { recordZoteroSync } from "./ZoteroSync.ts";
import { scheduleSourceFullTextIndexing } from "./SourceFullText.ts";
import {
  forgetSourceCategories,
  scheduleSourceCategorization,
  seedSourceCategories,
} from "./SourceCategories.ts";

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

export async function inspectZoteroConnection(input: {
  readonly connection?: ZoteroConnection;
  readonly zotero?: ZoteroAccess;
}) {
  return inspectZotero(input.zotero ?? localOnlyZoteroAccess, input.connection);
}

export async function listZoteroCollections(input: {
  readonly connection?: ZoteroConnection;
  readonly zotero?: ZoteroAccess;
}) {
  return listZoteroCollectionsWith(
    await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection),
  );
}

export async function listZoteroLibrary(input: {
  readonly scope: ZoteroImportScope;
  readonly query: string;
  readonly start: number;
  readonly limit: number;
  readonly connection?: ZoteroConnection;
  readonly zotero?: ZoteroAccess;
}) {
  return listZoteroLibraryWith(
    await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection),
    input,
  );
}

const zoteroAdapter = (connection: ZoteroConnection | undefined) =>
  connection === "web" ? ("zotero-web" as const) : ("zotero" as const);

/**
 * An item with its notes, citation key and PDFs copied out of Zotero. The caller
 * imports the first PDF with the record, attaches the rest, then releases them all.
 */
async function zoteroImportMaterial(transport: ZoteroTransport, itemKey: string) {
  const material = await readZoteroItemMaterial(transport, itemKey);
  const files = await readZoteroAttachmentFiles(transport, material.pdfs);
  try {
    const candidate = await enrichScientSourceCandidate({
      ...material.candidate,
      ...(material.note ? { note: material.note } : {}),
      ...(files[0]?.fileName ? { pdfFileName: files[0].fileName } : {}),
    });
    return { candidate, material, files };
  } catch (error) {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
    throw error;
  }
}

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
  const organization =
    overview.projectState === "initialized"
      ? await readScientSourcesOrganization(
          root,
          new Set(overview.records.map((record) => record.sourceId)),
        )
      : null;
  void scheduleSourceFullTextIndexing(root);
  const categories =
    overview.projectState === "initialized"
      ? await readScientSourceCategories(root).catch(() => ({}))
      : {};
  if (overview.projectState === "initialized") void scheduleSourceCategorization(root);
  return {
    ...overview,
    records: overview.records.map((record) => {
      const summary = scientSourceSummaryFromRecord(record);
      const category = scientSourceCategorySummaryFor(record, categories);
      return category ? { ...summary, categories: category } : summary;
    }),
    recordDiagnostics: overview.records.map((record) => ({
      sourceId: record.sourceId,
      diagnostics: sourceMetadataDiagnostics(record),
    })),
    ...(organization ? { organization } : {}),
  };
}

export async function organizeSources(input: Parameters<typeof organizeScientSources>[0]) {
  return organizeScientSources(input);
}

export async function listSystematicReviews(root: string) {
  return listScientSystematicReviews(root);
}

export async function getSystematicReview(input: {
  readonly root: string;
  readonly reviewId: string;
}) {
  return { detail: await readScientSystematicReview(input.root, input.reviewId) };
}

export async function changeSystematicReview(
  input: Parameters<typeof changeScientSystematicReview>[0],
) {
  return changeScientSystematicReview(input);
}

export async function bulkUpdateSources(input: Parameters<typeof bulkUpdateScientSources>[0]) {
  return bulkUpdateScientSources(input);
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

/** A deliberate citation key rename also renames the key where project documents cite it. */
export async function updateScientSource(input: Parameters<typeof updateScientSourceMetadata>[0]) {
  const previousKey = input.metadata.citationKey
    ? (await readScientSourceRecord(input.root, input.sourceId))?.citationKey
    : undefined;
  // Find the documents before the key changes, so a scan failure leaves the old key in place.
  const scan =
    previousKey && previousKey !== input.metadata.citationKey
      ? await scanCitationKeyRenameDocuments(input.root)
      : undefined;
  const result = await updateScientSourceMetadata(input);
  const nextKey = result.record.citationKey;
  if (result.outcome !== "updated" || !previousKey || !nextKey || previousKey === nextKey) {
    return result;
  }
  const { renamedIn, skipped } = await renameCitationKeyInProject(
    input.root,
    previousKey,
    nextKey,
    scan,
  );
  return {
    ...result,
    citationKeyRenamedIn: renamedIn,
    ...(skipped.length > 0 ? { citationKeyRenameSkipped: skipped } : {}),
  };
}

export async function updateSourceNote(input: Parameters<typeof updateScientSourceNote>[0]) {
  return updateScientSourceNote(input);
}

export interface ResolvedSourceSummary {
  readonly title: string | null;
  readonly creators: ReadonlyArray<string>;
  readonly issuedYear: number | null;
  readonly containerTitle: string | null;
}

export type AgentSourceAddResult =
  | Awaited<ReturnType<typeof importScientSource>>
  | {
      readonly outcome: "identifier-not-found";
      readonly identifier: ScientSourceIdentifier;
      readonly message: string;
    }
  | {
      readonly outcome: "identifier-mismatch";
      readonly identifier: ScientSourceIdentifier;
      readonly resolved: ResolvedSourceSummary;
      readonly message: string;
    };

/**
 * Adds a source after checking its identifier against its registry, for an agent or (with actor
 * "user") a person adding by identifier: both get the same refusals and verification states.
 */
export async function addAgentSource(
  input: {
    readonly root: string;
    readonly candidate: ScientSourceCandidate;
    readonly allowPossibleMetadataMatch?: boolean;
    readonly enrich?: boolean;
    readonly pdfPath?: string;
    readonly pdfFileName?: string;
    readonly expectedPdf?: { readonly sha256: string; readonly byteLength: number };
    readonly resolveIdentifier?: ResolveSourceIdentifier;
    /** The title the agent asserted; PDF-derived and filename titles are not claims. */
    readonly claimedTitle?: string | null;
    /** A downloaded paper is added for whoever asked for it. */
    readonly actor?: ScientSourceActor;
    readonly intake?: ScientSourceOrigin["intake"];
    readonly pdfRetrieval?: ScientSourceAttachmentRetrieval;
  },
  observer?: SourceImportObserver,
): Promise<AgentSourceAddResult> {
  return observeSourceImport<AgentSourceAddResult>(
    observer,
    async () => {
      const preliminary = assessSourceDuplicate({
        candidate: input.candidate,
        existing: await listScientSourceRecords(input.root),
        ...(input.expectedPdf ? { pdfSha256: input.expectedPdf.sha256 } : {}),
      });
      // An exact duplicate is reported as before, without asking a registry.
      const exactDuplicate =
        preliminary.kind !== "new" && preliminary.kind !== "possible-metadata-match";
      const resolution = exactDuplicate
        ? null
        : await (input.resolveIdentifier ?? resolveSourceIdentifier)(input.candidate.identifiers);
      if (resolution?.status === "not-found") {
        const missing = resolution.named ?? resolution.identifier;
        return {
          outcome: "identifier-not-found",
          identifier: missing,
          message: `The ${identifierLabel(missing)} does not exist at ${registryName(missing)}. Check the identifier; do not guess.`,
        };
      }
      // A catalogue's record fills in the work while its registry cannot be reached.
      const record =
        resolution?.status === "found"
          ? resolution
          : resolution?.status === "unavailable" && resolution.catalogue
            ? {
                status: "found" as const,
                identifier: resolution.identifier,
                ...resolution.catalogue,
              }
            : null;
      if (
        record &&
        input.claimedTitle &&
        record.metadata.title &&
        !titlesAgree(input.claimedTitle, record.metadata.title)
      ) {
        return {
          outcome: "identifier-mismatch",
          identifier: record.identifier,
          resolved: {
            title: record.metadata.title,
            creators: record.metadata.creators
              .slice(0, 3)
              .flatMap((creator) => creatorDisplayName(creator) ?? []),
            issuedYear: record.metadata.issuedYear,
            containerTitle: record.metadata.containerTitle,
          },
          message: `The ${identifierLabel(record.identifier)} belongs to a work with a different title. Check whether the identifier or the title is wrong; do not guess. If the resolved work is the one meant, add it again without a title.`,
        };
      }
      const verification: ScientSourceVerification | null = exactDuplicate
        ? null
        : resolution === null || (resolution.status === "found" && resolution.catalogueOnly)
          ? { state: "unverified" }
          : resolution.status === "found"
            ? {
                state: "verified",
                identifier: resolution.identifier,
                checkedAt: resolution.retrievedAt,
              }
            : { state: "unchecked", identifier: resolution.identifier };
      const editorialStatus =
        resolution?.status === "found" &&
        !resolution.catalogueOnly &&
        resolution.metadata.editorialNotices
          ? editorialStatusFromNotices(resolution.metadata.editorialNotices, resolution.retrievedAt)
          : null;
      const resolved = record
        ? applyResolvedSourceMetadata(input.candidate, record)
        : input.candidate;
      const candidate = input.enrich ? await enrichScientSourceCandidate(resolved) : resolved;
      const candidateWithPdfName =
        input.pdfPath && input.pdfFileName
          ? { ...candidate, pdfFileName: input.pdfFileName }
          : candidate;
      const imported = await importScientSource({
        root: input.root,
        operationId: `agent_${NodeCrypto.randomUUID()}`,
        candidate: candidateWithPdfName,
        actor: input.actor ?? "agent",
        intake: input.intake ?? (input.pdfPath ? "local-pdf" : "identifier"),
        ...(verification ? { verification } : {}),
        ...(editorialStatus ? { editorialStatus } : {}),
        ...(input.pdfRetrieval ? { pdfRetrieval: input.pdfRetrieval } : {}),
        allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
        ...(input.pdfPath ? { pdfPath: input.pdfPath } : {}),
        ...(input.expectedPdf ? { expectedPdf: input.expectedPdf } : {}),
      });
      if (imported.outcome === "imported" && imported.record) {
        seedSourceCategories(input.root, imported.record.sourceId, record?.metadata.topics);
        void scheduleSourceCategorization(input.root);
      }
      return imported;
    },
    (result) => (result.outcome === "imported" ? "imported" : "skipped"),
  );
}

export type SourceCheckRegistryOutcome =
  | "found"
  | "not-found"
  | "mismatch"
  | "unavailable"
  | "none";

/**
 * Checks a source's identifier against its registry again and records what it says: verification
 * and retraction or correction notices. Metadata is never changed here. An unreachable registry
 * keeps an earlier verdict for the same identifier.
 */
export async function checkSourceIdentifier(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
  readonly resolveIdentifier?: ResolveSourceIdentifier;
  readonly now?: () => Date;
}): Promise<{
  readonly outcome: "updated" | "unchanged" | "stale";
  readonly registry: SourceCheckRegistryOutcome;
  readonly record: ScientSourceRecord;
}> {
  const record = await readScientSourceRecord(input.root, input.sourceId);
  if (!record) throw new Error("The source was not found in this project.");
  const resolved = await (input.resolveIdentifier ?? resolveSourceIdentifier)(record.identifiers);
  // A catalogue's word alone is not a registry check: treat it like an unreachable registry.
  const resolution =
    resolved?.status === "found" && resolved.catalogueOnly
      ? { status: "unavailable" as const, identifier: resolved.identifier }
      : resolved;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const previous = record.verification;
  const sameIdentifier =
    resolution !== null &&
    previous?.identifier?.scheme === resolution.identifier.scheme &&
    previous.identifier.value === resolution.identifier.value;
  const mismatch =
    resolution?.status === "found" &&
    Boolean(record.title && resolution.metadata.title) &&
    !titlesAgree(record.title!, resolution.metadata.title!);
  const registry: SourceCheckRegistryOutcome =
    resolution === null ? "none" : mismatch ? "mismatch" : resolution.status;
  const check: {
    readonly verification: ScientSourceVerification;
    readonly editorialStatus: ScientSourceEditorialStatus | null;
  } =
    resolution === null
      ? { verification: { state: "unverified" }, editorialStatus: null }
      : resolution.status === "found" && !mismatch
        ? {
            verification: {
              state: "verified",
              identifier: resolution.identifier,
              checkedAt: resolution.retrievedAt,
            },
            editorialStatus: resolution.metadata.editorialNotices
              ? editorialStatusFromNotices(
                  resolution.metadata.editorialNotices,
                  resolution.retrievedAt,
                )
              : null,
          }
        : resolution.status === "unavailable"
          ? {
              verification:
                sameIdentifier && previous
                  ? previous
                  : { state: "unchecked", identifier: resolution.identifier },
              editorialStatus: sameIdentifier ? (record.editorialStatus ?? null) : null,
            }
          : {
              verification: {
                state: "unverified",
                identifier: resolution.identifier,
                checkedAt,
                problem: mismatch ? "mismatch" : "not-found",
              },
              editorialStatus: null,
            };
  const result = await recordScientSourceCheck({
    root: input.root,
    sourceId: input.sourceId,
    expectedRevision: record.revision,
    ...check,
    actor: input.actor,
  });
  return { ...result, registry };
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
  readonly resolveIdentifier?: ResolveSourceIdentifier;
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

  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
  const hasResolvableIdentifier = record.identifiers.some((identifier) =>
    ["doi", "pmid"].includes(identifier.scheme.trim().toLowerCase()),
  );
  if (!pdf && !hasResolvableIdentifier) {
    return {
      outcome: "unavailable" as const,
      record,
      changedFields: [],
      message:
        materialSelection._tag === "SeveralMaterials"
          ? "This source has several PDFs. Metadata refresh needs an explicit material choice."
          : "Add a PDF, DOI, or PMID before refreshing this source's metadata.",
    };
  }

  const candidate = await refreshExistingSourceCandidate({
    record,
    pdfMaterial: pdf,
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
  const refreshed = await applyRefreshedSourceMetadata({ root, record: latest, candidate });
  if (refreshed.outcome !== "refreshed" && refreshed.outcome !== "unchanged") return refreshed;
  // Study design and topics are looked up again too, off this request.
  await forgetSourceCategories(root, input.sourceId).catch(() => undefined);
  void scheduleSourceCategorization(root);
  // A refresh also re-checks the identifier, so retractions and verification stay current.
  const checked = await checkSourceIdentifier({
    root,
    sourceId: input.sourceId,
    actor: "user",
    ...(input.resolveIdentifier ? { resolveIdentifier: input.resolveIdentifier } : {}),
  }).catch(() => null);
  if (checked?.outcome !== "updated") return refreshed;
  return {
    ...refreshed,
    outcome: "refreshed" as const,
    record: checked.record,
    message:
      refreshed.outcome === "refreshed"
        ? refreshed.message
        : "The identifier was checked again with its registry.",
  };
}

export async function removeSource(input: Parameters<typeof removeScientSource>[0]) {
  return removeScientSource(input);
}

export async function listSourceTrash(input: { readonly root: string }) {
  return listScientSourceTrash(input.root);
}

export async function restoreSource(input: Parameters<typeof restoreScientSource>[0]) {
  return restoreScientSource(input);
}

export async function deleteSourcesPermanently(
  input: Parameters<typeof deleteScientSourcesPermanently>[0],
) {
  return deleteScientSourcesPermanently(input);
}

export async function listSourceRevisions(input: {
  readonly root: string;
  readonly sourceId: string;
}) {
  const revisions = await listScientSourceRevisions(input.root, input.sourceId);
  if (!revisions) throw new Error("The source was not found in this project.");
  return { revisions };
}

export async function revertSource(input: Parameters<typeof revertScientSource>[0]) {
  return revertScientSource(input);
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
  readonly connection?: ZoteroConnection;
  readonly zotero?: ZoteroAccess;
}) {
  const records = await listScientSourceRecords(input.root);
  const transport = await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection);
  // Only local PDFs are cheap enough to hash for a duplicate check before import.
  const hasImportedPdf =
    transport.connection === "local" &&
    records.some((record) => record.attachments.some((attachment) => attachment.kind === "pdf"));
  const items = [];
  for (const itemKey of new Set(input.itemKeys)) {
    const material = hasImportedPdf ? await zoteroImportMaterial(transport, itemKey) : null;
    const candidate = material?.candidate ?? (await getZoteroItemWith(transport, itemKey));
    const duplicate = await assessSourcePreflightDuplicate({
      candidate,
      existing: records,
      pdfPath: material?.files[0]?.path ?? null,
    }).finally(() =>
      Promise.all(material?.files.map((file) => file.release().catch(() => undefined)) ?? []),
    );
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
  readonly connection?: ZoteroConnection;
  readonly actor?: "user" | "agent";
}) {
  return createSourceImportOperation({
    root: input.root,
    operationId: input.operationId,
    itemKeys: input.itemKeys,
    possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
    adapter: zoteroAdapter(input.connection),
    ...(input.actor ? { actor: input.actor } : {}),
  });
}

export async function beginZoteroScopedImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
  readonly connection?: ZoteroConnection;
  readonly actor?: "user" | "agent";
  readonly zotero?: ZoteroAccess;
}) {
  const adapter = zoteroAdapter(input.connection);
  const existing = await readSourceImportOperation(input.root, input.operationId);
  if (existing) {
    if (existing.adapter !== adapter) {
      throw new Error("This operation ID already belongs to another import adapter.");
    }
    return existing;
  }
  const transport = await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection);
  const itemKeys = await listZoteroScopeItemKeysWith(transport, input.scope);
  return createSourceImportOperation({
    root: input.root,
    operationId: input.operationId,
    adapter,
    itemKeys,
    ...(input.actor ? { actor: input.actor } : {}),
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

/** Where a Zotero collection's items go: a top-level collection, or one level under a parent. */
interface ZoteroCollectionPlace {
  readonly name: string;
  readonly parent?: string;
  /** A deeper Zotero collection whose items joined `name`, its ancestor one level down. */
  readonly flattened?: string;
}

const zoteroCollectionPlaces = new Map<
  string,
  Promise<ReadonlyMap<string, ZoteroCollectionPlace>>
>();

/** Zotero keeps any depth; the Library keeps one level, so deeper ones join that level. */
function zoteroCollectionPlacesFor(
  collections: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly parentCollectionKey: string | null;
  }>,
): ReadonlyMap<string, ZoteroCollectionPlace> {
  const byKey = new Map(collections.map((collection) => [collection.key, collection]));
  const ancestors = (key: string) => {
    const chain: string[] = [];
    let parent = byKey.get(key)?.parentCollectionKey ?? null;
    while (parent && byKey.has(parent) && !chain.includes(parent) && parent !== key) {
      chain.unshift(byKey.get(parent)!.name);
      parent = byKey.get(parent)!.parentCollectionKey;
    }
    return chain;
  };
  return new Map(
    collections.map((collection): [string, ZoteroCollectionPlace] => {
      const [top, level, ...deeper] = ancestors(collection.key);
      if (top === undefined) return [collection.key, { name: collection.name }];
      if (level === undefined) return [collection.key, { name: collection.name, parent: top }];
      return [
        collection.key,
        { name: level, parent: top, flattened: [...deeper, collection.name].join(" / ") },
      ];
    }),
  );
}

/**
 * An imported item joins a Library collection for each Zotero collection it is in. A
 * collection problem never fails the import; the source is in the Library either way. Returns
 * a note naming the collections nested too deep to keep, or null.
 */
async function addToZoteroCollections(input: {
  readonly root: string;
  readonly operation: ScientSourceImportOperation;
  readonly transport: ZoteroTransport;
  readonly sourceId: string;
  readonly collectionKeys: ReadonlyArray<string>;
}): Promise<string | null> {
  if (input.collectionKeys.length === 0) return null;
  const cacheKey = `${input.root}\0${input.operation.operationId}`;
  let places = zoteroCollectionPlaces.get(cacheKey);
  if (!places) {
    places = listZoteroCollectionsWith(input.transport).then((result) =>
      zoteroCollectionPlacesFor(result.collections),
    );
    if (zoteroCollectionPlaces.size >= 8) zoteroCollectionPlaces.clear();
    zoteroCollectionPlaces.set(cacheKey, places);
  }
  const resolved = await places.catch(() => new Map<string, ZoteroCollectionPlace>());
  const flattened: string[] = [];
  for (const key of input.collectionKeys) {
    const place = resolved.get(key);
    if (!place) continue;
    const parent = place.parent
      ? await createScientSourceCollection({
          root: input.root,
          name: place.parent,
          actor: input.operation.actor,
        }).catch(() => null)
      : null;
    if (place.parent && !parent?.collection) continue;
    const joined = await createScientSourceCollection({
      root: input.root,
      name: place.name,
      sourceIds: [input.sourceId],
      ...(parent?.collection ? { parentCollectionId: parent.collection.collectionId } : {}),
      actor: input.operation.actor,
    }).catch(() => null);
    if (joined?.collection && place.flattened) {
      flattened.push(`“${place.flattened}” joined “${place.parent} / ${place.name}”`);
    }
  }
  return flattened.length > 0
    ? `Zotero collections more than one level deep: ${flattened.join("; ")}.`
    : null;
}

/** A reference-file entry, with the PDFs its file names attached like any other PDF. */
async function importFileOperationItem(input: {
  readonly root: string;
  readonly operation: ScientSourceImportOperation;
  readonly itemKey: string;
  readonly allowPossibleMetadataMatch: boolean;
}) {
  const { candidate, pdfs } = await getBibliographyFileImportMaterial(
    input.root,
    input.operation.operationId,
    input.itemKey,
  );
  const [primary, ...extra] = pdfs;
  const result = await importScientSourceOperationItem({
    root: input.root,
    operationId: input.operation.operationId,
    candidate: primary
      ? {
          ...candidate,
          pdfAvailable: true,
          pdfFileName: primary.fileName,
          pdfAttachmentCount: pdfs.length,
        }
      : candidate,
    actor: input.operation.actor,
    intake: input.operation.intake,
    verification: fileImportVerification(candidate),
    ...(primary ? { pdfPath: primary.path } : {}),
    allowPossibleMetadataMatch: input.allowPossibleMetadataMatch,
  });
  let record = result.record;
  if (result.outcome !== "imported") return result;
  for (const pdf of extra) {
    if (!record) break;
    const attached = await attachScientSourcePdf({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      pdfPath: pdf.path,
      fileName: pdf.fileName,
      actor: input.operation.actor,
    });
    record = attached.record;
  }
  return { ...result, record };
}

async function importZoteroOperationItem(input: {
  readonly root: string;
  readonly operation: ScientSourceImportOperation;
  readonly itemKey: string;
  readonly allowPossibleMetadataMatch: boolean;
  readonly zotero: ZoteroAccess;
}) {
  const transport = await zoteroTransport(
    input.zotero,
    input.operation.adapter === "zotero-web" ? "web" : "local",
  );
  const { candidate, material, files } = await zoteroImportMaterial(transport, input.itemKey);
  try {
    const [primary, ...extra] = files;
    const result = await importScientSourceOperationItem({
      root: input.root,
      operationId: input.operation.operationId,
      candidate,
      actor: input.operation.actor,
      intake: input.operation.intake,
      ...(primary ? { pdfPath: primary.path } : {}),
      allowPossibleMetadataMatch: input.allowPossibleMetadataMatch,
    });
    let record = result.record;
    for (const file of extra) {
      if (!record) break;
      const attached = await attachScientSourcePdf({
        root: input.root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        pdfPath: file.path,
        ...(file.fileName ? { fileName: file.fileName } : {}),
        actor: input.operation.actor,
      });
      record = attached.record;
    }
    if (result.outcome === "imported" && record) {
      await recordZoteroSync({
        root: input.root,
        record,
        material,
        attachmentKeys: files.map((file) => file.attachmentKey),
      });
      const note = await addToZoteroCollections({
        root: input.root,
        operation: input.operation,
        transport,
        sourceId: record.sourceId,
        collectionKeys: material.collectionKeys,
      });
      return { ...result, record, ...(note ? { note } : {}) };
    }
    return { ...result, record };
  } finally {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
  }
}

export async function advanceSourceImport(
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly zotero?: ZoteroAccess;
  },
  observer?: SourceImportObserver,
) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return withOperationLane(`${root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    const pending = operation.items.find((item) => item.state === "pending");
    if (!pending) return operation;
    try {
      const result = await observeSourceImport(
        observer,
        async () => {
          if (operation.adapter === "zotero" || operation.adapter === "zotero-web") {
            return importZoteroOperationItem({
              root,
              operation,
              itemKey: pending.itemKey,
              allowPossibleMetadataMatch: pending.allowPossibleMetadataMatch ?? false,
              zotero: input.zotero ?? localOnlyZoteroAccess,
            });
          }
          if (operation.adapter === "file") {
            return importFileOperationItem({
              root,
              operation,
              itemKey: pending.itemKey,
              allowPossibleMetadataMatch: pending.allowPossibleMetadataMatch ?? false,
            });
          }
          const { candidate, pdfPath, expectedPdf } = await getLocalPdfImportMaterial(
            root,
            pending.itemKey,
          );
          return importScientSourceOperationItem({
            root,
            operationId: input.operationId,
            candidate,
            actor: operation.actor,
            intake: operation.intake,
            ...(pdfPath ? { pdfPath } : {}),
            ...(expectedPdf ? { expectedPdf } : {}),
            allowPossibleMetadataMatch: pending.allowPossibleMetadataMatch ?? false,
          });
        },
        (result) => (result.outcome === "imported" ? "imported" : "skipped"),
      );
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: result.outcome === "imported" ? "imported" : "skipped",
        duplicateKind: result.duplicate.kind,
        ...(result.record ? { sourceId: result.record.sourceId } : {}),
        message: result.duplicate.reason,
        ...("note" in result && typeof result.note === "string" ? { note: result.note } : {}),
      });
      if (operation.adapter === "local-files") {
        await discardLocalPdfImportMaterial(root, pending.itemKey);
      }
      // Failed entries keep the staged file so they can be retried.
      if (
        operation.adapter === "file" &&
        updated.state !== "running" &&
        !updated.items.some((item) => item.state === "failed")
      ) {
        await discardBibliographyFileImport(root, input.operationId);
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
    if (operation.adapter === "file") await discardBibliographyFileImport(root, input.operationId);
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

/**
 * Offers hand edits to the managed bibliography back to the Library: new entries
 * are imported like any reference file. A file whose only edits were new
 * entries, all now in the Library under their keys, is then written again;
 * one with changed or removed entries stays as the person left it.
 */
export async function syncManagedBibliographyWithImports(
  input: {
    readonly root: string;
    readonly replaceEdited?: ReadonlyArray<ManagedBibliographyFileName>;
    readonly importEdited?: ReadonlyArray<ManagedBibliographyFileName>;
    readonly actor: ScientSourceActor;
  },
  observer?: SourceImportObserver,
) {
  const importEdited = input.importEdited ?? [];
  if (importEdited.length === 0) {
    return syncManagedBibliography(
      input.root,
      input.replaceEdited ? { replaceEdited: input.replaceEdited } : {},
    );
  }
  const before = await syncManagedBibliography(input.root);
  let imported = 0;
  for (const name of importEdited) {
    if (before.files.find((file) => file.name === name)?.state !== "edited") continue;
    const file = await resolveProjectBibliographyFile(input.root, name);
    const result = await importBibliographyFile(
      {
        root: input.root,
        operationId: `bibliography_${NodeCrypto.randomUUID()}`,
        fileName: file.fileName,
        text: await readBibliographyFile(file.absolutePath),
        actor: input.actor,
      },
      observer,
    );
    imported += result.operation?.items.filter((item) => item.state === "imported").length ?? 0;
  }
  const keys = new Set(
    (await listScientSourceRecords(input.root)).flatMap((record) =>
      record.citationKey ? [record.citationKey] : [],
    ),
  );
  const fullyImported = before.files.flatMap((file) =>
    importEdited.includes(file.name) &&
    file.state === "edited" &&
    file.changes !== null &&
    file.changes.changed.length === 0 &&
    file.changes.removed.length === 0 &&
    file.changes.added.every((key) => keys.has(key))
      ? [file.name]
      : [],
  );
  const status = await syncManagedBibliography(input.root, {
    replaceEdited: [...(input.replaceEdited ?? []), ...fullyImported],
  });
  return { ...status, imported };
}

/** Begins a reference-file import and runs it to the end, for callers without a progress view. */
export async function importBibliographyFile(
  input: Parameters<typeof beginBibliographyFileImport>[0],
  observer?: SourceImportObserver,
) {
  const begun = await beginBibliographyFileImport(input);
  let operation = begun.operation;
  while (
    operation?.state === "running" &&
    operation.items.some((item) => item.state === "pending")
  ) {
    operation = await advanceSourceImport(
      { root: input.root, operationId: operation.operationId },
      observer,
    );
  }
  return { operation, report: begun.report };
}
