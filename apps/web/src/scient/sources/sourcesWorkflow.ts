import type {
  ScientSourceDetailResult,
  ScientSourceImportOperation,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
  ZoteroCollection,
  ZoteroConnectionStatus,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@t3tools/contracts";

import {
  completedImportCounts,
  preflightImportCounts,
  reviewedImportCounts,
  type ScientSourcesImportCounts,
  type ScientSourcesImportOutcome,
} from "./importOutcome";

/**
 * Transient Sources workflow state.
 *
 * The durable server operation stays the only authority for import phase,
 * per-item states, retries, and resumability; this reducer only tracks what
 * the panel presents between server snapshots: which request is current, what
 * transient feedback is visible, and which records are known. Every action
 * carries the request token that produced it, and stale tokens are dropped,
 * so a late network response can never overwrite newer state.
 */

export type ImportPreparation =
  | { readonly kind: "local-files"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "zotero"; readonly count: number };

export interface SourcesWorkflowState {
  readonly request: number;
  readonly overview: ScientSourcesOverviewResult | null;
  readonly sourceDetails: Readonly<Record<string, ScientSourceDetailResult>>;
  readonly zoteroStatus: ZoteroConnectionStatus | null;
  readonly library: ZoteroLibraryPage | null;
  readonly zoteroCollections: ReadonlyArray<ZoteroCollection>;
  readonly zoteroScope: ZoteroImportScope;
  readonly preflight: ScientSourcesPreflightResult | null;
  readonly preflightAdapter: "zotero" | "local-files" | null;
  readonly operation: ScientSourceImportOperation | null;
  readonly busy: boolean;
  readonly importPreparation: ImportPreparation | null;
  readonly checkingZotero: boolean;
  readonly zoteroCheckFeedback: string | null;
  readonly cancelling: boolean;
  readonly error: string | null;
}

export const initialSourcesWorkflowState: SourcesWorkflowState = {
  request: 0,
  overview: null,
  sourceDetails: {},
  zoteroStatus: null,
  library: null,
  zoteroCollections: [],
  zoteroScope: { kind: "library" },
  preflight: null,
  preflightAdapter: null,
  operation: null,
  busy: false,
  importPreparation: null,
  checkingZotero: false,
  zoteroCheckFeedback: null,
  cancelling: false,
  error: null,
};

export type SourcesWorkflowAction =
  | { readonly type: "contextReset" }
  | { readonly type: "requestStarted" }
  | {
      readonly type: "overviewArrived";
      readonly request: number;
      readonly overview: ScientSourcesOverviewResult;
    }
  | {
      readonly type: "sourceDetailArrived";
      readonly request: number;
      readonly sourceId: string;
      readonly detail: ScientSourceDetailResult;
    }
  | { readonly type: "sourceRecordAccepted"; readonly record: ScientSourceDetailResult }
  | { readonly type: "sourceRemoved"; readonly sourceId: string }
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
  | { readonly type: "zoteroScopeChanged"; readonly scope: ZoteroImportScope }
  | {
      readonly type: "zoteroCollectionsArrived";
      readonly collections: ReadonlyArray<ZoteroCollection>;
    }
  | { readonly type: "zoteroLibraryClosed" }
  | { readonly type: "zoteroCheckFeedbackChanged"; readonly feedback: string | null }
  | { readonly type: "importReviewDismissed" }
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

function currentRequest(state: SourcesWorkflowState): number {
  return state.request;
}

/** A response belongs to the present only if its token is still current. */
function isCurrent(state: SourcesWorkflowState, request: number): boolean {
  return request === currentRequest(state);
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
  };
  return { ...overview, records };
}

function pruneSourceDetails(
  details: SourcesWorkflowState["sourceDetails"],
  overview: ScientSourcesOverviewResult,
): SourcesWorkflowState["sourceDetails"] {
  return Object.fromEntries(
    Object.entries(details).filter(([sourceId, detail]) =>
      overview.records.some(
        (summary) => summary.sourceId === sourceId && summary.revision === detail.revision,
      ),
    ),
  );
}

export function sourcesWorkflowReducer(
  state: SourcesWorkflowState,
  action: SourcesWorkflowAction,
): SourcesWorkflowState {
  switch (action.type) {
    case "contextReset": {
      // A new project context invalidates every in-flight request at once.
      return { ...initialSourcesWorkflowState, request: state.request + 1 };
    }
    case "requestStarted":
      return { ...state, request: state.request + 1 };
    case "overviewArrived": {
      if (!isCurrent(state, action.request)) return state;
      return {
        ...state,
        overview: action.overview,
        sourceDetails: pruneSourceDetails(state.sourceDetails, action.overview),
        operation: action.overview.activeOperation ?? state.operation,
      };
    }
    case "sourceDetailArrived": {
      if (!isCurrent(state, action.request)) return state;
      return {
        ...state,
        sourceDetails: {
          ...state.sourceDetails,
          [action.sourceId]: action.detail,
        },
      };
    }
    case "sourceRecordAccepted": {
      return {
        ...state,
        sourceDetails: {
          ...state.sourceDetails,
          [action.record.sourceId]: action.record,
        },
        ...(state.overview
          ? { overview: acceptRecordIntoOverview(state.overview, action.record) }
          : {}),
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
    case "zoteroStatusArrived":
      return {
        ...state,
        zoteroStatus: action.status,
        zoteroCheckFeedback: action.feedback,
      };
    case "zoteroLibraryArrived": {
      if (!isCurrent(state, action.request)) return state;
      const page = action.page;
      if (page.start === 0 || !state.library) return { ...state, library: page };
      const items = [...state.library.items];
      const seen = new Set(items.map((item) => item.sourceKey));
      for (const item of page.items) {
        if (!seen.has(item.sourceKey)) items.push(item);
      }
      return { ...state, library: { ...page, items, start: 0 } };
    }
    case "zoteroScopeChanged":
      return { ...state, zoteroScope: action.scope };
    case "zoteroCollectionsArrived":
      return { ...state, zoteroCollections: action.collections };
    case "zoteroLibraryClosed":
      return { ...state, library: null };
    case "zoteroCheckFeedbackChanged":
      return { ...state, zoteroCheckFeedback: action.feedback };
    case "importReviewDismissed":
      return { ...state, preflight: null, preflightAdapter: null };
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

export const workflowPreflightImportCounts = preflightImportCounts;
export const workflowReviewedImportCounts = reviewedImportCounts;
