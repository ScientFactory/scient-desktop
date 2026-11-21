// @effect-diagnostics nodeBuiltinImport:off -- The list revision is a digest of its parts.
import * as NodeCrypto from "node:crypto";

import {
  citationKeyValidationMessage,
  scientLibraryIdentityProblem,
  type ScientLibraryIdentityFields,
  scientSourceReadingState,
  scientSourceSummaryFromRecord,
  sourceMetadataDiagnostics,
  takenCitationKeys,
  type ScientSourceActor,
  type ScientSourceEditableMetadata,
  type ScientSourceReadingStatus,
  type ScientSourceRecord,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesOrganizeAction,
  type ScientSystematicReviewAction,
  type ScientLibraryRecentChanges,
} from "@scientfactory/scient-sources";
import {
  readScientSourceCategories,
  scientSourceCategorySummaryFor,
} from "@scientfactory/scient-sources/categories-store";
import {
  readScientSourcesOrganization,
  scientBulkEditChangedType,
} from "@scientfactory/scient-sources/collections";
import {
  clearScientLibrarySourcesDistinct,
  markScientLibrarySourcesDistinct,
  mergeScientLibrarySources,
  readScientLibraryDuplicates,
  readScientLibraryMergeReceipt,
  type ScientLibraryMerge,
  undoScientLibraryMerge,
} from "@scientfactory/scient-sources/library-merge";
import {
  readScientLibraryJoinDifferences,
  takeFromScientLibraryJoin,
} from "@scientfactory/scient-sources/library-join";
import {
  listScientLibraryImportNotBrought,
  listScientLibraryImportSources,
  listScientLibraryRecentChanges,
} from "@scientfactory/scient-sources/library-changes";
import { dismissScientLibraryMoveSummary } from "@scientfactory/scient-sources/library-move";
import {
  dismissScientLibraryNoticeChanges,
  listScientLibraryNoticeChanges,
} from "@scientfactory/scient-sources/library-notice-watch";
import {
  dismissScientReviewCombineReport,
  readScientReviewCombineReport,
  readScientReviewVersions,
  resolveScientReviewConflict,
} from "@scientfactory/scient-sources/library-review-conflicts";
import {
  readScientLibraryAliases,
  resolveScientLibraryAlias,
} from "@scientfactory/scient-sources/library-aliases";
import { readScientDisplacedCopiesOf } from "@scientfactory/scient-sources/project-displaced-copies";
import {
  changeScientLibraryReview,
  listScientLibraryReviewIds,
  listScientLibraryReviewRecords,
  listScientLibraryReviews,
  readScientLibraryReview,
  readScientLibraryReviewRecord,
  readScientLibraryReviewTitles,
  ScientReviewWork,
  type ScientLibraryReviewRecord,
} from "@scientfactory/scient-sources/library-reviews";
import {
  keepScientProjectSourceSeparate,
  type ScientProjectSourceResolution,
} from "@scientfactory/scient-sources/library-instance-map";
import {
  linkScientProjectSourceKeepingCopies,
  unlinkScientProjectSourceRestoringCopies,
} from "@scientfactory/scient-sources/project-source-link";
import {
  changeScientProjectPins,
  listScientProjectPinnedWorks,
  resolveScientProjectPins,
  pinScientLibrarySource,
  readScientProjectPinNoteHistory,
  readScientProjectPins,
  renameScientProjectPinKey,
  ScientPinWork,
  setScientProjectPinNote,
  unpinScientLibrarySource,
  type ScientProjectPin,
} from "@scientfactory/scient-sources/project-pins";
import {
  deleteScientSourcesPermanently,
  inspectScientLibrarySources,
  listScientSourceRecords,
  listScientSourceRevisions,
  listScientSourceTrash,
  readScientSourceRecord,
  restoreScientSource,
  revertScientSource,
  sourceAttachmentAbsolutePath,
  updateScientSourceMetadata,
  updateScientSourceNote,
} from "@scientfactory/scient-sources/store";
import {
  SCIENT_SOURCES_DUPLICATE_PAIR_LIMIT,
  SCIENT_SOURCES_UNDOABLE_MERGE_LIMIT,
  type ScientSourcesDuplicatesResult,
  type ScientSourceLibraryMatch,
  type ScientSourcesLibraryOrganizeAction,
  type ScientSourcesPinRepairAction,
  type ScientSourcesScope,
  type ScientSystematicReviewConflictChange,
  type ScientSystematicReviewConflictsRequest,
  type ScientSystematicReviewRecord,
  type ScientSystematicReviewResult,
} from "@t3tools/contracts";

import { exportBibliography } from "./BibliographyFileAdapter.ts";
import { resolveJournalCover } from "./JournalCoverResolver.ts";
import { renameCitationKeyInProject, scanCitationKeyRenameDocuments } from "./LibraryCitation.ts";
import { moveProjectBackIntoProject, restoreProjectPreMoveArchive } from "./LibraryMove.ts";
import {
  exportLibraryProjectPackage,
  importLibraryProjectPackage,
  listLibraryProjectPackages,
  listLibraryProjectPackageImports,
  undoLibraryProjectPackageImport,
} from "./LibraryProjectPackage.ts";
import {
  alsoPinnedIn,
  distinctPinnedWorks,
  listProjectPinnedWorks,
  otherProjectsUsing,
  projectsCitingRemoved,
  projectPinGroupsByLibraryId,
  projectPinOfLibrarySource,
  projectPinsByLibraryId,
  refreshProjectAfterLibraryChange,
  resolveLibrarySourceId,
  resolveLibrarySourceIds,
  syncProjectBibliography,
  type KnownProject,
  type ProjectPinGroup,
} from "./LibraryProjectSources.ts";
import {
  bulkUpdateSources,
  normalizeSourceRecordForRead,
  organizeSources,
  refreshScientSourceMetadata,
  removeSource,
} from "./ScientSourcesCoordinator.ts";
import type { ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";
import { scheduleSourceCategorization } from "./SourceCategories.ts";
import { scheduleSourceFullTextIndexing } from "./SourceFullText.ts";
import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";
import { startLibraryBackup } from "./LibraryBackupRuns.ts";
import { runningLibraryJoins, startLibraryJoin, undoLibraryJoin } from "./LibraryJoinRuns.ts";

type Store = ScientSourcesLibraryStore;

const ACTOR: ScientSourceActor = "user";
const SNAPSHOT_LABEL = "From this review's snapshot" as const;

/**
 * Library routes serve any connected client, so a route record carries no personal note. Its
 * `note` is this project's note on its pin instead, which the panel edits; only the detail adds
 * the personal note, as `personalNote`, for a session that may change the library.
 */
function routeRecord(
  record: ScientSourceRecord,
  pin: Pick<ScientProjectPin, "citationKey" | "note"> | undefined,
): ScientSourceRecord {
  const { note: _personal, ...rest } = record;
  return {
    ...rest,
    ...(pin ? { citationKey: pin.citationKey } : {}),
    ...(pin?.note ? { note: pin.note } : {}),
  };
}

/** A library ID, or a project source ID of this project resolved to one; unresolved IDs stay. */
async function libraryIdOf(store: Store, sourceId: string): Promise<string> {
  return (await resolveLibrarySourceId(store, sourceId)) ?? sourceId;
}

async function pinOf(store: Store, sourceId: string): Promise<ScientProjectPin | undefined> {
  return (await projectPinsByLibraryId(store)).get(sourceId);
}

/**
 * A route record with this project's fields, so a client rebuilding its row or details from an
 * edit's answer keeps every key the project cites the source under.
 */
/**
 * A library record as this project sees it, under its first pinned key; with `citationKey`, the
 * project note is that pin's (one of `alsoCitedAs`), validated against this source's pins.
 */
async function projectRecordOf(store: Store, record: ScientSourceRecord, citationKey?: string) {
  const group = (await projectPinGroupsByLibraryId(store)).get(record.sourceId);
  const notePin =
    citationKey === undefined || citationKey === group?.pin.citationKey
      ? group?.pin
      : (await pinUnderKey(store, record.sourceId, citationKey)).pin;
  return {
    ...routeRecord(
      record,
      group
        ? { citationKey: group.pin.citationKey, ...(notePin?.note ? { note: notePin.note } : {}) }
        : undefined,
    ),
    pinned: group !== undefined,
    ...(notePin ? { projectNote: notePin.note ?? null } : {}),
    ...(group && group.alsoCitedAs.length > 0 ? { alsoCitedAs: group.alsoCitedAs } : {}),
  };
}

/** This project's pin of the library source under `citationKey`, or the reason it has none. */
async function pinUnderKey(store: Store, sourceId: string, citationKey: string) {
  const chosen = await projectPinOfLibrarySource(store, {
    sourceId,
    requestedId: sourceId,
    citationKey,
  });
  if (!chosen) throw new Error(`${citationKey} does not cite this source in this project.`);
  return chosen;
}

async function requireRecord(store: Store, sourceId: string): Promise<ScientSourceRecord> {
  const record = store.exists ? await readScientSourceRecord(store.library, sourceId) : null;
  if (!record) throw new Error("The source was not found in the Library.");
  return record;
}

// The change has landed; a snapshot that fails to refresh is refreshed by the next write.
const afterChange = (store: Store, sourceIds: ReadonlyArray<string>) =>
  refreshProjectAfterLibraryChange(store, sourceIds, ACTOR).catch(() => undefined);

const reach = (store: Store, sourceId: string) => alsoPinnedIn(store, sourceId).catch(() => ({}));

type Categories = Awaited<ReturnType<typeof readScientSourceCategories>>;
/** A library record as this project sees it: under its key here when it is pinned. */
const pinnedEntry = (
  record: ScientSourceRecord,
  group:
    | (Pick<ProjectPinGroup, "alsoCitedAs"> & {
        readonly pin: Pick<ProjectPinGroup["pin"], "citationKey" | "note">;
      })
    | undefined,
) => ({
  record: group ? { ...record, citationKey: group.pin.citationKey } : record,
  pinned: group !== undefined,
  projectNote: group ? (group.pin.note ?? null) : undefined,
  fromSnapshot: false,
  alsoCitedAs: group?.alsoCitedAs,
});

/** One row of the Library list. */
function overviewRow(
  entry: {
    readonly record: ScientSourceRecord;
    readonly pinned: boolean;
    readonly projectNote?: string | null | undefined;
    readonly fromSnapshot: boolean;
    readonly alsoCitedAs?: ReadonlyArray<string> | undefined;
  },
  categories: Categories,
) {
  const { record, pinned, projectNote, fromSnapshot, alsoCitedAs } = entry;
  const category = scientSourceCategorySummaryFor(record, categories);
  return {
    ...scientSourceSummaryFromRecord(record),
    ...(category ? { categories: category } : {}),
    ...scientSourceReadingState(record),
    pinned,
    ...(projectNote !== undefined ? { projectNote } : {}),
    ...(fromSnapshot ? { fromSnapshot: true as const } : {}),
    ...(alsoCitedAs && alsoCitedAs.length > 0 ? { alsoCitedAs } : {}),
  };
}

/** This project's pins, or the whole library, with the totals the scope filter shows. */
export async function libraryOverview(
  store: Store,
  input: {
    readonly scope: ScientSourcesScope;
    readonly background: boolean;
    readonly readingStatus?: ScientSourceReadingStatus;
    readonly starred?: boolean;
    /** The revision of the list the caller holds; when it still holds, no rows are sent. */
    readonly knownRevision?: string;
  },
) {
  const inspected = store.exists
    ? await inspectScientLibrarySources(store.library)
    : { records: [], activeOperation: null };
  const works = distinctPinnedWorks(await listProjectPinnedWorks(store, ACTOR));
  // The works already hold each pinned record under its key here: no second resolution.
  const pins = new Map(
    works.flatMap((work) =>
      work.from === "library"
        ? [
            [
              work.record.sourceId,
              {
                pin: {
                  citationKey: work.citationKey,
                  ...(work.projectNote === null ? {} : { note: work.projectNote }),
                },
                alsoCitedAs: work.alsoCitedAs,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const scoped =
    input.scope === "project"
      ? works.map((work) => ({
          record: work.record,
          pinned: true,
          projectNote: work.projectNote,
          fromSnapshot: work.from === "snapshot",
          alsoCitedAs: work.alsoCitedAs,
        }))
      : inspected.records.map((record) => pinnedEntry(record, pins.get(record.sourceId)));
  // A filter on reading state lists only library records; a snapshot has none.
  const listed = scoped.filter(({ record }) => {
    if (input.readingStatus === undefined && input.starred === undefined) return true;
    const state = scientSourceReadingState(record);
    return (
      state !== null &&
      (input.readingStatus === undefined || state.readingStatus === input.readingStatus) &&
      (input.starred === undefined || state.starred === input.starred)
    );
  });
  const categories = store.exists
    ? await readScientSourceCategories(store.library).catch(() => ({}))
    : {};
  const held = new Set(inspected.records.map((record) => record.sourceId));
  const organization = store.exists
    ? await readScientSourcesOrganization(store.library, held)
    : null;
  const noticeChanges = store.exists
    ? (await listScientLibraryNoticeChanges(store.library)).filter((change) =>
        held.has(change.sourceId),
      )
    : [];
  // Indexing and categorizing write library caches, so only a caller that may change it starts them.
  if (input.background && store.exists) {
    void scheduleSourceFullTextIndexing(store.library);
    void scheduleSourceCategorization(store.library);
  }
  const scopes = {
    listed: input.scope,
    project: works.length,
    library: inspected.records.length,
  };
  const revision =
    "recordsRevision" in inspected && inspected.recordsRevision
      ? overviewRevision({
          input,
          recordsRevision: inspected.recordsRevision,
          listed,
          categories,
          organization,
          noticeChanges,
          scopes,
          unreadable: "unreadableRecords" in inspected ? inspected.unreadableRecords : undefined,
          trashedCount: "trashedCount" in inspected ? inspected.trashedCount : undefined,
        })
      : undefined;
  const status = {
    projectState: "initialized" as const,
    issues: [],
    activeOperation: inspected.activeOperation,
    ...("unreadableRecords" in inspected && inspected.unreadableRecords
      ? { unreadableRecords: inspected.unreadableRecords }
      : {}),
    ...("trashedCount" in inspected && inspected.trashedCount !== undefined
      ? { trashedCount: inspected.trashedCount }
      : {}),
    ...(revision ? { revision } : {}),
  };
  // The caller already holds this answer: only the status and counts are sent.
  const unchanged = revision !== undefined && revision === input.knownRevision;
  return {
    ...status,
    ...(unchanged ? { unchanged: true as const } : {}),
    records: unchanged ? [] : listed.map((entry) => overviewRow(entry, categories)),
    // Only the sources that have one: the list looks each source up and takes a missing entry
    // as none, and at 20,000 sources the empty entries were 1.6 MB of the answer.
    recordDiagnostics: unchanged
      ? []
      : listed.flatMap(({ record }) => {
          const diagnostics = sourceMetadataDiagnostics(record);
          return diagnostics.length > 0 ? [{ sourceId: record.sourceId, diagnostics }] : [];
        }),
    ...(organization && !unchanged ? { organization } : {}),
    scopes,
    ...(noticeChanges.length > 0 && !unchanged ? { noticeChanges } : {}),
  };
}

/** Raise when a row's shape or content changes, so a client never keeps rows built the old way. */
const OVERVIEW_ROWS_FORMAT = 1;

/**
 * What the listed rows, collections and notices are made of: the record files' stamps, each
 * listed entry's place in this project, the categories, collections and notices, and the filter.
 * Equal digests mean an equal answer apart from the operation status, which is always sent.
 */
function overviewRevision(parts: {
  readonly input: {
    readonly scope: ScientSourcesScope;
    readonly readingStatus?: ScientSourceReadingStatus;
    readonly starred?: boolean;
  };
  readonly recordsRevision: string;
  readonly listed: ReadonlyArray<{
    readonly record: ScientSourceRecord;
    readonly pinned: boolean;
    readonly projectNote?: string | null | undefined;
    readonly fromSnapshot: boolean;
    readonly alsoCitedAs?: ReadonlyArray<string> | undefined;
  }>;
  readonly categories: unknown;
  readonly organization: unknown;
  readonly noticeChanges: unknown;
  readonly scopes: unknown;
  readonly unreadable: unknown;
  readonly trashedCount: unknown;
}): string {
  const hash = NodeCrypto.createHash("sha256");
  const { scope, readingStatus, starred } = parts.input;
  hash.update(JSON.stringify([OVERVIEW_ROWS_FORMAT, scope, readingStatus, starred]));
  hash.update(parts.recordsRevision);
  for (const entry of parts.listed) {
    // A project's rows also take values from its pins (and snapshots are pins alone), so there
    // the whole record counts; an All Library row is its record file's, stamped above.
    hash.update(
      JSON.stringify([
        scope === "project" || entry.fromSnapshot ? entry.record : entry.record.sourceId,
        entry.record.citationKey,
        entry.pinned,
        entry.projectNote,
        entry.alsoCitedAs,
      ]),
    );
  }
  for (const part of [
    parts.categories,
    parts.organization,
    parts.noticeChanges,
    parts.scopes,
    parts.unreadable,
    parts.trashedCount,
  ]) {
    hash.update(`\0${JSON.stringify(part) ?? ""}`);
  }
  return hash.digest("base64url");
}

/** A work's fields two copies can differ in, in the order a Merged row lists them. */
const MERGE_DIFFERENCE_FIELDS = [
  "type",
  "customType",
  "title",
  "creators",
  "issuedRaw",
  "issuedYear",
  "abstract",
  "containerTitle",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
  "identifiers",
  "attachments",
] as const;

/** A merge file's value as a row shows it, authors by name; null if empty. */
function mergeValueText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(mergeValueText).filter((part) => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const entry: Record<string, unknown> = { ...value };
  return (
    mergeValueText(entry.literalName) ??
    mergeValueText([entry.givenName, entry.familyName].filter(Boolean).join(" "))
  );
}

/**
 * What the two copies had in each field they differed in: the kept one's value before the merge
 * and the other's, from the merge file. The file records identifiers and PDFs only as added, so
 * those fields are named without values.
 */
function mergeDifferences(merge: ScientLibraryMerge) {
  const values = new Map<string, { readonly kept: unknown; readonly other: unknown }>();
  for (const change of merge.changes) {
    values.set(change.field, { kept: change.before, other: change.after });
  }
  for (const conflict of merge.conflicts) values.set(conflict.field, conflict);
  const named = new Set([
    ...(merge.added.identifiers.length > 0 || values.has("identifiers") ? ["identifiers"] : []),
    ...(merge.added.attachmentSha256.length > 0 || values.has("attachments")
      ? ["attachments"]
      : []),
  ]);
  return MERGE_DIFFERENCE_FIELDS.flatMap((field) => {
    if (named.has(field)) return [{ field }];
    const value = values.get(field);
    return value
      ? [{ field, kept: mergeValueText(value.kept), other: mergeValueText(value.other) }]
      : [];
  });
}

/** A page of each list; the limits default to what the screen is sent. */
export interface LibraryDuplicatesPage {
  readonly pairOffset?: number;
  readonly mergeOffset?: number;
  readonly revision?: string;
  readonly pairLimit?: number;
  readonly mergeLimit?: number;
  readonly merges?: "undoable" | "all";
}

/**
 * A page of the whole library's possible duplicates and of its merges: those Undo can still
 * reverse, or every receipt. Reading never merges: the automatic merges run with the move.
 */
export async function libraryDuplicates(
  store: Store,
  /** The projects the server knows, to name other projects by title rather than folder. */
  projects?: ReadonlyArray<KnownProject>,
  page: LibraryDuplicatesPage = {},
): Promise<ScientSourcesDuplicatesResult> {
  if (!store.exists) {
    return {
      pairs: [],
      pairsTotal: 0,
      revision: "empty",
      pairOffset: 0,
      mergeOffset: 0,
      merges: [],
      mergesTotal: 0,
    };
  }
  const listing = await readScientLibraryDuplicates({
    library: store.library,
    pairLimit: Math.min(page.pairLimit ?? Infinity, SCIENT_SOURCES_DUPLICATE_PAIR_LIMIT),
    mergeLimit: Math.min(page.mergeLimit ?? Infinity, SCIENT_SOURCES_UNDOABLE_MERGE_LIMIT),
    ...(page.pairOffset === undefined ? {} : { pairOffset: page.pairOffset }),
    ...(page.mergeOffset === undefined ? {} : { mergeOffset: page.mergeOffset }),
    ...(page.revision === undefined ? {} : { revision: page.revision }),
    ...(page.merges === undefined ? {} : { merges: page.merges }),
  });
  const pairs = listing.possibleDuplicates;
  const byId = new Map(listing.records.map((record) => [record.sourceId, record]));
  const shown = new Set([
    ...pairs.flatMap((pair) => pair.sourceIds),
    ...listing.merges.map(({ merge }) => merge.survivorId),
  ]);
  const row = await duplicateRows(store, shown, projects);
  return {
    pairs: pairs.map((pair) => {
      // The default kept source first, so the two read left to right as "keep, merge away".
      const [first, second] =
        pair.sourceIds[0] === pair.survivorId
          ? pair.sourceIds
          : [pair.sourceIds[1], pair.sourceIds[0]];
      return {
        kind: pair.kind,
        ...(pair.reason ? { reason: pair.reason } : {}),
        sources: [row(byId.get(first)!), row(byId.get(second)!)] as const,
        keptByDefault: pair.survivorId,
      };
    }),
    pairsTotal: listing.pairsTotal,
    revision: listing.revision,
    ...(listing.restarted ? { restarted: true as const } : {}),
    pairOffset: listing.pairOffset,
    mergeOffset: listing.mergeOffset,
    merges: listing.merges.map(({ merge, merged, undo }) => {
      const kept = byId.get(merge.survivorId);
      return {
        ...mergeEntry(merge, merged, kept ? row(kept) : null),
        merged: merged ? scientSourceSummaryFromRecord(merged) : null,
        undo,
      };
    }),
    mergesTotal: listing.mergesTotal,
    ...(listing.damagedReceipts.length > 0
      ? { damagedReceipts: listing.damagedReceipts.map((receipt) => ({ ...receipt })) }
      : {}),
  };
}

async function duplicateRows(
  store: Store,
  shown: ReadonlySet<string>,
  projects: ReadonlyArray<KnownProject> | undefined,
) {
  const [pins, categories, others] = await Promise.all([
    projectPinGroupsByLibraryId(store),
    readScientSourceCategories(store.library).catch((): Categories => ({})),
    otherProjectsUsing(store, shown, projects),
  ]);
  return (record: ScientSourceRecord) => ({
    ...overviewRow(pinnedEntry(record, pins.get(record.sourceId)), categories),
    otherProjects: others.get(record.sourceId) ?? [],
  });
}

function mergeEntry(
  merge: ScientLibraryMerge,
  merged: ScientSourceRecord | null,
  kept: ReturnType<Awaited<ReturnType<typeof duplicateRows>>> | null,
) {
  return {
    mergeId: merge.mergeId,
    mergedAt: merge.mergedAt,
    requested: merge.kind === "requested",
    keptSourceId: merge.survivorId,
    kept,
    mergedSourceId: merge.loserId,
    mergedTitle: merged?.title ?? null,
    keptDifferent: merge.conflicts.map((conflict) => conflict.field),
    differences: mergeDifferences(merge),
  };
}

/**
 * One merge's receipt by ID, as the Merged list shows it, also once undone or no longer
 * undoable, with whether Undo can run now. Undo checks again when it runs.
 */
export async function libraryMergeReceipt(store: Store, mergeId: string) {
  if (!store.exists) return null;
  const receipt = await readScientLibraryMergeReceipt({ library: store.library, mergeId });
  if (!receipt) return null;
  const row = receipt.kept
    ? await duplicateRows(store, new Set([receipt.kept.sourceId]), undefined)
    : null;
  return {
    ...mergeEntry(receipt.merge, receipt.merged, receipt.kept && row ? row(receipt.kept) : null),
    undo: receipt.undo,
  };
}

/** A library record, a project source ID this project pins, or a review's own record. */
export async function librarySourceDetail(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly reviewId?: string;
    /** The project note and history under this key of the source's, not the first pinned. */
    readonly citationKey?: string;
    /** True only for a session holding the Library write grant on this environment. */
    readonly personal?: boolean;
  },
) {
  if (input.reviewId) {
    const entry = await readScientLibraryReviewRecord({
      ...reviewAccess(store),
      projectRoot: store.root,
      reviewId: input.reviewId,
      sourceId: input.sourceId,
    });
    if (!entry?.record) throw new Error("The source was not found in this review.");
    const match = (await libraryReviewRecordMatches(store, [entry])).get(input.sourceId);
    const libraryId = await libraryIdOf(store, input.sourceId);
    const current = store.exists ? await readScientSourceRecord(store.library, libraryId) : null;
    const keptId =
      current || !store.exists
        ? libraryId
        : resolveScientLibraryAlias(await readScientLibraryAliases(store.library), input.sourceId);
    return {
      ...normalizeSourceRecordForRead(routeRecord(entry.record, undefined)),
      ...(entry.from === "snapshot" ? { label: SNAPSHOT_LABEL } : {}),
      ...(match ? { libraryMatch: match } : {}),
      ...(await keptCopiesOf(store, keptId, current ?? entry.record)),
    };
  }
  const sourceId = await libraryIdOf(store, input.sourceId);
  const record = store.exists ? await readScientSourceRecord(store.library, sourceId) : null;
  if (record) {
    const detail = await projectRecordOf(
      store,
      normalizeSourceRecordForRead(record),
      input.citationKey,
    );
    return {
      ...detail,
      ...(input.personal ? { personalNote: record.note ?? null } : {}),
      ...scientSourceReadingState(record),
      ...(detail.pinned ? await noteHistoryOf(store, input.citationKey ?? detail.citationKey) : {}),
      ...(await keptCopiesOf(store, sourceId, record)),
    };
  }
  const snapshot = (
    await listScientProjectPinnedWorks({
      projectRoot: store.root,
      library: store.exists ? store.library : null,
    })
  ).find((work) => work.from === "snapshot" && work.projectSourceId === input.sourceId);
  if (!snapshot) throw new Error("The source was not found in the Library.");
  if (input.citationKey !== undefined && input.citationKey !== snapshot.citationKey) {
    throw new Error(`${input.citationKey} does not cite this source in this project.`);
  }
  const match = store.exists
    ? (await libraryPinMatches(store, new Set([input.sourceId]))).get(input.sourceId)
    : undefined;
  const keptId = store.exists
    ? resolveScientLibraryAlias(
        await readScientLibraryAliases(store.library),
        snapshot.projectSourceId,
      )
    : sourceId;
  return {
    ...routeRecord(snapshot.record, {
      citationKey: snapshot.citationKey,
      ...(snapshot.projectNote ? { note: snapshot.projectNote } : {}),
    }),
    pinned: true,
    fromSnapshot: true as const,
    projectNote: snapshot.projectNote,
    ...(match ? { libraryMatch: match } : {}),
    ...(await noteHistoryOf(store, snapshot.citationKey)),
    ...(await keptCopiesOf(store, keptId, snapshot.record, {
      citationKey: snapshot.citationKey,
    })),
  };
}

const recordsById = async (store: Store) =>
  new Map(
    (await listScientSourceRecords(store.library)).map((record) => [record.sourceId, record]),
  );

/** Why a project source this Library serves from its snapshot was not taken for its candidates. */
function libraryMatchOf(
  work: ScientLibraryIdentityFields,
  resolution: ScientProjectSourceResolution | undefined,
  records: ReadonlyMap<string, ScientSourceRecord>,
): ScientSourceLibraryMatch | undefined {
  if (resolution?.kind !== "unresolved") return undefined;
  if (resolution.reason !== "contradicted" && resolution.reason !== "ambiguous") return undefined;
  return {
    reason: resolution.reason,
    keptSeparate: resolution.keptSeparate === true,
    candidates: resolution.candidateIds.flatMap((sourceId) => {
      const record = records.get(sourceId);
      if (!record) return [];
      const problem = scientLibraryIdentityProblem(work, record);
      return [
        {
          sourceId,
          title: record.title,
          issuedYear: record.issuedYear,
          containerTitle: record.containerTitle,
          ...(problem ? { problem } : {}),
        },
      ];
    }),
  };
}

/**
 * For pins this Library serves from their snapshot although it holds sources sharing their
 * identifier or title: why, and those sources, by project source ID. Writes nothing.
 */
export async function libraryPinMatches(
  store: Store,
  projectSourceIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ScientSourceLibraryMatch>> {
  const matches = new Map<string, ScientSourceLibraryMatch>();
  if (!store.exists || projectSourceIds.size === 0) return matches;
  const pins = await resolveScientProjectPins({
    projectRoot: store.root,
    library: store.library,
    mode: "read",
    actor: ACTOR,
  });
  const wanted = pins.filter(
    ({ pin, resolution }) =>
      projectSourceIds.has(pin.sourceId) &&
      resolution.kind === "unresolved" &&
      (resolution.reason === "contradicted" || resolution.reason === "ambiguous"),
  );
  if (wanted.length === 0) return matches;
  const records = await recordsById(store);
  for (const { pin, resolution } of wanted) {
    const match = libraryMatchOf(pin.work, resolution, records);
    if (match) matches.set(pin.sourceId, match);
  }
  return matches;
}

/** The repair matches of a review's snapshot records, by project source ID. Writes nothing. */
export async function libraryReviewRecordMatches(
  store: Store,
  entries: ReadonlyArray<ScientLibraryReviewRecord>,
): Promise<ReadonlyMap<string, ScientSourceLibraryMatch>> {
  const matches = new Map<string, ScientSourceLibraryMatch>();
  const repairable = entries.filter(
    (entry) =>
      entry.record &&
      (entry.unresolved?.reason === "contradicted" || entry.unresolved?.reason === "ambiguous"),
  );
  if (!store.exists || repairable.length === 0) return matches;
  const records = await recordsById(store);
  for (const entry of repairable) {
    const match = libraryMatchOf(entry.record!, entry.unresolved, records);
    if (match) matches.set(entry.projectSourceId, match);
  }
  return matches;
}

/**
 * `libraryPinMatches`, then the records of this project's reviews no pin names: a full-text
 * screening record is repaired under the review's project source ID, without becoming a citation.
 */
async function libraryProjectSourceMatch(
  store: Store,
  projectSourceId: string,
): Promise<ScientSourceLibraryMatch | undefined> {
  const pinned = (await libraryPinMatches(store, new Set([projectSourceId]))).get(projectSourceId);
  if (pinned || !store.exists) return pinned;
  for (const reviewId of await listScientLibraryReviewIds(store.root)) {
    const entry = await readScientLibraryReviewRecord({
      library: store.library,
      mode: "read",
      projectRoot: store.root,
      reviewId,
      sourceId: projectSourceId,
    });
    const match = entry
      ? (await libraryReviewRecordMatches(store, [entry])).get(projectSourceId)
      : undefined;
    if (match) return match;
  }
  return undefined;
}

/**
 * Deliberate repair of a pin or review record served from its snapshot: link it to one of the
 * Library sources it was compared with (credited, undoable), or record that it is none of them.
 */
export async function repairLibraryPin(
  store: Store,
  change: ScientSourcesPinRepairAction,
  actor: ScientSourceActor,
) {
  const repair = {
    library: store.library,
    projectRoot: store.root,
    projectSourceId: change.sourceId,
  };
  switch (change.action) {
    case "link-pin": {
      const linked = await linkScientProjectSourceKeepingCopies({
        ...repair,
        sourceId: change.librarySourceId,
        actor,
      });
      if (linked.outcome === "linked") await syncProjectBibliography(store, actor);
      return { outcome: linked.outcome };
    }
    case "unlink-pin": {
      const unlinked = await unlinkScientProjectSourceRestoringCopies({ ...repair, actor });
      if (unlinked.outcome === "unlinked") await syncProjectBibliography(store, actor);
      return { outcome: unlinked.outcome };
    }
    case "keep-pin-separate":
    case "clear-pin-separate": {
      const separate = change.action === "keep-pin-separate";
      const match = separate ? await libraryProjectSourceMatch(store, change.sourceId) : undefined;
      if (separate && !match) return { outcome: "not-found" as const };
      return keepScientProjectSourceSeparate({
        ...repair,
        sourceIds: match?.candidates.map((candidate) => candidate.sourceId) ?? [],
        separate,
        actor,
      });
    }
  }
}

/** What each kind of holder saves of a source; a kept copy shows no other field. */
const KEPT_FIELDS = {
  "citation-key": new Set(Object.keys(ScientPinWork.fields)),
  review: new Set(Object.keys(ScientReviewWork.fields)),
};

/**
 * What this project's saved details held before a merge Undo replaced them, beside the values
 * the details show now; copies whose citation key or review has since gone are included.
 */
export async function keptCopiesOf(
  store: Store,
  sourceId: string,
  shown: Readonly<object> | null,
  options?: { readonly citationKey?: string },
) {
  const copies = (await readScientDisplacedCopiesOf(store.root, sourceId)).flatMap((copy) => {
    const differs = copy.differs.filter((field) => KEPT_FIELDS[copy.holder].has(field));
    return differs.length > 0 ? [{ ...copy, differs }] : [];
  });
  if (copies.length === 0) return {};
  const group = (await projectPinGroupsByLibraryId(store)).get(sourceId);
  // A pin served from its snapshot is in no group: its key or own ID names it.
  const keys = new Set([
    ...(group ? [group.pin.citationKey, ...group.alsoCitedAs] : []),
    ...(options?.citationKey ? [options.citationKey] : []),
    ...(await readScientProjectPins(store.root)).flatMap((pin) =>
      pin.sourceId === sourceId ? [pin.citationKey] : [],
    ),
  ]);
  const reviews = await readScientLibraryReviewTitles(
    store.root,
    copies.flatMap((copy) => (copy.holder === "review" ? [copy.heldBy] : [])),
  );
  const valueOf = (from: unknown, field: string) =>
    typeof from === "object" && from !== null
      ? ((from as Record<string, unknown>)[field] ?? null)
      : null;
  return {
    keptCopies: copies.map((copy) => {
      const title = copy.holder === "review" ? reviews.get(copy.heldBy) : undefined;
      return {
        holder: copy.holder,
        heldBy: copy.heldBy,
        ...(title ? { holderName: title } : {}),
        holderPresent: copy.holder === "review" ? title !== undefined : keys.has(copy.heldBy),
        undoneAt: copy.undoneAt,
        fields: copy.differs.map((field) => ({
          field,
          earlier: valueOf(copy.work, field),
          current: valueOf(shown, field),
        })),
      };
    }),
  };
}

async function noteHistoryOf(store: Store, citationKey: string | null | undefined) {
  if (!citationKey) return {};
  const versions = await readScientProjectPinNoteHistory({ projectRoot: store.root, citationKey });
  return versions && versions.length > 1
    ? {
        projectNoteHistory: versions.map(({ note, at, kind, by }) => ({
          note,
          at,
          kind,
          ...(by ? { by } : {}),
        })),
      }
    : {};
}

export async function libraryAttachmentMaterial(
  store: Store,
  input: { readonly sourceId: string; readonly attachmentId: string },
) {
  const record = await requireRecord(store, await libraryIdOf(store, input.sourceId));
  const attachment = record.attachments.find(
    (candidate) => candidate.attachmentId === input.attachmentId,
  );
  if (!attachment) throw new Error("The source attachment was not found in the Library.");
  return {
    absolutePath: sourceAttachmentAbsolutePath(store.library, attachment),
    attachment,
    folder: store.library.root,
  };
}

export async function libraryJournalIconMaterial(
  store: Store,
  input: { readonly sourceId: string; readonly cacheRoot: string },
) {
  if (!store.exists) return null;
  const record = await readScientSourceRecord(
    store.library,
    await libraryIdOf(store, input.sourceId),
  );
  return record ? resolveJournalCover({ record, cacheRoot: input.cacheRoot }) : null;
}

/**
 * A new citationKey on a source pinned here renames this project's pin and documents only; the
 * record's preferred key changes only for a source not pinned here.
 */
export async function updateLibrarySourceMetadata(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly metadata: ScientSourceEditableMetadata;
    readonly allowPossibleMetadataMatch?: boolean;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const pins = await projectPinsByLibraryId(store);
  const pin = pins.get(sourceId);
  const current = await requireRecord(store, sourceId);
  const requestedKey = input.metadata.citationKey?.trim();
  const renamesPin =
    pin !== undefined && requestedKey !== undefined && requestedKey !== pin.citationKey;
  const keyMessage = renamesPin
    ? citationKeyValidationMessage(
        requestedKey,
        takenCitationKeys([...pins.values()], pin.sourceId),
      )
    : requestedKey && pin === undefined && requestedKey !== current.citationKey
      ? citationKeyValidationMessage(
          requestedKey,
          takenCitationKeys(await listScientSourceRecords(store.library), sourceId),
        )
      : null;
  if (keyMessage) throw new Error(keyMessage);
  const { citationKey: _projectKey, ...withoutKey } = input.metadata;
  // Found before the key changes, so a scan failure leaves the old key in place.
  const scan = renamesPin ? await scanCitationKeyRenameDocuments(store.root) : null;
  const result = await updateScientSourceMetadata({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    metadata: pin !== undefined ? withoutKey : input.metadata,
    allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
    actor: ACTOR,
  });
  const accepted = result.outcome === "updated" || result.outcome === "unchanged";
  const renamed =
    renamesPin && accepted && requestedKey && scan
      ? (await renameScientProjectPinKey({
          projectRoot: store.root,
          citationKey: pin.citationKey,
          to: requestedKey,
        }).then((outcome) => outcome.outcome === "renamed"))
        ? await renameCitationKeyInProject(store.root, pin.citationKey, requestedKey, scan)
        : null
      : null;
  if (result.outcome === "updated" || renamed) await afterChange(store, [sourceId]);
  return {
    outcome: renamed && result.outcome === "unchanged" ? ("updated" as const) : result.outcome,
    record: await projectRecordOf(store, result.record),
    duplicate: result.duplicate,
    validationIssues: result.validationIssues,
    ...(renamed ? { citationKeyRenamedIn: renamed.renamedIn } : {}),
    ...(renamed && renamed.skipped.length > 0 ? { citationKeyRenameSkipped: renamed.skipped } : {}),
    ...(await reach(store, sourceId)),
  };
}

/** The panel's note here is this project's note on the pin; a source not pinned has none. */
export async function updateLibraryProjectNote(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly note: string | null;
    readonly expectedNote?: string | null;
    readonly noteSession?: string;
    readonly citationKey?: string;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const pins = await projectPinsByLibraryId(store);
  const snapshotPin = async () =>
    (await listScientProjectPinnedWorks({ projectRoot: store.root, library: store.library }))
      .filter(
        (work) =>
          work.projectSourceId === input.sourceId &&
          (input.citationKey === undefined || work.citationKey === input.citationKey),
      )
      .map((work) => ({ citationKey: work.citationKey }))[0];
  const pin =
    input.citationKey !== undefined && pins.has(sourceId)
      ? (await pinUnderKey(store, sourceId, input.citationKey)).pin
      : (pins.get(sourceId) ?? (await snapshotPin()));
  if (!pin) {
    throw new Error(
      input.citationKey === undefined
        ? "Pin this source in the project to give it a project note."
        : `${input.citationKey} does not cite this source in this project.`,
    );
  }
  const updated = await setScientProjectPinNote({
    projectRoot: store.root,
    citationKey: pin.citationKey,
    note: input.note,
    base: input.expectedNote ?? null,
    actor: ACTOR,
    ...(input.noteSession !== undefined ? { session: input.noteSession } : {}),
  });
  if (updated.outcome === "not-pinned") throw new Error("The source is no longer pinned here.");
  return {
    outcome: updated.outcome,
    record: await librarySourceDetail(store, {
      sourceId: input.sourceId,
      ...(input.citationKey !== undefined ? { citationKey: input.citationKey } : {}),
    }),
  };
}

/** The person's own note on the library record; the caller holds the Library write grant. */
export async function updateLibraryPersonalNote(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
    readonly expectedNote?: string | null;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  await requireRecord(store, sourceId);
  const updated = await updateScientSourceNote({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    note: input.note,
    ...(input.expectedNote !== undefined ? { expectedNote: input.expectedNote } : {}),
    actor: ACTOR,
  });
  return {
    outcome: updated.outcome,
    record: await librarySourceDetail(store, { sourceId, personal: true }),
    ...(await reach(store, sourceId)),
  };
}

export async function refreshLibrarySourceMetadata(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly resolveIdentifier: ResolveSourceIdentifier;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const result = await refreshScientSourceMetadata({ ...input, root: store.library, sourceId });
  if (result.outcome === "refreshed") await afterChange(store, [sourceId]);
  return {
    ...result,
    record: await projectRecordOf(store, result.record),
    ...(await reach(store, sourceId)),
  };
}

/** Moves the library record to the trash; pins keep it in their snapshots. */
export async function removeLibrarySource(
  store: Store,
  input: { readonly sourceId: string; readonly expectedRevision: number },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  const reached = await reach(store, sourceId);
  const result = await removeSource({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    actor: ACTOR,
  });
  return { ...result, ...reached };
}

/** The trash, each entry with the projects that would keep citing it from their own copy. */
export async function libraryTrash(store: Store, projects?: ReadonlyArray<KnownProject>) {
  if (!store.exists) return { entries: [], issues: [] };
  const listing = await listScientSourceTrash(store.library);
  const citing = await projectsCitingRemoved(
    store,
    new Set(listing.entries.map((entry) => entry.sourceId)),
    projects,
  ).catch(() => new Map<string, ReadonlyArray<string>>());
  return {
    ...listing,
    entries: listing.entries.map((entry) => {
      const citedBy = citing.get(entry.sourceId);
      return citedBy ? { ...entry, citedBy } : entry;
    }),
  };
}

/** The Library's recent changes; the whole Library's, whichever project asks. */
export async function libraryRecentChanges(
  store: Pick<Store, "library" | "exists">,
  input: {
    readonly limit?: number;
    readonly sourcesOfImport?: string;
    readonly notBroughtOfImport?: string;
    readonly differencesOfJoin?: { readonly joinId: string; readonly offset?: number };
    /** False for a session that may only read: the person's own notes are left out. */
    readonly personal?: boolean;
  },
): Promise<ScientLibraryRecentChanges> {
  if (!store.exists) return { changes: [], more: false };
  if (input.differencesOfJoin !== undefined) {
    // Reads only, this Library and the folder the join read; a join it does not know is empty.
    const joinDifferences = await readScientLibraryJoinDifferences({
      library: store.library,
      joinId: input.differencesOfJoin.joinId,
      ...(input.personal === false ? { personal: false } : {}),
      ...(input.differencesOfJoin.offset === undefined
        ? {}
        : { offset: input.differencesOfJoin.offset }),
    });
    return { changes: [], more: false, ...(joinDifferences ? { joinDifferences } : {}) };
  }
  if (input.notBroughtOfImport !== undefined) {
    return {
      changes: [],
      more: false,
      importNotBrought: await listScientLibraryImportNotBrought(
        store.library,
        input.notBroughtOfImport,
      ),
    };
  }
  if (input.sourcesOfImport !== undefined) {
    return {
      changes: [],
      more: false,
      importSourceIds: await listScientLibraryImportSources(store.library, input.sourcesOfImport),
    };
  }
  return listScientLibraryRecentChanges(
    store.library,
    input.limit ?? 50,
    runningLibraryJoins(store.library),
  );
}

export async function restoreLibrarySource(store: Store, input: { readonly sourceId: string }) {
  const result = await restoreScientSource({
    root: store.library,
    sourceId: input.sourceId,
    actor: ACTOR,
  });
  if (result.outcome === "restored") await afterChange(store, [result.sourceId]);
  return {
    ...result,
    record: result.record ? routeRecord(result.record, await pinOf(store, result.sourceId)) : null,
  };
}

export async function deleteLibrarySourcesPermanently(
  store: Store,
  input: { readonly sourceIds?: ReadonlyArray<string> },
) {
  return deleteScientSourcesPermanently({
    root: store.library,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
  });
}

export async function librarySourceRevisions(store: Store, input: { readonly sourceId: string }) {
  const revisions = store.exists
    ? await listScientSourceRevisions(store.library, await libraryIdOf(store, input.sourceId))
    : null;
  if (!revisions) throw new Error("The source was not found in the Library.");
  return { revisions };
}

export async function revertLibrarySource(
  store: Store,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly toRevision: number;
  },
) {
  const sourceId = await libraryIdOf(store, input.sourceId);
  await requireRecord(store, sourceId);
  const result = await revertScientSource({
    root: store.library,
    sourceId,
    expectedRevision: input.expectedRevision,
    toRevision: input.toRevision,
    actor: ACTOR,
  });
  if (result.outcome === "reverted") await afterChange(store, [sourceId]);
  return {
    ...result,
    record: await projectRecordOf(store, result.record),
    ...(await reach(store, sourceId)),
  };
}

export async function bulkUpdateLibrarySources(
  store: Store,
  input: {
    readonly change: ScientSourcesBulkRequestChange;
    readonly partOf?: string;
    readonly partNumber?: number;
  },
) {
  const change =
    "sourceIds" in input.change
      ? {
          ...input.change,
          sourceIds: await Promise.all(
            input.change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
          ),
        }
      : input.change;
  // A type change, or the undo of one, changes what pin and review snapshots hold; tags do not.
  const changesSnapshots =
    "type" in change ||
    ("undoBatchId" in change &&
      (await scientBulkEditChangedType(store.library, change.undoBatchId)) !== false);
  const result = await bulkUpdateSources({
    root: store.library,
    change,
    actor: ACTOR,
    ...(input.partOf ? { partOf: input.partOf } : {}),
    ...(input.partNumber !== undefined ? { partNumber: input.partNumber } : {}),
  });
  if (changesSnapshots) {
    await afterChange(
      store,
      result.sources.flatMap((entry) => (entry.outcome === "updated" ? [entry.sourceId] : [])),
    );
  }
  return result;
}

export const isLibraryOrganizeAction = (
  change: ScientSourcesOrganizeAction | ScientSourcesLibraryOrganizeAction,
): change is ScientSourcesLibraryOrganizeAction =>
  change.action === "pin" ||
  change.action === "unpin" ||
  change.action === "change-pins" ||
  change.action === "merge" ||
  change.action === "undo-merge" ||
  change.action === "mark-distinct" ||
  change.action === "clear-distinct" ||
  change.action === "move-back" ||
  change.action === "dismiss-move-summary" ||
  change.action === "retry-move" ||
  change.action === "dismiss-notice-changes" ||
  change.action === "restore-pre-move" ||
  change.action === "export-package" ||
  change.action === "list-packages" ||
  change.action === "list-package-imports" ||
  change.action === "import-package" ||
  change.action === "back-up-library" ||
  change.action === "add-from-library" ||
  change.action === "undo-join" ||
  change.action === "take-from-library" ||
  change.action === "undo-import" ||
  isPinRepairAction(change);

export const isPinRepairAction = (change: {
  readonly action: string;
}): change is ScientSourcesPinRepairAction =>
  change.action === "link-pin" ||
  change.action === "unlink-pin" ||
  change.action === "keep-pin-separate" ||
  change.action === "clear-pin-separate";

const pinSummary = (pin: ScientProjectPin) => ({
  citationKey: pin.citationKey,
  sourceId: pin.sourceId,
  ...(pin.note !== undefined ? { note: pin.note } : {}),
});

/** Collections and saved searches on the library, plus pins and merges with their Undo IDs. */
export async function organizeLibrarySources(
  store: Store,
  input: { readonly change: ScientSourcesOrganizeAction | ScientSourcesLibraryOrganizeAction },
) {
  const { change } = input;
  if (!isLibraryOrganizeAction(change)) {
    const resolved =
      "sourceIds" in change && change.sourceIds
        ? {
            ...change,
            sourceIds: await Promise.all(
              change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
            ),
          }
        : change;
    return organizeSources({ root: store.library, change: resolved, actor: ACTOR });
  }
  switch (change.action) {
    case "pin": {
      const pinned = await pinScientLibrarySource({
        projectRoot: store.root,
        library: store.library,
        sourceId: await libraryIdOf(store, change.sourceId),
        actor: ACTOR,
        ...(change.note !== undefined ? { note: change.note } : {}),
      });
      if (pinned.outcome === "not-found") return { outcome: "not-found" as const };
      const noted =
        pinned.outcome === "existing" && change.note !== undefined
          ? await setScientProjectPinNote({
              projectRoot: store.root,
              citationKey: pinned.pin.citationKey,
              note: change.note,
              base: change.noteBase ?? null,
              actor: ACTOR,
            })
          : null;
      const pin = noted && noted.outcome !== "not-pinned" ? noted.pin : pinned.pin;
      if (pinned.outcome === "pinned") await syncProjectBibliography(store, ACTOR);
      return {
        outcome: noted?.outcome === "stale" ? ("stale" as const) : pinned.outcome,
        pin: pinSummary(pin),
      };
    }
    case "unpin": {
      const unpinned = await unpinScientLibrarySource({
        projectRoot: store.root,
        citationKey: change.citationKey,
        actor: ACTOR,
      });
      if (unpinned.outcome === "not-pinned") return { outcome: "not-pinned" as const };
      await syncProjectBibliography(store, ACTOR);
      return { outcome: "unpinned" as const, pin: pinSummary(unpinned.pin) };
    }
    case "change-pins":
      return changeLibraryPins(store, change);
    case "merge":
      return mergeLibrarySources(store, change);
    case "undo-merge": {
      const undone = await undoScientLibraryMerge({
        library: store.library,
        mergeId: change.mergeId,
        actor: ACTOR,
      });
      if (undone.outcome !== "undone") return { outcome: undone.outcome };
      await afterChange(store, [undone.survivor.sourceId, undone.loser.sourceId]);
      return {
        outcome: "undone" as const,
        survivorId: undone.survivor.sourceId,
        unrevertedFields: undone.unrevertedFields,
      };
    }
    case "mark-distinct": {
      const sourceIds = await distinctPair(store, change.sourceIds);
      if (!(await bothInLibrary(store, sourceIds))) return { outcome: "not-found" as const };
      return markScientLibrarySourcesDistinct({ library: store.library, sourceIds, actor: ACTOR });
    }
    case "clear-distinct": {
      const cleared = await clearScientLibrarySourcesDistinct({
        library: store.library,
        sourceIds: await distinctPair(store, change.sourceIds),
      });
      return { outcome: cleared.outcome === "cleared" ? cleared.outcome : ("unchanged" as const) };
    }
    case "move-back":
      return moveBackResult(
        await moveProjectBackIntoProject({
          root: store.root,
          library: store.library,
          actor: ACTOR,
        }),
      );
    case "dismiss-move-summary":
      return {
        outcome: await dismissScientLibraryMoveSummary({
          library: store.library,
          projectRoot: store.root,
        }),
      };
    case "retry-move":
      // Every change runs the move first; one served from the Library has moved.
      return { outcome: "moved" as const };
    case "dismiss-notice-changes":
      return { outcome: await dismissScientLibraryNoticeChanges(store.library) };
    case "link-pin":
    case "unlink-pin":
    case "keep-pin-separate":
    case "clear-pin-separate":
      return repairLibraryPin(store, change, ACTOR);
    case "restore-pre-move":
      return restoreProjectPreMoveArchive({
        root: store.root,
        ...(change.archiveId ? { archiveId: change.archiveId } : {}),
        ...(change.abandon ? { abandon: true } : {}),
      });
    case "export-package":
      return exportLibraryProjectPackage(store, change);
    case "list-package-imports":
      return listLibraryProjectPackageImports(store);
    case "list-packages":
      return listLibraryProjectPackages(store);
    case "import-package":
      return importLibraryProjectPackage(store, change, ACTOR);
    case "back-up-library":
      // The backup itself refuses a folder that is not absolute, missing or inside the Library.
      return startLibraryBackup(store.library, change.inFolder);
    case "add-from-library":
      // The join itself accepts only a checked backup or a Library a restore moved aside.
      return startLibraryJoin(store.library, change.fromFolder, ACTOR);
    case "undo-join": {
      const undone = await undoLibraryJoin(store.library, change.joinId, ACTOR);
      if (undone.outcome === "join-undone") await afterChange(store, []);
      return undone;
    }
    case "take-from-library": {
      const taken = await takeFromScientLibraryJoin({
        library: store.library,
        joinId: change.joinId,
        otherSourceId: change.otherSourceId,
        take: change.take,
        shown: change.shown,
        operationId: change.operationId,
        actor: ACTOR,
      });
      if (taken.outcome === "taken") {
        await afterChange(store, [taken.sourceId]);
        return { outcome: "taken" as const };
      }
      const answers = {
        already: "take-already",
        changed: "take-changed",
        unavailable: "take-unavailable",
        "too-long": "take-too-long",
        "not-found": "join-not-found",
      } as const;
      return { outcome: answers[taken.outcome] };
    }
    case "undo-import":
      return undoLibraryProjectPackageImport(store, change, ACTOR);
  }
}

/** Each pin and unpin answered as alone, with one write of the pins and of the bibliography. */
async function changeLibraryPins(
  store: Store,
  change: Extract<ScientSourcesLibraryOrganizeAction, { readonly action: "change-pins" }>,
) {
  const requested = change.changes.flatMap((entry) =>
    entry.action === "pin" ? [entry.sourceId] : [],
  );
  // One unreadable ID fails the batched lookup; then each is looked up alone, as one pin would be.
  const libraryIds = new Map(
    await resolveLibrarySourceIds(store, requested).catch(async () => {
      const each: Array<readonly [string, string]> = [];
      for (const sourceId of requested) {
        each.push([sourceId, await libraryIdOf(store, sourceId).catch(() => sourceId)]);
      }
      return each;
    }),
  );
  const results = await changeScientProjectPins({
    projectRoot: store.root,
    library: store.library,
    actor: ACTOR,
    changes: change.changes.map((entry) =>
      entry.action === "pin"
        ? {
            action: "pin" as const,
            sourceId: libraryIds.get(entry.sourceId) ?? entry.sourceId,
            ...(entry.note !== undefined ? { note: entry.note } : {}),
            ...(entry.noteBase !== undefined ? { noteBase: entry.noteBase } : {}),
          }
        : entry,
    ),
  });
  // A refusal's reason stays on the server, as a failed request's does.
  const pinChanges = results.map((result) =>
    "pin" in result
      ? { outcome: result.outcome, pin: pinSummary(result.pin) }
      : { outcome: result.outcome },
  );
  const changed = results.some(
    (result) => result.outcome === "pinned" || result.outcome === "unpinned",
  );
  if (changed) await syncProjectBibliography(store, ACTOR);
  return { outcome: changed ? ("updated" as const) : ("unchanged" as const), pinChanges };
}

const distinctPair = async (store: Store, sourceIds: readonly [string, string]) =>
  [await libraryIdOf(store, sourceIds[0]), await libraryIdOf(store, sourceIds[1])] as const;

/** "Not duplicates" names two live Library sources; an unknown ID is not-found, as for merge. */
export const bothInLibrary = async (store: Store, sourceIds: readonly [string, string]) =>
  store.exists &&
  (
    await Promise.all(sourceIds.map((sourceId) => readScientSourceRecord(store.library, sourceId)))
  ).every((record) => record !== null);

export const moveBackResult = (moved: Awaited<ReturnType<typeof moveProjectBackIntoProject>>) =>
  moved.outcome === "moved-back"
    ? { outcome: moved.outcome, restoredSources: moved.restoredSources }
    : { outcome: moved.outcome };

async function mergeLibrarySources(
  store: Store,
  change: Extract<ScientSourcesLibraryOrganizeAction, { readonly action: "merge" }>,
) {
  const sourceIds = await Promise.all(
    change.sourceIds.map((sourceId) => libraryIdOf(store, sourceId)),
  );
  const requested = change.survivorId ? await libraryIdOf(store, change.survivorId) : undefined;
  const [first, ...rest] = sourceIds;
  let survivorId = requested ?? first!;
  const merges: Array<{
    readonly mergeId: string;
    readonly survivorId: string;
    readonly mergedSourceId: string;
    readonly keptDifferent: ReadonlyArray<string>;
  }> = [];
  const others = (requested ? sourceIds : rest).filter((other) => other !== survivorId);
  let notMerged: ReadonlyArray<string> = [];
  for (const [index, other] of others.entries()) {
    const merged = await mergeScientLibrarySources({
      library: store.library,
      sourceIds: [survivorId, other],
      ...(requested ? { survivorId } : {}),
      actor: ACTOR,
    }).catch((error: unknown) => {
      // Earlier merges of this request have landed: report them and their Undo IDs.
      if (merges.length > 0) return { outcome: "failed" as const };
      throw error;
    });
    if (merged.outcome === "not-found" || merged.outcome === "failed") {
      if (merges.length === 0) return { outcome: "not-found" as const };
      notMerged = others.slice(index);
      break;
    }
    if (merged.outcome === "already-merged") continue;
    survivorId = merged.merge.survivorId;
    merges.push({
      mergeId: merged.merge.mergeId,
      survivorId: merged.merge.survivorId,
      mergedSourceId: merged.merge.loserId,
      keptDifferent: merged.merge.conflicts.map((conflict) => conflict.field),
    });
  }
  if (merges.length === 0) return { outcome: "already-merged" as const, survivorId };
  await afterChange(store, [survivorId]);
  return {
    outcome: "merged" as const,
    survivorId,
    merges,
    ...(notMerged.length > 0 ? { notMerged } : {}),
    ...(await reach(store, survivorId)),
  };
}

/** A read on a computer with no library serves every review record from its snapshot. */
const reviewAccess = (store: Store) =>
  store.exists
    ? { library: store.library, mode: store.access }
    : { library: null, mode: "read" as const };

export async function libraryReviews(store: Store) {
  return listScientLibraryReviews({ ...reviewAccess(store), projectRoot: store.root });
}

const reviewRecordSummary = (entry: ScientLibraryReviewRecord): ScientSystematicReviewRecord => ({
  sourceId: entry.projectSourceId,
  revision: entry.record?.revision ?? 0,
  title: entry.record?.title ?? null,
  creators: entry.record?.creators ?? [],
  issuedYear: entry.record?.issuedYear ?? null,
  containerTitle: entry.record?.containerTitle ?? null,
  ...(entry.from === "snapshot"
    ? { label: SNAPSHOT_LABEL }
    : entry.from === "missing"
      ? { label: "Details missing" as const }
      : {}),
});

/** The review and its records under the IDs it stores; records removed here are left out. */
export async function libraryReview(
  store: Store,
  input: { readonly reviewId: string },
): Promise<ScientSystematicReviewResult> {
  const access = { ...reviewAccess(store), projectRoot: store.root, reviewId: input.reviewId };
  const detail = await readScientLibraryReview(access);
  if (!detail) return { detail: null };
  const records = (await listScientLibraryReviewRecords(access)) ?? [];
  const { versions, combineReport } = await libraryReviewConflicts(store, input);
  return {
    detail,
    records: records.filter((entry) => !entry.removed).map(reviewRecordSummary),
    ...(versions.length > 0 ? { conflictVersions: versions.length } : {}),
    ...(combineReport ? { combineReport } : {}),
  };
}

/**
 * The review's other versions from copies of this project, for the picker, with a page of what
 * differs from one when asked, and Combine's report until it is dismissed. Reads the project
 * folder only.
 */
export async function libraryReviewConflicts(
  store: Store,
  input: Omit<ScientSystematicReviewConflictsRequest, "root">,
) {
  const at = { projectRoot: store.root, reviewId: input.reviewId };
  const [{ currentRevision, ...versions }, combineReport] = await Promise.all([
    readScientReviewVersions({ ...at, ...input }),
    readScientReviewCombineReport(at),
  ]);
  return { ...versions, ...(currentRevision ? { currentRevision } : {}), combineReport };
}

/** The pick between two versions of a review, or dismissing Combine's report. */
export async function changeLibraryReviewConflict(
  store: Store,
  input: { readonly reviewId: string; readonly change: ScientSystematicReviewConflictChange },
  actor: ScientSourceActor = ACTOR,
) {
  const at = { projectRoot: store.root, reviewId: input.reviewId };
  const { change } = input;
  if (change.action === "dismiss-report") {
    return { outcome: await dismissScientReviewCombineReport(at) };
  }
  const resolved = await resolveScientReviewConflict({
    ...at,
    library: store.library,
    conflictId: change.conflictId,
    pick: change.pick,
    actor,
    ...(change.currentRevision ? { expectedRevision: change.currentRevision } : {}),
  });
  if (resolved.outcome === "not-found") return { outcome: "not-found" as const };
  if (resolved.outcome === "version-changed") return { outcome: "version-changed" as const };
  const combineReport = resolved.report ? await readScientReviewCombineReport(at) : null;
  return { outcome: "resolved" as const, ...(combineReport ? { combineReport } : {}) };
}

export async function changeLibraryReview(
  store: Store,
  input: { readonly change: ScientSystematicReviewAction },
) {
  return changeScientLibraryReview({
    projectRoot: store.root,
    library: store.library,
    change: input.change,
    actor: ACTOR,
  });
}

/**
 * Exports this project's pinned works by default (each source once, under its first key), or the
 * named sources from the library. A source pinned here is written under its project key, and the
 * only note it carries is the project's.
 */
export async function exportLibrarySources(
  store: Store,
  input: {
    readonly format: Parameters<typeof exportBibliography>[0]["format"];
    readonly sourceIds?: ReadonlyArray<string>;
    readonly includeNotes?: boolean;
  },
) {
  const works = distinctPinnedWorks(await listProjectPinnedWorks(store, ACTOR));
  const pinnedRecords = works.map((work) =>
    routeRecord(work.record, {
      citationKey: work.citationKey,
      ...(work.projectNote ? { note: work.projectNote } : {}),
    }),
  );
  const pins = await projectPinsByLibraryId(store);
  const records = input.sourceIds
    ? [
        ...(store.exists ? await listScientSourceRecords(store.library) : []).map((record) =>
          routeRecord(record, pins.get(record.sourceId)),
        ),
        ...pinnedRecords.filter((_, index) => works[index]?.from === "snapshot"),
      ]
    : pinnedRecords;
  const sourceIds = input.sourceIds
    ? await Promise.all(
        input.sourceIds.map(async (sourceId) =>
          records.some((record) => record.sourceId === sourceId)
            ? sourceId
            : libraryIdOf(store, sourceId),
        ),
      )
    : undefined;
  return exportBibliography({
    root: store.root,
    format: input.format,
    ...(sourceIds ? { sourceIds } : {}),
    ...(input.includeNotes !== undefined ? { includeNotes: input.includeNotes } : {}),
    records,
  });
}

/** Library IDs for a Zotero request; without IDs, the records this project pins. */
export async function libraryZoteroSourceIds(
  store: Store,
  sourceIds: ReadonlyArray<string> | undefined,
): Promise<ReadonlyArray<string>> {
  if (!sourceIds) return [...(await projectPinsByLibraryId(store)).keys()];
  return Promise.all(sourceIds.map((sourceId) => libraryIdOf(store, sourceId)));
}

/**
 * A library import's store and pin target. The view decides: "This project" pins into the
 * project; the Library view (`pin: false`) brings records in unpinned. Later calls on the
 * operation need only the library, since the target is stored with it.
 */
export function libraryImportTarget(store: Store, pin: boolean | undefined) {
  return { root: store.library, ...(pin === false ? {} : { pinInto: store.root }) };
}

/** Pins what an intake route brought in, unless it came from the Library view. */
export async function pinLibraryIntake(
  store: Store,
  sourceIds: ReadonlyArray<string | null>,
): Promise<void> {
  let pinned = false;
  for (const sourceId of new Set(sourceIds)) {
    if (!sourceId) continue;
    const result = await pinScientLibrarySource({
      projectRoot: store.root,
      library: store.library,
      sourceId,
      actor: ACTOR,
    });
    pinned ||= result.outcome === "pinned";
  }
  if (pinned) await syncProjectBibliography(store, ACTOR);
}

export const refreshAfterLibraryChange = afterChange;
