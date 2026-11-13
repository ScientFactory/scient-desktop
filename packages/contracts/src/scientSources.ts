import {
  MAX_SOURCE_IDENTIFIER_BATCH,
  ScientSourceIdentifierAddItem,
  ScientSourceEditableMetadata,
  ScientSourceImportOperation,
  ScientSourceMetadataDiagnostic,
  ScientSourceMetadataUpdateResult as ScientSourceMetadataUpdateResultFields,
  ScientSourceNote,
  ScientSourceNoteUpdateResult as ScientSourceNoteUpdateResultFields,
  ScientSourceRecord,
  ScientSourcePermanentDeletionResult,
  ScientSourceRemovalResult as ScientSourceRemovalResultFields,
  ScientSourceRestoreResult,
  ScientSourceRevertResult as ScientSourceRevertResultFields,
  ScientSourceRevisionSummary,
  ScientSourceSummary,
  ScientSourceTrashListing,
  ScientSourcePreflightItem,
  ScientSourceWebPage,
  ScientSourcesBulkRequestChange,
  ScientSourcesBulkResult,
  ScientReviewCombineReport,
  ScientReviewVersionSummary,
  ScientSystematicReviewAction,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewDetail,
  ScientSystematicReviewList,
  ScientSourcesOrganization,
  ScientSourcesOrganizeAction,
  ScientSourcesOrganizeResult as ScientSourcesOrganizeResultFields,
  ScientSourcesOverview as ScientSourcesStoreOverview,
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshResult,
  ScientSourceZoteroSendResult,
  ZoteroConnection,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroGroup,
  ZoteroGroupId,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@scientfactory/scient-sources";
import {
  BibliographyFormatSchema,
  BibliographyFieldLoss,
  BibliographyImportReport,
} from "@scientfactory/scient-sources/bibliography";
import * as Schema from "effect/Schema";
import * as Multipart from "effect/http/Multipart";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { AssetCreateUrlResult } from "./assets.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const BoundedPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** This project's pinned sources, or the whole personal library; only a library server reads it. */
export const ScientSourcesScope = Schema.Literals(["project", "library"]);
export type ScientSourcesScope = typeof ScientSourcesScope.Type;

/** False brings sources into the personal library without pinning them in this project. */
const PinRequest = Schema.optionalKey(Schema.Boolean);

/** How many other projects on this computer pin the changed source. */
const AlsoPinnedIn = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)));

/** A library record's reading state; a project server never sends or takes it. */
export const ScientSourceReadingStatus = Schema.Literals(["unread", "read"]);
export type ScientSourceReadingStatus = typeof ScientSourceReadingStatus.Type;

export const ScientSourcesOverviewRequest = Schema.Struct({
  root: NonEmptyString,
  scope: Schema.optionalKey(ScientSourcesScope),
  /** Library servers list only records with this reading state; `scopes` still counts them all. */
  readingStatus: Schema.optionalKey(ScientSourceReadingStatus),
  starred: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourcesOverviewRequest = typeof ScientSourcesOverviewRequest.Type;

const ScientSourceRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});

export const ScientSourceDetailRequest = Schema.Struct({
  ...ScientSourceRequest.fields,
  /** A review screen's request: the review's own record, from its snapshot when the library lacks it. */
  reviewId: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceDetailRequest = typeof ScientSourceDetailRequest.Type;

export const ScientSystematicReviewRecordLabel = Schema.Literals([
  "From this review's snapshot",
  "Details missing",
]);
export type ScientSystematicReviewRecordLabel = typeof ScientSystematicReviewRecordLabel.Type;

/** Fields a library server adds to a source; a project server sends none of them. */
const ScientSourcePinFields = {
  pinned: Schema.optionalKey(Schema.Boolean),
  /** A pin this library lacks: the source is the pin's snapshot under the project source ID. */
  fromSnapshot: Schema.optionalKey(Schema.Literal(true)),
  /** The pin's note ("why I cite this here"); the person's own note is `personalNote`. */
  projectNote: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * This project's other keys for the source, after it merged two sources the project both used.
   * `citationKey` is the one pinned first; every key stays in the bibliography.
   */
  alsoCitedAs: Schema.optionalKey(Schema.Array(NonEmptyString)),
  /** The person's reading state; absent for a pin's snapshot, which this library lacks. */
  readingStatus: Schema.optionalKey(ScientSourceReadingStatus),
  starred: Schema.optionalKey(Schema.Boolean),
};

/** A source with this project's fields: what an edit answers, so a client rebuilding its row keeps every key. */
export const ScientSourceProjectRecord = Schema.Struct({
  ...ScientSourceRecord.fields,
  ...ScientSourcePinFields,
});
export type ScientSourceProjectRecord = typeof ScientSourceProjectRecord.Type;

export const ScientSourceDetailResult = Schema.Struct({
  ...ScientSourceProjectRecord.fields,
  /**
   * The person's own note on the library record, which follows the paper. Only in the detail,
   * and only for a session holding the Library write grant; `note` stays this project's note.
   */
  personalNote: Schema.optionalKey(Schema.NullOr(Schema.String)),
  label: Schema.optionalKey(ScientSystematicReviewRecordLabel),
});
export type ScientSourceDetailResult = typeof ScientSourceDetailResult.Type;

export const ScientSourceAttachmentPreviewRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  attachmentId: NonEmptyString,
});
export type ScientSourceAttachmentPreviewRequest = typeof ScientSourceAttachmentPreviewRequest.Type;

export const ScientSourceAttachmentPreviewResult = Schema.Struct({
  ...AssetCreateUrlResult.fields,
  /** The attachment's content-addressed bytes, so reader quotes can record them. */
  material: Schema.optional(
    Schema.Struct({
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
});
export type ScientSourceAttachmentPreviewResult = typeof ScientSourceAttachmentPreviewResult.Type;

export const ScientSourcesFullTextSearchRequest = Schema.Struct({
  root: NonEmptyString,
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  /** Searches only these sources, before ranking and the limit; absent searches the whole Library. */
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000))),
  ),
});
export type ScientSourcesFullTextSearchRequest = typeof ScientSourcesFullTextSearchRequest.Type;

const TextOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ScientSourcesFullTextSearchResult = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      attachmentId: NonEmptyString,
      fileName: NonEmptyString,
      title: Schema.NullOr(Schema.String),
      page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      start: TextOffset,
      end: TextOffset,
      passage: Schema.String,
      matchedTerms: Schema.Array(Schema.String),
      selector: Schema.Struct({
        extractorVersion: NonEmptyString,
        viewBox: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
        rotation: Schema.Int,
        userUnit: Schema.Finite,
        pageTextHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
        quote: Schema.String,
        prefix: Schema.String,
        suffix: Schema.String,
      }),
    }),
  ),
  status: Schema.Struct({
    pdfs: TextOffset,
    searchable: TextOffset,
    pending: TextOffset,
    withoutText: TextOffset,
    unreadable: TextOffset,
  }),
});
export type ScientSourcesFullTextSearchResult = typeof ScientSourcesFullTextSearchResult.Type;

export const ScientSourceSavePageRequest = Schema.Struct({
  root: NonEmptyString,
  page: ScientSourceWebPage,
  pin: PinRequest,
});
export type ScientSourceSavePageRequest = typeof ScientSourceSavePageRequest.Type;

export const ScientSourceSavePageResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(["added", "existing"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    passageSaved: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("not-added"),
    reason: Schema.Literals(["identifier-not-found", "identifier-mismatch", "possible-duplicate"]),
    message: Schema.String,
    matchingSourceIds: Schema.Array(NonEmptyString),
  }),
]);
export type ScientSourceSavePageResult = typeof ScientSourceSavePageResult.Type;

export const ScientSourceJournalIconRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientSourceJournalIconRequest = typeof ScientSourceJournalIconRequest.Type;

export const ScientSourceJournalIconResult = Schema.Struct({
  icon: Schema.NullOr(
    Schema.Struct({
      ...AssetCreateUrlResult.fields,
      journalTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
    }),
  ),
});
export type ScientSourceJournalIconResult = typeof ScientSourceJournalIconResult.Type;

export const ScientSourceMetadataUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  metadata: ScientSourceEditableMetadata,
  allowPossibleMetadataMatch: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourceMetadataUpdateRequest = typeof ScientSourceMetadataUpdateRequest.Type;

export const ScientSourceNoteUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  note: ScientSourceNote,
});
export type ScientSourceNoteUpdateRequest = typeof ScientSourceNoteUpdateRequest.Type;
export const ScientSourceNoteUpdateResult = Schema.Struct({
  ...ScientSourceNoteUpdateResultFields.fields,
  record: ScientSourceProjectRecord,
});
export type ScientSourceNoteUpdateResult = typeof ScientSourceNoteUpdateResult.Type;

/** Library servers only: the person's own note on the library record. */
export const ScientSourcePersonalNoteUpdateRequest = ScientSourceNoteUpdateRequest;
export type ScientSourcePersonalNoteUpdateRequest =
  typeof ScientSourcePersonalNoteUpdateRequest.Type;

export const ScientSourcePersonalNoteUpdateResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "stale"]),
  record: ScientSourceDetailResult,
  alsoPinnedIn: AlsoPinnedIn,
});
export type ScientSourcePersonalNoteUpdateResult = typeof ScientSourcePersonalNoteUpdateResult.Type;

/** Library servers only: marks sources read or unread, starred or not. It changes no revision. */
export const ScientSourcesReadingStateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  ),
  readingStatus: Schema.optionalKey(ScientSourceReadingStatus),
  starred: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourcesReadingStateRequest = typeof ScientSourcesReadingStateRequest.Type;

export const ScientSourcesReadingStateResult = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      outcome: Schema.Literals(["updated", "unchanged", "not-found"]),
      readingStatus: Schema.optionalKey(ScientSourceReadingStatus),
      starred: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ScientSourcesReadingStateResult = typeof ScientSourcesReadingStateResult.Type;

export const ScientSourceMetadataUpdateResult = Schema.Struct({
  ...ScientSourceMetadataUpdateResultFields.fields,
  record: ScientSourceProjectRecord,
  alsoPinnedIn: AlsoPinnedIn,
});
export type ScientSourceMetadataUpdateResult = typeof ScientSourceMetadataUpdateResult.Type;

export const ScientSourceRemovalResult = Schema.Struct({
  ...ScientSourceRemovalResultFields.fields,
  alsoPinnedIn: AlsoPinnedIn,
});
export type ScientSourceRemovalResult = typeof ScientSourceRemovalResult.Type;

export const ScientSourceRevertResult = Schema.Struct({
  ...ScientSourceRevertResultFields.fields,
  record: ScientSourceProjectRecord,
  alsoPinnedIn: AlsoPinnedIn,
});
export type ScientSourceRevertResult = typeof ScientSourceRevertResult.Type;

export const ScientSourceMetadataRefreshRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceMetadataRefreshRequest = typeof ScientSourceMetadataRefreshRequest.Type;

export const ScientSourceMetadataRefreshResult = Schema.Struct({
  outcome: Schema.Literals(["refreshed", "unchanged", "stale", "unavailable", "duplicate"]),
  record: ScientSourceProjectRecord,
  changedFields: Schema.Array(NonEmptyString),
  message: Schema.NullOr(Schema.String),
  alsoPinnedIn: AlsoPinnedIn,
});
export type ScientSourceMetadataRefreshResult = typeof ScientSourceMetadataRefreshResult.Type;

export const ScientSourceRemovalRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceRemovalRequest = typeof ScientSourceRemovalRequest.Type;

const PinAction = Schema.Struct({
  action: Schema.Literal("pin"),
  sourceId: NonEmptyString,
  note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(20_000)))),
});
const UnpinAction = Schema.Struct({ action: Schema.Literal("unpin"), citationKey: NonEmptyString });

const DistinctPair = Schema.Tuple([NonEmptyString, NonEmptyString]);

/** Pins and merges act on the personal library; a project server refuses them. */
export const ScientSourcesLibraryOrganizeAction = Schema.Union([
  PinAction,
  UnpinAction,
  /** Many pins and unpins in one request, each answered in `pinChanges` in order. */
  Schema.Struct({
    action: Schema.Literal("change-pins"),
    changes: Schema.Array(Schema.Union([PinAction, UnpinAction])).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("merge"),
    sourceIds: Schema.Array(NonEmptyString).pipe(
      Schema.check(Schema.isMinLength(2), Schema.isMaxLength(50)),
    ),
    survivorId: Schema.optionalKey(NonEmptyString),
  }),
  Schema.Struct({ action: Schema.Literal("undo-merge"), mergeId: NonEmptyString }),
  /** "Not duplicates": the pair is never merged automatically or listed as possible again. */
  Schema.Struct({ action: Schema.Literal("mark-distinct"), sourceIds: DistinctPair }),
  /** Undo of mark-distinct. */
  Schema.Struct({ action: Schema.Literal("clear-distinct"), sourceIds: DistinctPair }),
  /** The move's Undo: the project's Sources go back into `.scient/sources`. */
  Schema.Struct({ action: Schema.Literal("move-back") }),
  /** Hides the move's summary lines in this checkout's status, until a later run. */
  Schema.Struct({ action: Schema.Literal("dismiss-move-summary") }),
]);
export type ScientSourcesLibraryOrganizeAction = typeof ScientSourcesLibraryOrganizeAction.Type;

export const ScientSourcesOrganizeRequest = Schema.Struct({
  root: NonEmptyString,
  change: Schema.Union([
    ...ScientSourcesOrganizeAction.members,
    ...ScientSourcesLibraryOrganizeAction.members,
  ]),
});
export type ScientSourcesOrganizeRequest = typeof ScientSourcesOrganizeRequest.Type;

const PinSummary = Schema.Struct({
  citationKey: NonEmptyString,
  sourceId: NonEmptyString,
  note: Schema.optionalKey(Schema.String),
});

export const ScientSourcesOrganizeResult = Schema.Struct({
  ...ScientSourcesOrganizeResultFields.fields,
  outcome: Schema.Literals([
    ...ScientSourcesOrganizeResultFields.fields.outcome.literals,
    "pinned",
    "unpinned",
    "not-pinned",
    "merged",
    "already-merged",
    "undone",
    "already-undone",
    "survivor-missing",
    "loser-missing",
    "moved-back",
    "not-moved",
    "project-store-present",
    "dismissed",
    "nothing-to-dismiss",
    "marked",
    "cleared",
  ]),
  pin: Schema.optionalKey(PinSummary),
  pinChanges: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        outcome: Schema.Literals([
          "pinned",
          "existing",
          "unpinned",
          "not-pinned",
          "not-found",
          "refused",
        ]),
        pin: Schema.optionalKey(PinSummary),
      }),
    ),
  ),
  /** Each merge that landed; Undo takes its mergeId. */
  merges: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mergeId: NonEmptyString,
        survivorId: NonEmptyString,
        mergedSourceId: NonEmptyString,
        keptDifferent: Schema.Array(Schema.String),
      }),
    ),
  ),
  survivorId: Schema.optionalKey(NonEmptyString),
  notMerged: Schema.optionalKey(Schema.Array(NonEmptyString)),
  unrevertedFields: Schema.optionalKey(Schema.Array(Schema.String)),
  alsoPinnedIn: AlsoPinnedIn,
  restoredSources: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ScientSourcesOrganizeResult = typeof ScientSourcesOrganizeResult.Type;

export const ScientSystematicReviewsRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSystematicReviewsRequest = typeof ScientSystematicReviewsRequest.Type;

export const ScientSystematicReviewRequest = Schema.Struct({
  root: NonEmptyString,
  reviewId: NonEmptyString,
});
export type ScientSystematicReviewRequest = typeof ScientSystematicReviewRequest.Type;

/** A record a review names, under the ID the review stores. */
export const ScientSystematicReviewRecord = Schema.Struct({
  sourceId: NonEmptyString,
  /** The library record's revision, or the snapshot's captured one; 0 when details are missing. */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: Schema.NullOr(Schema.String),
  creators: ScientSourceRecord.fields.creators,
  issuedYear: Schema.NullOr(Schema.Int),
  containerTitle: Schema.NullOr(Schema.String),
  label: Schema.optionalKey(ScientSystematicReviewRecordLabel),
});
export type ScientSystematicReviewRecord = typeof ScientSystematicReviewRecord.Type;

/** Combine's report on a review, kept until someone dismisses it. */
export const ScientSystematicReviewCombineReport = Schema.Struct({
  ...ScientReviewCombineReport.fields,
  combinedAt: NonEmptyString,
});
export type ScientSystematicReviewCombineReport = typeof ScientSystematicReviewCombineReport.Type;

export const ScientSystematicReviewResult = Schema.Struct({
  detail: Schema.NullOr(ScientSystematicReviewDetail),
  /** A library server's review records; a project server leaves them to the overview. */
  records: Schema.optionalKey(Schema.Array(ScientSystematicReviewRecord)),
  /**
   * Library server, present when above zero: other versions of this review that a copy of the
   * project brought ("This review has another version"); `systematicReviewConflicts` lists them.
   */
  conflictVersions: Schema.optionalKey(Count),
  combineReport: Schema.optionalKey(ScientSystematicReviewCombineReport),
});
export type ScientSystematicReviewResult = typeof ScientSystematicReviewResult.Type;

export const ScientSystematicReviewChangeRequest = Schema.Struct({
  root: NonEmptyString,
  change: ScientSystematicReviewAction,
});
export type ScientSystematicReviewChangeRequest = typeof ScientSystematicReviewChangeRequest.Type;

/** The picker for a review with other versions: the one in force, then each other version. */
export const ScientSystematicReviewConflictsResult = Schema.Struct({
  current: Schema.NullOr(ScientReviewVersionSummary),
  /** Names the version in force by its content; a pick sends it back. */
  currentRevision: Schema.optionalKey(NonEmptyString),
  versions: Schema.Array(ScientReviewVersionSummary),
  combineReport: Schema.NullOr(ScientSystematicReviewCombineReport),
});
export type ScientSystematicReviewConflictsResult =
  typeof ScientSystematicReviewConflictsResult.Type;

/** Keep this version, use the other or combine; or dismiss Combine's report. */
export const ScientSystematicReviewConflictChange = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("resolve"),
    conflictId: NonEmptyString,
    pick: Schema.Literals(["keep", "use-other", "combine"]),
    /** The picker's `currentRevision`; another version in force answers `version-changed`. */
    currentRevision: Schema.optionalKey(NonEmptyString),
  }),
  Schema.Struct({ action: Schema.Literal("dismiss-report") }),
]);
export type ScientSystematicReviewConflictChange = typeof ScientSystematicReviewConflictChange.Type;

export const ScientSystematicReviewConflictRequest = Schema.Struct({
  root: NonEmptyString,
  reviewId: NonEmptyString,
  change: ScientSystematicReviewConflictChange,
});
export type ScientSystematicReviewConflictRequest =
  typeof ScientSystematicReviewConflictRequest.Type;

export const ScientSystematicReviewConflictResult = Schema.Struct({
  outcome: Schema.Literals([
    "resolved",
    "not-found",
    "version-changed",
    "dismissed",
    "nothing-to-dismiss",
  ]),
  /** After a combine that left something to decide; also kept on the review until dismissed. */
  combineReport: Schema.optionalKey(ScientSystematicReviewCombineReport),
});
export type ScientSystematicReviewConflictResult = typeof ScientSystematicReviewConflictResult.Type;

export const ScientSourcesMoveStatusRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSourcesMoveStatusRequest = typeof ScientSourcesMoveStatusRequest.Type;

/** Where a move or a move back is; `done` of `total` counts the phase's own items. */
export const ScientSourcesMoveProgress = Schema.Struct({
  phase: Schema.Literals([
    "sources",
    "files",
    "verifying",
    "merging",
    "switching",
    "cleaning-up",
    "restoring",
  ]),
  done: Count,
  total: Count,
});
export type ScientSourcesMoveProgress = typeof ScientSourcesMoveProgress.Type;

/**
 * The one-time move of this project into the personal library. A project server always answers
 * `nothing-to-move`. `lines` is the summary, empty once dismissed (`dismiss-move-summary`).
 */
export const ScientSourcesMoveStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("nothing-to-move") }),
  /** A v1 store not moved yet, or a move interrupted before it committed; a write moves it. */
  Schema.Struct({ state: Schema.Literal("waiting") }),
  Schema.Struct({
    state: Schema.Literal("moving"),
    progress: Schema.NullOr(ScientSourcesMoveProgress),
  }),
  Schema.Struct({ state: Schema.Literal("done"), lines: Schema.Array(Schema.String) }),
  /** Moved, with old files left that could not be removed yet (open in another program). */
  Schema.Struct({
    state: Schema.Literal("cleanup-pending"),
    filesLeft: Count,
    lines: Schema.Array(Schema.String),
  }),
  /** A move back running (with progress) or interrupted (null; the next write finishes it). */
  Schema.Struct({
    state: Schema.Literal("restoring"),
    progress: Schema.NullOr(ScientSourcesMoveProgress),
  }),
  Schema.Struct({
    state: Schema.Literal("moved-back"),
    restoredSources: Count,
    restoredPdfs: Count,
  }),
  Schema.Struct({ state: Schema.Literal("failed"), reason: Schema.String }),
]);
export type ScientSourcesMoveStatus = typeof ScientSourcesMoveStatus.Type;

export const ScientSourcesBulkUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  change: ScientSourcesBulkRequestChange,
});
export type ScientSourcesBulkUpdateRequest = typeof ScientSourcesBulkUpdateRequest.Type;
export const ScientSourcesAddByIdentifierRequest = Schema.Struct({
  root: NonEmptyString,
  entries: Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SOURCE_IDENTIFIER_BATCH)),
  ),
  pin: PinRequest,
});
export type ScientSourcesAddByIdentifierRequest = typeof ScientSourcesAddByIdentifierRequest.Type;

export const ScientSourcesAddByIdentifierResult = Schema.Struct({
  results: Schema.Array(ScientSourceIdentifierAddItem),
});
export type ScientSourcesAddByIdentifierResult = typeof ScientSourcesAddByIdentifierResult.Type;

export const ScientSourcesTrashRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSourcesTrashRequest = typeof ScientSourcesTrashRequest.Type;

export const ScientSourceRestoreRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientSourceRestoreRequest = typeof ScientSourceRestoreRequest.Type;

/** Without sourceIds the whole trash is emptied. */
export const ScientSourcesPermanentDeletionRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  ),
});
export type ScientSourcesPermanentDeletionRequest =
  typeof ScientSourcesPermanentDeletionRequest.Type;

export const ScientSourceRevisionsRequest = ScientSourceRequest;
export type ScientSourceRevisionsRequest = typeof ScientSourceRevisionsRequest.Type;

export const ScientSourceRevisionsResult = Schema.Struct({
  revisions: Schema.Array(ScientSourceRevisionSummary),
});
export type ScientSourceRevisionsResult = typeof ScientSourceRevisionsResult.Type;

export const ScientSourceRevertRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  toRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceRevertRequest = typeof ScientSourceRevertRequest.Type;

/** Without a connection, Zotero on this computer is preferred, then zotero.org. */
export const ZoteroStatusRequest = Schema.Struct({
  connection: Schema.optionalKey(ZoteroConnection),
});
export type ZoteroStatusRequest = typeof ZoteroStatusRequest.Type;

const BoundedSourceIds = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
);
const RefreshFields = Schema.Array(ScientSourceZoteroRefreshField).pipe(
  Schema.check(Schema.isMaxLength(32)),
);

/** Without sourceIds, every source imported from Zotero is refreshed. */
export const ScientSourcesZoteroRefreshRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: Schema.optionalKey(BoundedSourceIds),
  connection: Schema.optionalKey(ZoteroConnection),
  useZotero: Schema.optionalKey(RefreshFields),
  keepLocal: Schema.optionalKey(RefreshFields),
});
export type ScientSourcesZoteroRefreshRequest = typeof ScientSourcesZoteroRefreshRequest.Type;

/** Without a groupId, sources go to My Library. */
export const ScientSourcesZoteroSendRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: BoundedSourceIds,
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ScientSourcesZoteroSendRequest = typeof ScientSourcesZoteroSendRequest.Type;

export const ZoteroLibraryRequest = Schema.Struct({
  scope: ZoteroImportScope,
  query: Schema.String,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: BoundedPageSize,
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ZoteroLibraryRequest = typeof ZoteroLibraryRequest.Type;

export const ZoteroCollectionsRequest = Schema.Struct({
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ZoteroCollectionsRequest = typeof ZoteroCollectionsRequest.Type;

export const ZoteroScopedImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  scope: ZoteroImportScope,
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
  pin: PinRequest,
});
export type ZoteroScopedImportRequest = typeof ZoteroScopedImportRequest.Type;

export const ScientSourcesPreflightRequest = Schema.Struct({
  root: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ScientSourcesPreflightRequest = typeof ScientSourcesPreflightRequest.Type;

export const ScientSourcesPreflightResult = Schema.Struct({
  items: Schema.Array(ScientSourcePreflightItem),
});
export type ScientSourcesPreflightResult = typeof ScientSourcesPreflightResult.Type;

export const ScientSourcesLocalPdfUploadRequest = Schema.Struct({
  root: NonEmptyString,
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 2,
    maxFieldSize: 16 * 1024,
    maxFileSize: 512 * 1024 * 1024,
    maxTotalSize: 512 * 1024 * 1024 + 64 * 1024,
  }),
);
export type ScientSourcesLocalPdfUploadRequest = typeof ScientSourcesLocalPdfUploadRequest.Type;

export const ScientSourcesLocalPdfUploadResult = Schema.Struct({
  item: ScientSourcePreflightItem,
});
export type ScientSourcesLocalPdfUploadResult = typeof ScientSourcesLocalPdfUploadResult.Type;

export const ScientSourcesFileImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  file: Multipart.SingleFileSchema,
  /** The file's path on the server's computer, when the client is that computer; PDFs it links in its folder are attached. */
  sourcePath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
  /** "false" from the Library view; a multipart field is text. */
  pin: Schema.optionalKey(Schema.Literals(["true", "false"])),
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 4,
    maxFieldSize: 16 * 1024,
    maxFileSize: 32 * 1024 * 1024,
    maxTotalSize: 32 * 1024 * 1024 + 64 * 1024,
  }),
);
export type ScientSourcesFileImportRequest = typeof ScientSourcesFileImportRequest.Type;

export const ScientSourcesFileImportResult = Schema.Struct({
  operation: Schema.NullOr(ScientSourceImportOperation),
  report: BibliographyImportReport,
});
export type ScientSourcesFileImportResult = typeof ScientSourcesFileImportResult.Type;

export const ScientSourcesExportRequest = Schema.Struct({
  root: NonEmptyString,
  format: BibliographyFormatSchema,
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000))),
  ),
  includeNotes: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourcesExportRequest = typeof ScientSourcesExportRequest.Type;

export const ScientSourcesExportResult = Schema.Struct({
  format: BibliographyFormatSchema,
  fileName: NonEmptyString,
  content: Schema.String,
  sourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  missingSourceIds: Schema.Array(NonEmptyString),
  /** Details the format has no place for, so the file does not carry them. */
  notKept: Schema.Array(BibliographyFieldLoss),
});
export type ScientSourcesExportResult = typeof ScientSourcesExportResult.Type;

export const ScientSourcesDiscardStagedRequest = ScientSourcesPreflightRequest;
export type ScientSourcesDiscardStagedRequest = typeof ScientSourcesDiscardStagedRequest.Type;

export const ScientSourcesDiscardStagedResult = Schema.Struct({
  discarded: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScientSourcesDiscardStagedResult = typeof ScientSourcesDiscardStagedResult.Type;

export const ScientSourcesBeginImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  possibleMetadataMatchOverrides: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMaxLength(500)),
  ),
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
  pin: PinRequest,
});
export type ScientSourcesBeginImportRequest = typeof ScientSourcesBeginImportRequest.Type;

export const ScientSourcesAdvanceImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
});
export type ScientSourcesAdvanceImportRequest = typeof ScientSourcesAdvanceImportRequest.Type;

export const ScientSourcesCancelImportRequest = ScientSourcesAdvanceImportRequest;
export type ScientSourcesCancelImportRequest = typeof ScientSourcesCancelImportRequest.Type;

export const ScientSourcesRetryImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
});
export type ScientSourcesRetryImportRequest = typeof ScientSourcesRetryImportRequest.Type;

export {
  ScientSourceImportOperation,
  ScientSourcesBulkResult,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewList,
  ScientSourcePermanentDeletionResult,
  ScientSourceRestoreResult,
  ScientSourceTrashListing,
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshResult,
  ScientSourceZoteroSendResult,
  ZoteroConnection,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroGroup,
  ZoteroGroupId,
  ZoteroImportScope,
  ZoteroLibraryPage,
};
export const ScientSourceRecordDiagnostics = Schema.Struct({
  sourceId: NonEmptyString,
  diagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourceRecordDiagnostics = typeof ScientSourceRecordDiagnostics.Type;

export const ScientSourcesOverviewRecord = Schema.Struct({
  ...ScientSourceSummary.fields,
  ...ScientSourcePinFields,
});
export type ScientSourcesOverviewRecord = typeof ScientSourcesOverviewRecord.Type;

export const ScientSourcesOverviewResult = Schema.Struct({
  ...ScientSourcesStoreOverview.fields,
  records: Schema.Array(ScientSourcesOverviewRecord),
  recordDiagnostics: Schema.Array(ScientSourceRecordDiagnostics),
  // Optional so a client can read an older server's overview.
  organization: Schema.optionalKey(ScientSourcesOrganization),
  /**
   * Present only when the server keeps a personal library: which scope `records` lists, and how
   * many sources each scope holds. A pinned record's `citationKey` is this project's key.
   */
  scopes: Schema.optionalKey(
    Schema.Struct({
      listed: ScientSourcesScope,
      project: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      library: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  /**
   * Present only when the server keeps a personal library, also for a project still served from
   * its own folder (not moved yet, or moved back), which has no `scopes`: ask `moveStatus`.
   */
  libraryBackend: Schema.optionalKey(Schema.Literal(true)),
});
export type ScientSourcesOverviewResult = typeof ScientSourcesOverviewResult.Type;

/** Library servers only; a project server refuses it. */
export const ScientSourcesDuplicatesRequest = Schema.Struct({
  root: NonEmptyString,
  /** A later page of each list; with the `revision` the earlier page answered with. */
  pairOffset: Schema.optionalKey(Count),
  mergeOffset: Schema.optionalKey(Count),
  revision: Schema.optionalKey(NonEmptyString),
});
export type ScientSourcesDuplicatesRequest = typeof ScientSourcesDuplicatesRequest.Type;

/** An overview row, with the other checkouts on this computer that use it, by folder name. */
const ScientSourcesDuplicateSource = Schema.Struct({
  ...ScientSourcesOverviewRecord.fields,
  otherProjects: Schema.Array(Schema.String),
});
export type ScientSourcesDuplicateSource = typeof ScientSourcesDuplicateSource.Type;

/** At most this many pairs and merges are sent per page; the totals count them all. */
export const SCIENT_SOURCES_DUPLICATE_PAIR_LIMIT = 200;
export const SCIENT_SOURCES_UNDOABLE_MERGE_LIMIT = 100;

export const ScientSourcesPossibleDuplicateKind = Schema.Literals([
  "possible-item-match",
  "possible-identifier-match",
  "possible-pdf-match",
  "possible-metadata-match",
  "possible-container-match",
]);
export const ScientSourcesDuplicateReason = Schema.Literals([
  "merge-undone",
  "title-missing",
  "titles-differ",
  "type-unknown",
  "preprint-and-published",
  "types-differ",
  "arxiv-versions-differ",
  "identifiers-conflict",
  "conflicting-group",
]);
export type ScientSourcesDuplicateReason = typeof ScientSourcesDuplicateReason.Type;

export const ScientSourcesMergeDifferences = Schema.Array(
  Schema.Union([
    Schema.Struct({
      field: NonEmptyString,
      kept: Schema.NullOr(Schema.String),
      other: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ field: NonEmptyString }),
  ]),
);

/** The possible duplicates of the whole Library, and the merges Undo can still reverse. */
export const ScientSourcesDuplicatesResult = Schema.Struct({
  pairs: Schema.Array(
    Schema.Struct({
      kind: ScientSourcesPossibleDuplicateKind,
      /** Why a shared Zotero item, identifier or PDF was not merged automatically. */
      reason: Schema.optionalKey(ScientSourcesDuplicateReason),
      sources: Schema.Tuple([ScientSourcesDuplicateSource, ScientSourcesDuplicateSource]),
      /** The one a merge keeps unless the person picks the other. */
      keptByDefault: NonEmptyString,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(SCIENT_SOURCES_DUPLICATE_PAIR_LIMIT))),
  pairsTotal: Count,
  /** Changes when either whole list does; a page asked under an older one starts both at 0. */
  revision: NonEmptyString,
  restarted: Schema.optionalKey(Schema.Literal(true)),
  pairOffset: Count,
  mergeOffset: Count,
  /** Newest first. */
  merges: Schema.Array(
    Schema.Struct({
      mergeId: NonEmptyString,
      mergedAt: NonEmptyString,
      /** False for the automatic merges of the move into the Library. */
      requested: Schema.Boolean,
      /** The source the merge kept, whether or not it is still in the Library. */
      keptSourceId: NonEmptyString,
      /** Null when the kept source was merged on or removed since: Undo explains. */
      kept: Schema.NullOr(ScientSourcesDuplicateSource),
      mergedSourceId: NonEmptyString,
      mergedTitle: Schema.NullOr(Schema.String),
      /** The merged-away source as it was, so two copies with one title can be told apart. */
      merged: ScientSourceSummary,
      /** Fields where the two had different values and the kept source's value stayed. */
      keptDifferent: Schema.Array(Schema.String),
      /**
       * Each work field the two differed in (kept, or filled in from the other), with the kept
       * one's value before the merge and the other's as text, null where one had none. Identifiers
       * and PDFs come without values: the merge file records only what was added.
       */
      differences: ScientSourcesMergeDifferences,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(SCIENT_SOURCES_UNDOABLE_MERGE_LIMIT))),
  mergesTotal: Count,
});
export type ScientSourcesDuplicatesResult = typeof ScientSourcesDuplicatesResult.Type;
