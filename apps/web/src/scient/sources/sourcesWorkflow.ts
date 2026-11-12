import type {
  ScientSourceDetailResult,
  ScientSourceImportOperation,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
  ScientSourcesReadingStateResult,
  ZoteroCollection,
  ZoteroConnectionStatus,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@t3tools/contracts";

import {
  completedImportCounts,
  type ScientSourcesImportCounts,
  type ScientSourcesImportOutcome,
} from "./importOutcome";

/**
 * The server owns durable import state. Validate hook-issued synchronous tokens in independent
 * import, overview, and Zotero lanes; a shared counter would let routine refreshes silently discard
 * running-import updates.
 */

export type ImportPreparation =
  | { readonly kind: "local-files"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "zotero"; readonly count: number }
  | { readonly kind: "file"; readonly name: string };

export interface SourcesWorkflowState {
  readonly request: number;
  readonly overviewRequest: number;
  readonly zoteroRequest: number;
  readonly overview: ScientSourcesOverviewResult | null;
  readonly sourceDetails: Readonly<Record<string, ScientSourceDetailResult>>;
  readonly zoteroStatus: ZoteroConnectionStatus | null;
  readonly library: ZoteroLibraryPage | null;
  readonly zoteroCollections: ReadonlyArray<ZoteroCollection>;
  readonly zoteroScope: ZoteroImportScope;
  /** The Zotero group being browsed; null for My Library. */
  readonly zoteroGroupId: string | null;
  readonly preflight: ScientSourcesPreflightResult | null;
  readonly preflightAdapter: "zotero" | "local-files" | null;
  readonly operation: ScientSourceImportOperation | null;
  readonly busy: boolean;
  readonly importPreparation: ImportPreparation | null;
  readonly checkingZotero: boolean;
  readonly zoteroCheckFeedback: string | null;
  readonly cancelling: boolean;
  readonly error: string | null;
  readonly readingOverrides: Readonly<Record<string, ReadingOverride>>;
}

export const initialSourcesWorkflowState: SourcesWorkflowState = {
  request: 0,
  overviewRequest: 0,
  zoteroRequest: 0,
  overview: null,
  sourceDetails: {},
  zoteroStatus: null,
  library: null,
  zoteroCollections: [],
  zoteroScope: { kind: "library" },
  zoteroGroupId: null,
  preflight: null,
  preflightAdapter: null,
  operation: null,
  busy: false,
  importPreparation: null,
  checkingZotero: false,
  zoteroCheckFeedback: null,
  cancelling: false,
  error: null,
  readingOverrides: {},
};

export type SourcesWorkflowAction =
  | {
      readonly type: "contextReset";
      readonly request: number;
      readonly overviewRequest: number;
      readonly zoteroRequest: number;
    }
  | { readonly type: "requestStarted"; readonly request: number }
  | { readonly type: "overviewRequestStarted"; readonly request: number }
  | { readonly type: "zoteroRequestStarted"; readonly request: number }
  | {
      readonly type: "overviewArrived";
      readonly request: number;
      readonly overview: ScientSourcesOverviewResult;
    }
  | {
      readonly type: "sourceDetailArrived";
      readonly sourceId: string;
      readonly detail: ScientSourceDetailResult;
    }
  | { readonly type: "sourceRecordAccepted"; readonly record: ScientSourceDetailResult }
  | { readonly type: "sourceRemoved"; readonly sourceId: string }
  | { readonly type: "readingStateArrived"; readonly result: ScientSourcesReadingStateResult }
  | {
      readonly type: "zoteroStatusArrived";
      readonly status: ZoteroConnectionStatus;
      readonly feedback: string | null;
    }
  | {
      readonly type: "zoteroLibraryArrived";
      readonly request: number;
      readonly page: ZoteroLibraryPage;
    }
  | { readonly type: "zoteroLibrarySeeded"; readonly page: ZoteroLibraryPage }
  | { readonly type: "zoteroScopeChanged"; readonly scope: ZoteroImportScope }
  | { readonly type: "zoteroGroupChanged"; readonly groupId: string | null }
  | {
      readonly type: "zoteroCollectionsArrived";
      readonly collections: ReadonlyArray<ZoteroCollection>;
    }
  | { readonly type: "zoteroLibraryClosed" }
  | { readonly type: "zoteroStatusDismissed" }
  | { readonly type: "zoteroCheckFeedbackChanged"; readonly feedback: string | null }
  | { readonly type: "importReviewDismissed" }
  | { readonly type: "operationCleared" }
  | {
      readonly type: "importPreparationChanged";
      readonly preparation: ImportPreparation | null;
      readonly error?: string | null;
    }
  | {
      readonly type: "preflightArrived";
      readonly request: number;
      readonly preflight: ScientSourcesPreflightResult;
      readonly adapter: "zotero" | "local-files";
    }
  | {
      readonly type: "operationArrived";
      readonly request: number;
      readonly operation: ScientSourceImportOperation;
      readonly clearLibrary?: boolean;
      readonly clearPreflight?: boolean;
    }
  | { readonly type: "busyChanged"; readonly busy: boolean }
  | { readonly type: "cancellingChanged"; readonly cancelling: boolean }
  | { readonly type: "checkingZoteroChanged"; readonly checking: boolean }
  | { readonly type: "errorArrived"; readonly error: string | null }
  | { readonly type: "errorCleared" };

/** A response belongs to the present only if its lane token is still current. */
function isCurrent(state: SourcesWorkflowState, request: number): boolean {
  return request === state.request;
}

function acceptRecordIntoOverview(
  overview: ScientSourcesOverviewResult,
  record: ScientSourceDetailResult,
): ScientSourcesOverviewResult {
  const recordIndex = overview.records.findIndex((entry) => entry.sourceId === record.sourceId);
  if (recordIndex === -1) return overview;
  const records = [...overview.records];
  records[recordIndex] = {
    sourceId: record.sourceId,
    revision: record.revision,
    type: record.type,
    title: record.title,
    creators: record.creators,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    containerTitle: record.containerTitle,
    url: record.url,
    externalReferences: record.externalReferences,
    attachments: record.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
    })),
    importedAt: record.importedAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...libraryFields(record, overview.records[recordIndex]),
  };
  return { ...overview, records };
}

type ReadingChange = Partial<
  Pick<ScientSourcesReadingStateResult["sources"][number], "outcome" | "readingStatus" | "starred">
>;

/** A reading change that landed, kept until an overview that started after it lands. */
type ReadingOverride = ReadingChange & { readonly atOverviewRequest: number };

type LibraryFields = Pick<
  ScientSourceDetailResult,
  "pinned" | "projectNote" | "fromSnapshot" | "readingStatus" | "starred"
>;
const LIBRARY_FIELDS = [
  "pinned",
  "projectNote",
  "fromSnapshot",
  "readingStatus",
  "starred",
] as const;

/** A library server's row fields, from the record where it carries them, else from the row. */
function libraryFields(record: LibraryFields, row: LibraryFields | undefined): LibraryFields {
  return Object.fromEntries(
    LIBRARY_FIELDS.flatMap((key) =>
      key in record ? [[key, record[key]]] : row && key in row ? [[key, row[key]]] : [],
    ),
  );
}

/**
 * Edit results other than the personal note's own leave the personal note out; the one on screen
 * stays. Reading state changes no revision, so it is kept from the details shown.
 */
function keepPersonalFields(
  record: ScientSourceDetailResult,
  shown: ScientSourceDetailResult | undefined,
): ScientSourceDetailResult {
  if (!shown) return record;
  return {
    ...(shown.readingStatus !== undefined && !("readingStatus" in record)
      ? { readingStatus: shown.readingStatus }
      : {}),
    ...(shown.starred !== undefined && !("starred" in record) ? { starred: shown.starred } : {}),
    ...record,
    ...("personalNote" in shown && !("personalNote" in record)
      ? { personalNote: shown.personalNote ?? null }
      : {}),
  };
}

function withReadingState<
  T extends {
    readonly sourceId: string;
    readonly readingStatus?: unknown;
    readonly starred?: unknown;
  },
>(record: T, changes: ReadonlyMap<string, ReadingChange>): T {
  const change = changes.get(record.sourceId);
  if (!change || change.outcome === "not-found" || record.readingStatus === undefined) {
    return record;
  }
  return {
    ...record,
    ...(change.readingStatus !== undefined ? { readingStatus: change.readingStatus } : {}),
    ...(change.starred !== undefined ? { starred: change.starred } : {}),
  };
}

function pruneSourceDetails(
  details: SourcesWorkflowState["sourceDetails"],
  overview: ScientSourcesOverviewResult,
): SourcesWorkflowState["sourceDetails"] {
  return Object.fromEntries(
    Object.entries(details).flatMap(([sourceId, detail]) => {
      const summary = overview.records.find(
        (entry) => entry.sourceId === sourceId && entry.revision === detail.revision,
      );
      return summary ? [[sourceId, withSummaryReadingState(detail, summary)]] : [];
    }),
  );
}

/** The newest reading change wins over an answer to a read that started before it. */
function withReadingOverride<
  A extends {
    readonly sourceId: string;
    readonly readingStatus?: unknown;
    readonly starred?: unknown;
  },
>(record: A, overrides: Readonly<Record<string, ReadingOverride>>): A {
  const override = overrides[record.sourceId];
  if (!override) return record;
  return withReadingState(record, new Map([[record.sourceId, override]]));
}

/** Reading state changes no revision, so a kept detail takes it from the newer overview. */
function withSummaryReadingState(
  detail: ScientSourceDetailResult,
  summary: ScientSourcesOverviewResult["records"][number],
): ScientSourceDetailResult {
  if (
    summary.readingStatus === undefined ||
    (summary.readingStatus === detail.readingStatus && summary.starred === detail.starred)
  ) {
    return detail;
  }
  return {
    ...detail,
    readingStatus: summary.readingStatus,
    ...(summary.starred !== undefined ? { starred: summary.starred } : {}),
  };
}

export function sourcesWorkflowReducer(
  state: SourcesWorkflowState,
  action: SourcesWorkflowAction,
): SourcesWorkflowState {
  switch (action.type) {
    case "contextReset": {
      // A new project context invalidates every in-flight request at once.
      return {
        ...initialSourcesWorkflowState,
        request: action.request,
        overviewRequest: action.overviewRequest,
        zoteroRequest: action.zoteroRequest,
      };
    }
    case "requestStarted":
      return { ...state, request: action.request };
    case "overviewRequestStarted":
      return { ...state, overviewRequest: action.request };
    case "zoteroRequestStarted":
      return { ...state, zoteroRequest: action.request };
    case "overviewArrived": {
      // Only the newest overview load wins; import progress and Zotero
      // browsing run on their own lanes and are unaffected by this check.
      if (action.request !== state.overviewRequest) return state;
      const pending = new Map(
        Object.entries(state.readingOverrides).filter(
          ([, override]) => override.atOverviewRequest >= action.request,
        ),
      );
      const overview =
        pending.size > 0
          ? {
              ...action.overview,
              records: action.overview.records.map((record) => withReadingState(record, pending)),
            }
          : action.overview;
      return {
        ...state,
        overview,
        sourceDetails: pruneSourceDetails(state.sourceDetails, overview),
        operation: overview.activeOperation ?? state.operation,
        readingOverrides: Object.fromEntries(
          Object.entries(state.readingOverrides).filter(
            ([, override]) => override.atOverviewRequest > action.request,
          ),
        ),
      };
    }
    case "sourceDetailArrived": {
      return {
        ...state,
        sourceDetails: {
          ...state.sourceDetails,
          [action.sourceId]: withReadingOverride(action.detail, state.readingOverrides),
        },
      };
    }
    case "sourceRecordAccepted": {
      const record = withReadingOverride(action.record, state.readingOverrides);
      return {
        ...state,
        sourceDetails: {
          ...state.sourceDetails,
          [record.sourceId]: keepPersonalFields(record, state.sourceDetails[record.sourceId]),
        },
        ...(state.overview ? { overview: acceptRecordIntoOverview(state.overview, record) } : {}),
      };
    }
    case "sourceRemoved": {
      const sourceDetails = { ...state.sourceDetails };
      delete sourceDetails[action.sourceId];
      return {
        ...state,
        sourceDetails,
        overview: state.overview
          ? {
              ...state.overview,
              records: state.overview.records.filter(
                (record) => record.sourceId !== action.sourceId,
              ),
              recordDiagnostics: state.overview.recordDiagnostics.filter(
                (entry) => entry.sourceId !== action.sourceId,
              ),
            }
          : state.overview,
      };
    }
    case "readingStateArrived": {
      const changes = new Map(action.result.sources.map((entry) => [entry.sourceId, entry]));
      const readingOverrides = { ...state.readingOverrides };
      for (const entry of action.result.sources) {
        if (entry.outcome === "not-found") continue;
        if (entry.readingStatus === undefined && entry.starred === undefined) continue;
        readingOverrides[entry.sourceId] = {
          ...readingOverrides[entry.sourceId],
          ...(entry.readingStatus !== undefined ? { readingStatus: entry.readingStatus } : {}),
          ...(entry.starred !== undefined ? { starred: entry.starred } : {}),
          atOverviewRequest: state.overviewRequest,
        };
      }
      return {
        ...state,
        readingOverrides,
        sourceDetails: Object.fromEntries(
          Object.entries(state.sourceDetails).map(([sourceId, detail]) => [
            sourceId,
            withReadingState(detail, changes),
          ]),
        ),
        overview: state.overview
          ? {
              ...state.overview,
              records: state.overview.records.map((record) => withReadingState(record, changes)),
            }
          : state.overview,
      };
    }
    case "zoteroStatusArrived":
      return {
        ...state,
        zoteroStatus: action.status,
        zoteroCheckFeedback: action.feedback,
      };
    case "zoteroLibraryArrived": {
      // Only the newest Zotero search wins; an overview refresh or import
      // progress cannot invalidate a browse response.
      if (action.request !== state.zoteroRequest) return state;
      const page = action.page;
      if (page.start === 0 || !state.library) return { ...state, library: page };
      const items = [...state.library.items];
      const seen = new Set(items.map((item) => item.sourceKey));
      for (const item of page.items) {
        if (!seen.has(item.sourceKey)) items.push(item);
      }
      return { ...state, library: { ...page, items, start: 0 } };
    }
    case "zoteroLibrarySeeded":
      // Local placeholder with no request behind it; never gated.
      return { ...state, library: action.page };
    case "zoteroScopeChanged":
      return { ...state, zoteroScope: action.scope };
    case "zoteroGroupChanged":
      return { ...state, zoteroGroupId: action.groupId, zoteroCollections: [] };
    case "zoteroCollectionsArrived":
      return { ...state, zoteroCollections: action.collections };
    case "zoteroLibraryClosed":
      return { ...state, library: null };
    case "zoteroStatusDismissed":
      return { ...state, zoteroStatus: null, zoteroCheckFeedback: null };
    case "zoteroCheckFeedbackChanged":
      return { ...state, zoteroCheckFeedback: action.feedback };
    case "importReviewDismissed":
      return { ...state, preflight: null, preflightAdapter: null };
    case "operationCleared":
      // An intake flow is starting; drop any previous operation summary so it
      // cannot render alongside the new preparation banner.
      return { ...state, operation: null };
    case "importPreparationChanged":
      return {
        ...state,
        importPreparation: action.preparation,
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
    case "preflightArrived": {
      if (!isCurrent(state, action.request)) return state;
      return {
        ...state,
        preflight: action.preflight,
        preflightAdapter: action.adapter,
        importPreparation: null,
      };
    }
    case "operationArrived": {
      if (!isCurrent(state, action.request)) return state;
      return {
        ...state,
        operation: action.operation,
        importPreparation: null,
        ...(action.clearLibrary ? { library: null } : {}),
        ...(action.clearPreflight ? { preflight: null, preflightAdapter: null } : {}),
      };
    }
    case "busyChanged":
      return { ...state, busy: action.busy };
    case "cancellingChanged":
      return { ...state, cancelling: action.cancelling };
    case "checkingZoteroChanged":
      return { ...state, checkingZotero: action.checking };
    case "errorArrived":
      return { ...state, error: action.error };
    case "errorCleared":
      return { ...state, error: null };
  }
}

export const emptyZoteroPage = (scope: ZoteroImportScope): ZoteroLibraryPage => ({
  scope,
  items: [],
  start: 0,
  nextStart: 0,
  total: 0,
  hasMore: false,
});

function singleImportedSourceId(operation: ScientSourceImportOperation): string | null {
  if (operation.items.length !== 1) return null;
  const item = operation.items[0];
  return item?.state === "imported" ? item.sourceId : null;
}

export function importOutcomeFromOperation(input: {
  readonly operation: ScientSourceImportOperation;
  readonly priorCounts?: ScientSourcesImportCounts;
  readonly revealSingleSource: boolean;
}): ScientSourcesImportOutcome {
  const counts = completedImportCounts(input.operation, input.priorCounts);
  return {
    kind:
      counts.imported > 0
        ? "imported"
        : counts.alreadyPresent > 0 && counts.reviewRequired === 0
          ? "already-present"
          : "review-required",
    operation: input.operation,
    sourceId: input.revealSingleSource ? singleImportedSourceId(input.operation) : null,
    existingSourceId: null,
    counts,
  };
}

export { preflightImportCounts as workflowPreflightImportCounts } from "./importOutcome";
export { reviewedImportCounts as workflowReviewedImportCounts } from "./importOutcome";
