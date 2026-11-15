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
  type SourceIdentifierResolution,
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
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  zoteroGroupIdOfLibrary,
  type ScientSourceOrigin,
  type ScientSourceRecord,
  type ScientSourceVerification,
  type ZoteroConnection,
  type ZoteroConnectionStatus,
  type ZoteroCollection,
  type ZoteroImportScope,
  zoteroGroupLibraryId,
} from "@scientfactory/scient-sources";
import {
  isScientLibraryLocation,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { readScientProjectPins } from "@scientfactory/scient-sources/project-pins";
import {
  bulkUpdateScientSources,
  changeScientSourceCollectionMembers,
  organizeScientSources,
  placeScientSourceCollections,
  readScientSourcesOrganization,
  type ScientSourceOutsideCollection,
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
  assessScientSourceIntake,
  readScientSourceIntakeAssessor,
  listScientSourceRecords,
  readScientSourceRecord,
  readSourceImportOperation,
  readSourceImportParts,
  endSourceImportRun,
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
  listZoteroGroups,
  localOnlyZoteroAccess,
  zoteroTransport,
  type ZoteroAccess,
} from "./ZoteroConnections.ts";
import {
  countZoteroScopeStandalone,
  getZoteroItemWith,
  listZoteroCollectionsWith,
  listZoteroLibraryWith,
  listZoteroScopeItemKeysWith,
  readZoteroAttachmentFiles,
  readZoteroItemMaterial,
  type ZoteroTransport,
} from "./ZoteroLibraryReader.ts";
import {
  addNotBrought,
  ZOTERO_PDFS_PER_ITEM,
  zoteroDescendantCollectionKeys,
} from "./ZoteroItems.ts";
import { resolveJournalIcon } from "./JournalIconResolver.ts";
import { renameCitationKeyInProject, scanCitationKeyRenameDocuments } from "./LibraryCitation.ts";
import {
  syncManagedBibliography,
  syncPinnedBibliography,
  type ManagedBibliographyFileName,
} from "./ManagedBibliography.ts";
import {
  libraryImportPinInstance,
  pinLibraryImport,
  syncLibraryImportBibliography,
} from "./LibraryImportPins.ts";
import { canonicalScientSourceLocation, scientSourceStoreKey } from "./SourcesBackend.ts";
import {
  beginBibliographyFileImport,
  discardBibliographyFileImport,
  fileImportVerification,
  getBibliographyFileImportMaterial,
  readBibliographyFile,
  resolveProjectBibliographyFile,
} from "./BibliographyFileAdapter.ts";
import { bringZoteroAnnotations } from "./ZoteroAnnotations.ts";
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

/** With `groups`, a ready status lists the group libraries too; a failed listing lists none. */
export async function inspectZoteroConnection(input: {
  readonly connection?: ZoteroConnection;
  readonly zotero?: ZoteroAccess;
  readonly groups?: boolean;
}): Promise<ZoteroConnectionStatus> {
  const zotero = input.zotero ?? localOnlyZoteroAccess;
  const status = await inspectZotero(zotero, input.connection);
  if (!input.groups || status.state !== "ready") return status;
  const groups = await listZoteroGroups(zotero, status.connection ?? "local").catch(() => []);
  return { ...status, groups: [...groups] };
}

export async function listZoteroCollections(input: {
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly zotero?: ZoteroAccess;
}) {
  return listZoteroCollectionsWith(
    await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection, input.groupId),
  );
}

export async function listZoteroLibrary(input: {
  readonly scope: ZoteroImportScope;
  readonly query: string;
  readonly start: number;
  readonly limit: number;
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly zotero?: ZoteroAccess;
}) {
  return listZoteroLibraryWith(
    await zoteroTransport(input.zotero ?? localOnlyZoteroAccess, input.connection, input.groupId),
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

export function normalizeSourceRecordForRead(record: ScientSourceRecord): ScientSourceRecord {
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
export async function updateScientSource(
  input: Parameters<typeof updateScientSourceMetadata>[0] & { readonly root: string },
) {
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
  | (Awaited<ReturnType<typeof importScientSource>> & {
      /** The source as the import judged it: the caller's, with any registry facts applied. */
      readonly judged: ScientSourceCandidate;
    })
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
    readonly root: ScientSourceStoreLocation;
    readonly candidate: ScientSourceCandidate;
    readonly allowPossibleMetadataMatch?: boolean;
    readonly enrich?: boolean;
    readonly pdfPath?: string;
    readonly pdfFileName?: string;
    readonly expectedPdf?: { readonly sha256: string; readonly byteLength: number };
    readonly resolveIdentifier?: ResolveSourceIdentifier;
    /** A bare-identifier lookup already made before any local-copy preference. */
    readonly identifierResolution?: SourceIdentifierResolution;
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
      const preliminary = input.identifierResolution
        ? null
        : await assessScientSourceIntake({
            root: input.root,
            candidate: input.candidate,
            ...(input.expectedPdf ? { pdfSha256: input.expectedPdf.sha256 } : {}),
          });
      // A source the identity rule reuses is reported as before, without asking a registry.
      const exactDuplicate =
        preliminary !== null &&
        preliminary.kind !== "new" &&
        preliminary.kind !== "possible-metadata-match";
      const resolution =
        input.identifierResolution ??
        (exactDuplicate
          ? null
          : await (input.resolveIdentifier ?? resolveSourceIdentifier)(
              input.candidate.identifiers,
            ));
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
      return { ...imported, judged: candidateWithPdfName };
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
  readonly root: ScientSourceStoreLocation;
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
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly candidate: ScientSourceCandidate;
  readonly actor?: ScientSourceActor;
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
    ...(input.actor ? { actor: input.actor } : {}),
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
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly resolveIdentifier?: ResolveSourceIdentifier;
}) {
  return (await refreshAndCheckSourceMetadata({ ...input, actor: "user" })).refresh;
}

/**
 * Refreshes one source's metadata from its DOI or PMID registry, or from its PDF, then checks its
 * identifier again. `registry` is the check's outcome, or null when the check did not run.
 */
export async function refreshAndCheckSourceMetadata(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly actor: ScientSourceActor;
  readonly resolveIdentifier?: ResolveSourceIdentifier;
}) {
  const unchecked = <A>(refresh: A) => ({ refresh, registry: null });
  const root = isScientLibraryLocation(input.root)
    ? await canonicalScientSourceLocation(input.root)
    : await canonicalizeScientSourceRoot(input.root);
  const record = await readScientSourceRecord(root, input.sourceId);
  if (!record) throw new Error("The source was not found in this project.");
  if (record.revision !== input.expectedRevision) {
    return unchecked({
      outcome: "stale" as const,
      record,
      changedFields: [],
      message: "This source changed after you opened it.",
    });
  }

  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
  const hasResolvableIdentifier = record.identifiers.some((identifier) =>
    ["doi", "pmid"].includes(identifier.scheme.trim().toLowerCase()),
  );
  if (!pdf && !hasResolvableIdentifier) {
    return unchecked({
      outcome: "unavailable" as const,
      record,
      changedFields: [],
      message:
        materialSelection._tag === "SeveralMaterials"
          ? "This source has several PDFs. Metadata refresh needs an explicit material choice."
          : "Add a PDF, DOI, or PMID before refreshing this source's metadata.",
    });
  }

  const candidate = await refreshExistingSourceCandidate({
    record,
    pdfMaterial: pdf,
    pdfPath: pdf ? sourceAttachmentAbsolutePath(root, pdf) : null,
  });
  const latest = await readScientSourceRecord(root, input.sourceId);
  if (!latest) throw new Error("The source was removed while its metadata was being checked.");
  if (latest.revision !== input.expectedRevision) {
    return unchecked({
      outcome: "stale" as const,
      record: latest,
      changedFields: [],
      message: "This source changed while its metadata was being checked.",
    });
  }
  const refreshed = await applyRefreshedSourceMetadata({
    root,
    record: latest,
    candidate,
    actor: input.actor,
  });
  if (refreshed.outcome !== "refreshed" && refreshed.outcome !== "unchanged") {
    return unchecked(refreshed);
  }
  // Study design and topics are looked up again too, off this request.
  await forgetSourceCategories(root, input.sourceId).catch(() => undefined);
  void scheduleSourceCategorization(root);
  // A refresh also re-checks the identifier, so retractions and verification stay current.
  const checked = await checkSourceIdentifier({
    root,
    sourceId: input.sourceId,
    actor: input.actor,
    ...(input.resolveIdentifier ? { resolveIdentifier: input.resolveIdentifier } : {}),
  }).catch(() => null);
  const registry = checked?.registry ?? null;
  if (checked?.outcome !== "updated") return { refresh: refreshed, registry };
  return {
    refresh: {
      ...refreshed,
      outcome: "refreshed" as const,
      record: checked.record,
      message:
        refreshed.outcome === "refreshed"
          ? refreshed.message
          : "The identifier was checked again with its registry.",
    },
    registry,
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

/**
 * Preflight judges as the final import does: the shared rule with the store's identity and current
 * Library decisions (`assess`), so an undone or held-back pair is never shown as already imported.
 */
export async function assessSourcePreflightDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly assess: (
    candidate: ScientSourceCandidate,
    pdfSha256?: string,
  ) => ScientSourceDuplicateAssessment;
  readonly pdfPath: string | null;
}): Promise<ScientSourceDuplicateAssessment> {
  const preliminary = input.assess(input.candidate);
  if (
    !input.pdfPath ||
    (preliminary.kind !== "new" && preliminary.kind !== "possible-metadata-match")
  ) {
    return preliminary;
  }
  const pdf = await inspectScientSourcePdf(input.pdfPath);
  return input.assess(input.candidate, pdf.sha256);
}

/** A group item's source ID and link must differ from a My Library item with the same key. */
function zoteroImportCandidate(
  candidate: ScientSourceCandidate,
  groupId: string | undefined,
  itemKey: string,
): ScientSourceCandidate {
  return groupId
    ? {
        ...candidate,
        sourceKey: `zotero-group-${groupId}-${itemKey}`,
        externalReferences: candidate.externalReferences.map((reference) =>
          reference.system === "zotero"
            ? { ...reference, libraryId: zoteroGroupLibraryId(groupId) }
            : reference,
        ),
      }
    : candidate;
}

export async function preflightZoteroImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly itemKeys: ReadonlyArray<string>;
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly zotero?: ZoteroAccess;
  /** The records to compare with, when the store cannot be read yet (a library not created). */
  readonly existing?: ReadonlyArray<ScientSourceRecord>;
}) {
  const intake = input.existing
    ? {
        existing: input.existing,
        assess: (candidate: ScientSourceCandidate, pdfSha256?: string) =>
          assessSourceDuplicate({
            candidate,
            existing: input.existing ?? [],
            ...(pdfSha256 ? { pdfSha256 } : {}),
          }),
      }
    : await readScientSourceIntakeAssessor(input.root);
  const records = intake.existing;
  const transport = await zoteroTransport(
    input.zotero ?? localOnlyZoteroAccess,
    input.connection,
    input.groupId,
  );
  // Only local PDFs are cheap enough to hash for a duplicate check before import.
  const hasImportedPdf =
    transport.connection === "local" &&
    records.some((record) => record.attachments.some((attachment) => attachment.kind === "pdf"));
  const items = [];
  for (const itemKey of new Set(input.itemKeys)) {
    const material = hasImportedPdf ? await zoteroImportMaterial(transport, itemKey) : null;
    const candidate = material?.candidate ?? (await getZoteroItemWith(transport, itemKey));
    const duplicate = await assessSourcePreflightDuplicate({
      candidate: zoteroImportCandidate(candidate, input.groupId, itemKey),
      assess: intake.assess,
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

/** A library import started from a project pins into its checkout; a project import never pins. */
async function importPinInstance(
  root: ScientSourceStoreLocation,
  pinInto: string | undefined,
): Promise<{ readonly pinInstanceId?: string }> {
  return pinInto && isScientLibraryLocation(root)
    ? { pinInstanceId: await libraryImportPinInstance(root, pinInto) }
    : {};
}

export async function beginZoteroImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly actor?: "user" | "agent";
  /** Library stores: the project the imported sources are pinned in. */
  readonly pinInto?: string;
}) {
  return createSourceImportOperation({
    root: input.root,
    operationId: input.operationId,
    itemKeys: input.itemKeys,
    possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
    adapter: zoteroAdapter(input.connection),
    ...(input.groupId ? { zoteroGroupId: input.groupId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(await importPinInstance(input.root, input.pinInto)),
  });
}

export async function beginZoteroScopedImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly actor?: "user" | "agent";
  readonly zotero?: ZoteroAccess;
  /** Library stores: the project the imported sources are pinned in. */
  readonly pinInto?: string;
  /** Tests only: a smaller part than an operation's limit. */
  readonly partSize?: number;
}) {
  const { zotero, partSize } = input;
  const parts = await readSourceImportParts(input.root, input.operationId);
  const [begun] = parts;
  if (
    begun &&
    (begun.adapter !== zoteroAdapter(input.connection) || begun.zoteroGroupId !== input.groupId)
  ) {
    throw new Error("This operation ID already belongs to another import adapter.");
  }
  // Asked again for the same thing (an answer was lost): what it began, as it is now.
  const latest = parts.at(-1);
  if (latest) return latest;
  return beginZoteroRunPart({
    root: input.root,
    runId: input.operationId,
    parts,
    scope: input.scope,
    ...(input.connection ? { connection: input.connection } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    pin: await importPinInstance(input.root, input.pinInto),
    ...(zotero ? { zotero } : {}),
    ...(partSize ? { partSize } : {}),
  });
}

/**
 * Begins the next part of a large Zotero import. What it brings, from which Zotero library
 * and for which project is on the run's record, so nothing of that is asked again.
 * `retryFailed` takes again, with what remains, the references earlier parts failed on.
 */
export async function continueZoteroImportRun(input: {
  readonly root: ScientSourceStoreLocation;
  readonly runId: string;
  readonly retryFailed?: boolean;
  readonly zotero?: ZoteroAccess;
  readonly partSize?: number;
}) {
  const parts = await readSourceImportParts(input.root, input.runId);
  const [begun] = parts;
  const latest = parts.at(-1);
  if (!begun?.run || !latest) {
    throw new Error("That import is not on record here any more. Import the collection again.");
  }
  // A part is still under way (or the answer to this was lost): that part.
  if (latest.state === "running") return latest;
  return beginZoteroRunPart({
    root: input.root,
    runId: input.runId,
    parts,
    scope: begun.run.scope,
    ...(begun.adapter === "zotero-web" ? { connection: "web" as const } : {}),
    ...(begun.zoteroGroupId ? { groupId: begun.zoteroGroupId } : {}),
    actor: begun.actor,
    pin: begun.pinInstanceId ? { pinInstanceId: begun.pinInstanceId } : {},
    retryFailed: input.retryFailed === true,
    ...(input.zotero ? { zotero: input.zotero } : {}),
    ...(input.partSize ? { partSize: input.partSize } : {}),
  });
}

/** One part of a scoped Zotero import: the whole scope when it fits, or what is still to come. */
async function beginZoteroRunPart(input: {
  readonly root: ScientSourceStoreLocation;
  readonly runId: string;
  readonly parts: ReadonlyArray<ScientSourceImportOperation>;
  readonly scope: ZoteroImportScope;
  readonly connection?: ZoteroConnection;
  readonly groupId?: string;
  readonly actor?: "user" | "agent";
  readonly pin: { readonly pinInstanceId?: string };
  readonly retryFailed?: boolean;
  readonly zotero?: ZoteroAccess;
  readonly partSize?: number;
}) {
  const { parts, runId } = input;
  const partSize = input.partSize ?? SCIENT_SOURCE_IMPORT_ITEM_LIMIT;
  const transport = await zoteroTransport(
    input.zotero ?? localOnlyZoteroAccess,
    input.connection,
    input.groupId,
  );
  const inScope = await listZoteroScopeItemKeysWith(transport, input.scope);
  const large = inScope.length > partSize || parts.length > 0;
  // A large scope comes in parts: each takes what has no source here yet and no earlier part
  // of the run has handled (imported, skipped as a possible duplicate, or failed).
  const here = large ? await zoteroItemKeysHere(input.root, input.groupId) : new Set<string>();
  // An item a stopped part never reached is not handled: a later part takes it. So is one
  // that failed, when asked to try those again; what a part did last is what counts.
  const last = new Map(
    parts.flatMap((part) => part.items.map((item) => [item.itemKey, item.state] as const)),
  );
  const handled = new Set(
    [...last].flatMap(([itemKey, state]) =>
      state === "pending" || (state === "failed" && input.retryFailed) ? [] : [itemKey],
    ),
  );
  const rest = inScope.filter((key) => !here.has(key) && !handled.has(key));
  if (large && rest.length === 0) {
    // What remained left the scope in Zotero meanwhile: the run is over, and that is no error.
    const latest = parts.at(-1);
    if (latest) return endSourceImportRun(input.root, latest.operationId);
    throw new Error(
      `Every reference in this Zotero ${input.scope.kind === "library" ? "library" : "collection"} is already in your Library.`,
    );
  }
  const itemKeys = rest.slice(0, partSize);
  // Said once, with the first part.
  const alone =
    parts.length === 0
      ? await countZoteroScopeStandalone(transport, input.scope)
      : { notes: 0, files: 0 };
  // The tree is made once, with the first part; later parts find it.
  const unmade =
    parts.length === 0
      ? await makeZoteroScopeCollections({
          root: input.root,
          transport,
          scope: input.scope,
          groupId: input.groupId,
          actor: input.actor ?? "user",
        })
      : 0;
  return createSourceImportOperation({
    root: input.root,
    operationId: parts.length === 0 ? runId : `${runId}-${parts.length + 1}`,
    adapter: zoteroAdapter(input.connection),
    itemKeys,
    ...(large
      ? {
          run: {
            runId,
            part: parts.length + 1,
            remaining: rest.length - itemKeys.length,
            scope: input.scope,
          },
        }
      : {}),
    notBrought: [
      ...(alone === null
        ? [{ kind: "alone-uncounted" as const, count: 1 }]
        : [
            ...(alone.notes > 0 ? [{ kind: "notes-alone" as const, count: alone.notes }] : []),
            ...(alone.files > 0 ? [{ kind: "files-alone" as const, count: alone.files }] : []),
          ]),
      ...(unmade === null
        ? [{ kind: "collection" as const, name: "unread", count: 1 }]
        : unmade > 0
          ? [{ kind: "collection" as const, name: "unmade", count: unmade }]
          : []),
    ],
    ...(input.groupId ? { zoteroGroupId: input.groupId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...input.pin,
  });
}

/** The Zotero items of one library (My Library, or a group) that already have a source here. */
async function zoteroItemKeysHere(
  root: ScientSourceStoreLocation,
  groupId: string | undefined,
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();
  for (const record of await listScientSourceRecords(root)) {
    for (const reference of record.externalReferences) {
      if (
        reference.system === "zotero" &&
        zoteroGroupIdOfLibrary(reference.libraryId) === (groupId ?? null)
      ) {
        keys.add(reference.itemKey);
      }
    }
  }
  return keys;
}

export async function uploadLocalPdfSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourcePath: string;
  readonly fileName: string;
}) {
  return { item: await prepareLocalPdfSource(input) };
}

export async function beginLocalPdfImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
  /** Library stores: the project the imported sources are pinned in. */
  readonly pinInto?: string;
}) {
  for (const sourceKey of new Set(input.itemKeys)) {
    await getLocalPdfImportMaterial(input.root, sourceKey);
  }
  const { pinInto, ...operation } = input;
  return createSourceImportOperation({
    ...operation,
    adapter: "local-files",
    ...(await importPinInstance(input.root, pinInto)),
  });
}

export async function discardLocalPdfSources(input: {
  readonly root: ScientSourceStoreLocation;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const keys = [...new Set(input.itemKeys)];
  await Promise.all(keys.map((sourceKey) => discardLocalPdfImportMaterial(input.root, sourceKey)));
  return { discarded: keys.length };
}

/** A Zotero collection's ID here: the same on every import, so it is found again, not doubled. */
function zoteroCollectionId(groupId: string | undefined, collectionKey: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(`zotero\0${groupId ?? ""}\0${collectionKey}`)
    .digest("hex");
  return `collection_${digest.slice(0, 32)}`;
}

/** Zotero's collections as the Library places them: each under the ID it has here. */
function zoteroCollectionTree(
  collections: ReadonlyArray<ZoteroCollection>,
  groupId: string | undefined,
): ReadonlyArray<ScientSourceOutsideCollection> {
  return collections.map((collection) => ({
    collectionId: zoteroCollectionId(groupId, collection.key),
    name: collection.name,
    ...(collection.parentCollectionKey
      ? { parentCollectionId: zoteroCollectionId(groupId, collection.parentCollectionKey) }
      : {}),
  }));
}

/**
 * Makes the scope's collections here as Zotero nests them, empty ones too, except those the
 * person deleted here. Returns how many could not be made (a limit of the Library), or null
 * when Zotero did not list its collections. Neither fails the import: both are said.
 */
async function makeZoteroScopeCollections(input: {
  readonly root: ScientSourceStoreLocation;
  readonly transport: ZoteroTransport;
  readonly scope: ZoteroImportScope;
  readonly groupId: string | undefined;
  readonly actor: "user" | "agent";
}): Promise<number | null> {
  const listed = await listZoteroCollectionsWith(input.transport).catch(() => null);
  if (!listed) return null;
  const { collections } = listed;
  const { scope } = input;
  const keys =
    scope.kind === "library"
      ? collections.map((collection) => collection.key)
      : scope.includeSubcollections
        ? zoteroDescendantCollectionKeys(scope.collectionKey, collections)
        : [scope.collectionKey];
  return placeScientSourceCollections({
    root: input.root,
    tree: zoteroCollectionTree(collections, input.groupId),
    wanted: keys.map((key) => zoteroCollectionId(input.groupId, key)),
    remake: false,
    actor: input.actor,
  }).then(
    (placed) => [...placed.values()].filter((entry) => entry.collection === null).length,
    () => keys.length,
  );
}

const zoteroCollectionTrees = new Map<
  string,
  Promise<ReadonlyArray<ScientSourceOutsideCollection>>
>();

/**
 * An imported item joins the Library collection of each Zotero collection it is in; one the
 * person deleted here is made again for it. A collection problem never fails the import: the
 * source is in the Library either way. Returns how many collections it could not be put in.
 */
async function addToZoteroCollections(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operation: ScientSourceImportOperation;
  readonly transport: ZoteroTransport;
  readonly sourceId: string;
  readonly collectionKeys: ReadonlyArray<string>;
}): Promise<number> {
  if (input.collectionKeys.length === 0) return 0;
  const groupId = input.operation.zoteroGroupId;
  const cacheKey = `${scientSourceStoreKey(input.root)}\0${input.operation.operationId}`;
  let tree = zoteroCollectionTrees.get(cacheKey);
  if (!tree) {
    tree = listZoteroCollectionsWith(input.transport).then((result) =>
      zoteroCollectionTree(result.collections, groupId),
    );
    if (zoteroCollectionTrees.size >= 8) zoteroCollectionTrees.clear();
    zoteroCollectionTrees.set(cacheKey, tree);
    // A listing that failed is asked again for the next item.
    tree.catch(() => zoteroCollectionTrees.delete(cacheKey));
  }
  const wanted = input.collectionKeys.map((key) => zoteroCollectionId(groupId, key));
  let filed = 0;
  try {
    const placed = await placeScientSourceCollections({
      root: input.root,
      tree: await tree,
      wanted,
      remake: true,
      actor: input.operation.actor,
    });
    for (const collectionId of wanted) {
      const collection = placed.get(collectionId)?.collection;
      if (!collection) continue;
      const change = await changeScientSourceCollectionMembers({
        root: input.root,
        collectionId: collection.collectionId,
        add: [input.sourceId],
        actor: input.operation.actor,
      });
      if (change.collection?.sourceIds.includes(input.sourceId)) filed += 1;
    }
  } catch {
    // Counted below with the rest that could not be filed.
  }
  return wanted.length - filed;
}

/** A reference-file entry, with the PDFs its file names attached like any other PDF. */
async function importFileOperationItem(input: {
  readonly root: ScientSourceStoreLocation;
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

/**
 * A Zotero item skipped because its reference is certainly here already, under another
 * origin, still gives its notes when the source here has no note. Anything more would be a
 * merge (whose note, whose PDF), which is the person's to decide.
 */
async function addNoteToSourceAlreadyHere(input: {
  readonly root: ScientSourceStoreLocation;
  readonly duplicate: ScientSourceDuplicateAssessment;
  readonly note: string | null;
  readonly actor: ScientSourceActor;
}): Promise<boolean> {
  const { kind, matchingSourceIds } = input.duplicate;
  const sourceId = matchingSourceIds[0];
  if (!input.note || !sourceId || matchingSourceIds.length !== 1) return false;
  if (kind !== "same-identifier" && kind !== "same-pdf") return false;
  const record = await readScientSourceRecord(input.root, sourceId);
  if (!record || record.note?.trim()) return false;
  const updated = await updateScientSourceNote({
    root: input.root,
    sourceId,
    expectedRevision: record.revision,
    note: input.note,
    actor: input.actor,
  });
  return updated.outcome === "updated";
}

async function importZoteroOperationItem(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operation: ScientSourceImportOperation;
  readonly itemKey: string;
  readonly allowPossibleMetadataMatch: boolean;
  readonly zotero: ZoteroAccess;
}) {
  const groupId = input.operation.zoteroGroupId;
  const transport = await zoteroTransport(
    input.zotero,
    input.operation.adapter === "zotero-web" ? "web" : "local",
    groupId,
  );
  const imported = await zoteroImportMaterial(transport, input.itemKey);
  const { material, files } = imported;
  const candidate = zoteroImportCandidate(imported.candidate, groupId, input.itemKey);
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
      // Which PDF here each Zotero file with highlights is, before its copy goes.
      const highlighted = new Set(material.annotations.map((entry) => entry.attachmentKey));
      const pdfs = new Map(
        await Promise.all(
          files
            .filter((file) => highlighted.has(file.attachmentKey))
            .map(
              async (file) =>
                [file.attachmentKey, (await inspectScientSourcePdf(file.path)).sha256] as const,
            ),
        ),
      );
      await recordZoteroSync({
        root: input.root,
        record,
        material,
        attachmentKeys: files.map((file) => file.attachmentKey),
        pdfs: Object.fromEntries(pdfs),
      });
      const unfiled = await addToZoteroCollections({
        root: input.root,
        operation: input.operation,
        transport,
        sourceId: record.sourceId,
        collectionKeys: material.collectionKeys,
      });
      // Those on a PDF past the tenth or on another file are in `material.notBrought` already.
      const copied = new Set(material.pdfs.slice(0, ZOTERO_PDFS_PER_ITEM).map((pdf) => pdf.key));
      const onCopied = material.annotations.filter((annotation) =>
        copied.has(annotation.attachmentKey),
      );
      const highlights = await bringZoteroAnnotations({
        root: input.root,
        record,
        annotations: onCopied,
        pdfs,
        now: new Date().toISOString(),
      }).catch(() => null);
      // A PDF Zotero has and could not hand over (a linked file read over the web, a file
      // that is gone) is said with the rest of what did not come, and so are its highlights.
      const unavailable = Math.min(material.pdfs.length, ZOTERO_PDFS_PER_ITEM) - files.length;
      const notBrought = [...material.notBrought];
      addNotBrought(notBrought, "pdf", unavailable, "unavailable");
      addNotBrought(notBrought, "collection", unfiled, "unfiled");
      addNotBrought(notBrought, "highlights", highlights?.unplaced ?? 0, "unplaced");
      addNotBrought(notBrought, "highlights", highlights?.elsewhere ?? 0, "no-file");
      addNotBrought(notBrought, "highlights", highlights ? 0 : onCopied.length, "later");
      return { ...result, record, notBrought };
    }
    // The import's "already here" line says such a reference may have taken Zotero's note.
    await addNoteToSourceAlreadyHere({
      root: input.root,
      duplicate: result.duplicate,
      note: material.note,
      actor: input.operation.actor,
    });
    return { ...result, record };
  } finally {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
  }
}

/**
 * What a library import pins: the record it brought in, or the record an exact duplicate is. A
 * possible metadata match may be another work, so it is not pinned.
 */
function importedOrSameWork(result: {
  readonly record: ScientSourceRecord | null;
  readonly duplicate: ScientSourceDuplicateAssessment;
}): string | null {
  if (result.record) return result.record.sourceId;
  return result.duplicate.kind === "possible-metadata-match"
    ? null
    : (result.duplicate.matchingSourceIds[0] ?? null);
}

/** A settled library import that pins builds its project's managed files once. */
async function settleLibraryImport(
  root: ScientSourceStoreLocation,
  operation: ScientSourceImportOperation,
): Promise<void> {
  if (operation.state === "running" || !operation.pinInstanceId) return;
  if (!isScientLibraryLocation(root)) return;
  // The import has landed; managed files that fail here are rewritten by the next write.
  await syncLibraryImportBibliography({
    library: root,
    instanceId: operation.pinInstanceId,
    actor: operation.actor,
  }).catch(() => undefined);
}

export async function advanceSourceImport(
  input: {
    readonly root: ScientSourceStoreLocation;
    readonly operationId: string;
    readonly zotero?: ZoteroAccess;
  },
  observer?: SourceImportObserver,
) {
  const root = await canonicalScientSourceLocation(input.root);
  return withOperationLane(`${scientSourceStoreKey(root)}\0${input.operationId}`, async () => {
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
      // Pinned before the item is recorded, so a crash in between pins it when the item runs again.
      const pinned = importedOrSameWork(result);
      if (operation.pinInstanceId && isScientLibraryLocation(root) && pinned) {
        await pinLibraryImport({
          library: root,
          instanceId: operation.pinInstanceId,
          sourceIds: [pinned],
          actor: operation.actor,
        });
      }
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: result.outcome === "imported" ? "imported" : "skipped",
        duplicateKind: result.duplicate.kind,
        ...(result.record ? { sourceId: result.record.sourceId } : {}),
        message: result.duplicate.reason,
        ...("notBrought" in result && Array.isArray(result.notBrought)
          ? { notBrought: result.notBrought }
          : {}),
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
      await settleLibraryImport(root, updated);
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
      await settleLibraryImport(root, updated);
      return updated;
    }
  });
}

export async function cancelSourceImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
}) {
  const root = await canonicalScientSourceLocation(input.root);
  return withOperationLane(`${scientSourceStoreKey(root)}\0${input.operationId}`, async () => {
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
    // What was pinned before the cancel stays pinned, as imported records stay imported.
    await settleLibraryImport(root, cancelled);
    return cancelled;
  });
}

export async function retrySourceImport(input: {
  readonly root: ScientSourceStoreLocation;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const root = await canonicalScientSourceLocation(input.root);
  return retryFailedSourceImportOperationItems(root, input.operationId, input.itemKeys);
}

/**
 * Offers hand edits to the managed bibliography back to the Library (with a library, pinned
 * here). A file whose only edits were new entries, all now in the Library under their keys, is
 * written again; one with changed or removed entries stays as the person left it.
 */
export async function syncManagedBibliographyWithImports(
  input: {
    readonly root: string;
    readonly library?: ScientLibraryLocation;
    readonly replaceEdited?: ReadonlyArray<ManagedBibliographyFileName>;
    readonly importEdited?: ReadonlyArray<ManagedBibliographyFileName>;
    readonly actor: ScientSourceActor;
  },
  observer?: SourceImportObserver,
) {
  const { library } = input;
  const sync = (replaceEdited?: ReadonlyArray<ManagedBibliographyFileName>) =>
    library
      ? syncPinnedBibliography({
          root: input.root,
          library,
          access: "write",
          actor: input.actor,
          ...(replaceEdited ? { replaceEdited } : {}),
        })
      : syncManagedBibliography(input.root, replaceEdited ? { replaceEdited } : {});
  const importEdited = input.importEdited ?? [];
  if (importEdited.length === 0) return sync(input.replaceEdited);
  const before = await sync();
  let imported = 0;
  for (const name of importEdited) {
    if (before.files.find((file) => file.name === name)?.state !== "edited") continue;
    const file = await resolveProjectBibliographyFile(input.root, name);
    const result = await importBibliographyFile(
      {
        root: library ?? input.root,
        ...(library ? { projectRoot: input.root, pinInto: input.root } : {}),
        operationId: `bibliography_${NodeCrypto.randomUUID()}`,
        fileName: file.fileName,
        text: await readBibliographyFile(file.absolutePath),
        actor: input.actor,
      },
      observer,
    );
    imported += result.operation?.items.filter((item) => item.state === "imported").length ?? 0;
  }
  // Keys the files are written under: this project's pins with a library, else the records'.
  const keys = new Set(
    library
      ? (await readScientProjectPins(input.root)).map((pin) => pin.citationKey)
      : (await listScientSourceRecords(input.root)).flatMap((record) =>
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
  const status = await sync([...(input.replaceEdited ?? []), ...fullyImported]);
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
