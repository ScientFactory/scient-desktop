import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourceImportOperation,
  ScientSourcesFileImportResult,
  ScientSourcesPreflightResult,
  ScientSourcesOverviewResult,
  ScientSourcesReadingStateResult,
  ScientSourcesScope,
  ZoteroConnection,
  ZoteroImportScope,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import {
  advanceSourcesImport,
  beginLocalSourcesImport,
  beginZoteroItemsImport,
  beginZoteroScopeImport,
  cancelSourcesImport,
  discardLocalSourcePdfs,
  preflightZoteroItems,
  readScientSources,
  readScientSource,
  refreshScientSourceMetadata,
  removeScientSource,
  retrySourcesImport,
  updateScientSourceNote,
  readZoteroLibrary,
  readZoteroCollections,
  readZoteroStatus,
  uploadLocalSourcePdf,
  importScientSourcesFile,
} from "./client";
import { sourcesErrorMessage } from "./errorMessage";
import { sourceNoteSaveCheck, type SourceNoteSaveContext } from "./SourceNote";
import {
  isExactSourceDuplicate,
  type ScientSourcesImportOutcome,
  type ScientSourcesImportCounts,
} from "./importOutcome";
import { continueSourceImport, stopSourceImportContinuation } from "./importPipeline";
import {
  emptyZoteroPage,
  importOutcomeFromOperation,
  initialSourcesWorkflowState,
  samePinState,
  sourcesWorkflowReducer,
  workflowPreflightImportCounts,
  workflowReviewedImportCounts,
} from "./sourcesWorkflow";

export type { ScientSourcesImportOutcome } from "./importOutcome";
export type { ImportPreparation } from "./sourcesWorkflow";

const DEFAULT_ZOTERO_SCOPE: ZoteroImportScope = { kind: "library" };

function singleMatchingSourceId(preflight: ScientSourcesPreflightResult): string | null {
  if (preflight.items.length !== 1) return null;
  const matchingSourceIds = preflight.items[0]?.duplicate.matchingSourceIds ?? [];
  return matchingSourceIds.length === 1 ? (matchingSourceIds[0] ?? null) : null;
}

/**
 * The durable server operation owns import state, retries, and resumability. Keep independent
 * request-token lanes for import, overview, and Zotero so late presentation responses cannot
 * overwrite newer state.
 */
export function useScientSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** The scope listed until one is chosen; "library" where no project is open. */
  readonly defaultScope?: ScientSourcesScope;
}) {
  const [state, dispatch] = useReducer(sourcesWorkflowReducer, initialSourcesWorkflowState);
  const mounted = useRef(true);
  const stagedLocalKeys = useRef<ReadonlyArray<string>>([]);
  const contextKey = `${input.environmentId}\0${input.root}`;
  const contextKeyRef = useRef(contextKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps contextKeyRef holding the current context key
  useLayoutEffect(() => {
    contextKeyRef.current = contextKey;
  }, [contextKey]);
  // Issue tokens synchronously in refs: reducer dispatch commits next render and would yield stale
  // tokens. Keep import, overview, and Zotero lanes independent so routine refreshes cannot
  // invalidate import progress.
  const requestRef = useRef(0);
  /** The finished parts of the large Zotero import this panel is showing. */
  const runSoFar = useRef<{
    readonly runId: string;
    readonly items: Array<ScientSourceImportOperation["items"][number]>;
    notBrought?: ScientSourceImportOperation["notBrought"];
  } | null>(null);
  const overviewRequestRef = useRef(0);
  /** The last full list of each scope here, reused when the server says it is unchanged. */
  const heldOverviews = useRef(new Map<string, ScientSourcesOverviewResult>());
  const zoteroRequestRef = useRef(0);
  const detailFetchRef = useRef(0);
  // Collections of a library the person already left must not replace the current ones.
  const zoteroLibraryRef = useRef(0);
  const nextRequestToken = useStableCallback(() => {
    requestRef.current += 1;
    return requestRef.current;
  });
  const nextOverviewRequestToken = useStableCallback(() => {
    overviewRequestRef.current += 1;
    return overviewRequestRef.current;
  });
  const nextZoteroRequestToken = useStableCallback(() => {
    zoteroRequestRef.current += 1;
    return zoteroRequestRef.current;
  });
  // Only a server that offers scopes shows the choice, so under a project server this stays unset.
  const scopeRef = useRef<{ readonly context: string; readonly scope: ScientSourcesScope } | null>(
    null,
  );
  /** The scope of the list last shown; a failed switch goes back to it. */
  const acceptedScopeRef = useRef<{
    readonly context: string;
    readonly scope: ScientSourcesScope;
  } | null>(null);
  /** The scope asked for, rendered: the switch shows it at once, pending until its list comes. */
  const [requested, setRequested] = useState<{
    readonly context: string;
    readonly scope: ScientSourcesScope;
  } | null>(null);
  const inLibraryView = () =>
    scopeRef.current?.context === contextKeyRef.current
      ? scopeRef.current.scope === "library"
      : input.defaultScope === "library";
  // Started from the Library view, an import brings sources in without pinning them here. The
  // view is the one shown when the import began, never one still loading.
  const pinInput = () => (state.overview?.scopes?.listed === "library" ? { pin: false } : {});
  const isCurrentContext = () => mounted.current && contextKeyRef.current === contextKey;
  const isCurrentRequest = (request: number) =>
    isCurrentContext() && requestRef.current === request;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted state for async callbacks
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards staged local source PDFs on unmount or environment change
  useEffect(() => {
    const environmentId = input.environmentId;
    const root = input.root;
    return () => {
      const itemKeys = stagedLocalKeys.current;
      stagedLocalKeys.current = [];
      if (itemKeys.length === 0) return;
      void discardLocalSourcePdfs(environmentId, { root, itemKeys }).catch(() => undefined);
    };
  }, [input.environmentId, input.root]);

  /** Rejects on failure; the failure is also kept as `overviewError`, apart from action errors. */
  const refreshOverview = useStableCallback(async () => {
    // The overview lane is independent of imports: live-refresh repeats this
    // call while a durable import runs, and neither may starve the other.
    const request = nextOverviewRequestToken();
    dispatch({ type: "overviewRequestStarted", request });
    const scope = inLibraryView() ? "library" : undefined;
    const heldKey = `${contextKey}\0${scope ?? ""}`;
    const held = heldOverviews.current.get(heldKey);
    return await readScientSources(input.environmentId, input.root, scope, held?.revision).then(
      (answer) => {
        // Same revision: the rows, collections and notices held are this answer's.
        const { unchanged, ...fresh } = answer;
        const next: ScientSourcesOverviewResult =
          unchanged && held
            ? {
                ...fresh,
                records: held.records,
                recordDiagnostics: held.recordDiagnostics,
                ...(held.organization ? { organization: held.organization } : {}),
                ...(held.noticeChanges ? { noticeChanges: held.noticeChanges } : {}),
              }
            : fresh;
        // A late reply for a context or request already left changes neither the screen nor
        // the lists held.
        if (isCurrentContext() && overviewRequestRef.current === request) {
          if (next.revision) {
            // One context at a time: a list of the context left behind is never kept.
            for (const key of heldOverviews.current.keys()) {
              if (!key.startsWith(`${contextKey}\0`)) heldOverviews.current.delete(key);
            }
            heldOverviews.current.set(heldKey, next);
          }
          if (next.scopes)
            acceptedScopeRef.current = { context: contextKey, scope: next.scopes.listed };
          dispatch({ type: "overviewArrived", request, overview: next });
        }
        return next;
      },
      (cause: unknown) => {
        if (isCurrentContext())
          dispatch({ type: "overviewFailed", request, error: sourcesErrorMessage(cause) });
        throw cause;
      },
    );
  });

  /** A read: it shows as `overviewLoading`, never as `busy`, and leaves action errors alone. */
  const reloadOverview = () => refreshOverview().catch(() => null);
  /** After a change, the list is read again; a failed read is already `overviewError`. */
  const refreshAfterChange = () => refreshOverview().catch(() => undefined);

  const acceptSourceRecord = (record: ScientSourceDetailResult) => {
    dispatch({ type: "sourceRecordAccepted", record });
    // The personal note on screen may be older than this revision; read it again.
    const shown = state.sourceDetails[record.sourceId];
    if (
      shown &&
      "personalNote" in shown &&
      !("personalNote" in record) &&
      shown.revision !== record.revision
    ) {
      const atDetailFetch = ++detailFetchRef.current;
      void readScientSource(input.environmentId, { root: input.root, sourceId: record.sourceId })
        .then((detail) => {
          if (isCurrentContext()) {
            dispatch({
              type: "sourceDetailArrived",
              sourceId: record.sourceId,
              detail,
              atDetailFetch,
            });
          }
        })
        .catch(() => undefined);
    }
  };

  /** With a review ID, the review's own record: from its snapshot when the Library lacks it. */
  const loadSource = async (
    sourceId: string,
    reviewId?: string,
  ): Promise<ScientSourceDetailResult> => {
    const cached = state.sourceDetails[sourceId];
    const summary = state.overview?.records.find((record) => record.sourceId === sourceId);
    // Review snapshots and Library details (kept copies, review holder names) read project files
    // whose changes do not bump the source's revision, so they always revalidate.
    if (
      !reviewId &&
      state.overview?.scopes === undefined &&
      cached &&
      summary?.revision === cached.revision &&
      samePinState(summary, cached)
    ) {
      return cached;
    }
    const atDetailFetch = ++detailFetchRef.current;
    try {
      const detail = await readScientSource(input.environmentId, {
        root: input.root,
        sourceId,
        ...(reviewId ? { reviewId } : {}),
      });
      if (isCurrentContext()) {
        dispatch({ type: "sourceDetailArrived", sourceId, detail, atDetailFetch });
      }
      return detail;
    } catch (cause) {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
      throw cause;
    }
  };

  const refreshSourceMetadata = async (sourceId: string, expectedRevision: number) => {
    const result = await refreshScientSourceMetadata(input.environmentId, {
      root: input.root,
      sourceId,
      expectedRevision,
    });
    if (isCurrentContext() && result.outcome === "stale") {
      acceptSourceRecord(result.record);
    }
    return result;
  };

  /** `refresh: false` leaves reading the list again to the caller, once after many removals. */
  const removeSource = async (
    sourceId: string,
    expectedRevision: number,
    options: { readonly refresh?: boolean } = {},
  ) => {
    dispatch({ type: "removalStarted" });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const result = await removeScientSource(input.environmentId, {
        root: input.root,
        sourceId,
        expectedRevision,
      });
      if (isCurrentContext() && result.outcome !== "stale") {
        dispatch({ type: "sourceRemoved", sourceId });
      }
      if (isCurrentContext() && options.refresh !== false) await refreshAfterChange();
      return result;
    })()
      .catch(async (cause) => {
        const safeMessage = sourcesErrorMessage(cause);
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: safeMessage });
        throw new Error(safeMessage, { cause });
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "removalSettled" });
      });
  };

  const saveSourceNote = async (
    sourceId: string,
    expectedRevision: number,
    note: string | null,
    context?: SourceNoteSaveContext,
  ) => {
    const result = await updateScientSourceNote(input.environmentId, {
      root: input.root,
      sourceId,
      expectedRevision,
      note,
      ...(context ? sourceNoteSaveCheck(context) : {}),
    });
    if (isCurrentContext()) acceptSourceRecord(result.record);
    return result;
  };

  const resetSourceContext = useStableCallback((expectedContext: string) => {
    if (expectedContext !== contextKey) return;
    // Each context transition invalidates all independent request lanes.
    dispatch({
      type: "contextReset",
      request: nextRequestToken(),
      overviewRequest: nextOverviewRequestToken(),
      zoteroRequest: nextZoteroRequestToken(),
    });
    void refreshAfterChange();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the module-level source context when the context key changes
  useEffect(() => {
    resetSourceContext(contextKey);
  }, [contextKey, resetSourceContext]);

  const checkZotero = async (showRetryFeedback: boolean) => {
    dispatch({ type: "checkingZoteroChanged", checking: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const status = await readZoteroStatus(input.environmentId);
      if (isCurrentContext()) {
        dispatch({
          type: "zoteroStatusArrived",
          status,
          feedback:
            showRetryFeedback && status.state !== "ready"
              ? status.connection === "web"
                ? status.message
                : status.state === "unreachable"
                  ? "Zotero is still unavailable. Make sure it is open on the computer running this project."
                  : status.state === "access-disabled"
                    ? "Local access is still turned off in Zotero."
                    : status.state === "incompatible"
                      ? "This Zotero version is still not compatible with Scient."
                      : "Zotero responded, but its local API still could not be verified."
              : null,
        });
      }
      return status;
    })()
      .catch(async (cause) => {
        if (isCurrentContext()) {
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
          if (showRetryFeedback) {
            dispatch({
              type: "zoteroCheckFeedbackChanged",
              feedback: "Scient could not check Zotero. Please try again.",
            });
          }
        }
        return null;
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "checkingZoteroChanged", checking: false });
      });
  };

  const zoteroConnection = state.zoteroStatus?.connection;
  const zoteroGroupId = state.zoteroGroupId ?? undefined;
  const zoteroGroupInput = zoteroGroupId ? { groupId: zoteroGroupId } : {};

  const searchZotero = async (
    query: string,
    start = 0,
    scopeInput?: ZoteroImportScope,
    connection: ZoteroConnection | undefined = zoteroConnection,
    groupId: string | undefined = zoteroGroupId,
  ) => {
    const scope = scopeInput ?? state.zoteroScope;
    // The Zotero browse lane is independent of imports and overview loads.
    const request = nextZoteroRequestToken();
    dispatch({ type: "zoteroRequestStarted", request });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const page = await readZoteroLibrary(input.environmentId, {
        scope,
        query,
        start,
        limit: 50,
        ...(connection ? { connection } : {}),
        ...(groupId ? { groupId } : {}),
      });
      if (isCurrentContext() && zoteroRequestRef.current === request) {
        dispatch({ type: "zoteroLibraryArrived", request, query, page });
      }
    })()
      .catch(async (cause) => {
        if (isCurrentContext() && zoteroRequestRef.current === request) {
          dispatch({
            type: "errorArrived",
            error: sourcesErrorMessage(cause),
            retry: () => searchZotero(query, start, scope, connection, groupId),
          });
        }
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "zoteroRequestSettled", request });
      });
  };

  const showZoteroLibrary = async (
    connection: ZoteroConnection | undefined,
    groupId: string | null,
  ) => {
    const libraryRequest = ++zoteroLibraryRef.current;
    dispatch({ type: "zoteroGroupChanged", groupId });
    dispatch({ type: "zoteroScopeChanged", scope: DEFAULT_ZOTERO_SCOPE });
    dispatch({ type: "zoteroLibrarySeeded", page: emptyZoteroPage(DEFAULT_ZOTERO_SCOPE) });
    try {
      const [collections] = await Promise.all([
        readZoteroCollections(input.environmentId, connection, groupId ?? undefined),
        searchZotero("", 0, DEFAULT_ZOTERO_SCOPE, connection, groupId ?? undefined),
      ]);
      if (isCurrentContext() && zoteroLibraryRef.current === libraryRequest) {
        dispatch({ type: "zoteroCollectionsArrived", collections: collections.collections });
      }
    } catch (cause) {
      if (isCurrentContext() && zoteroLibraryRef.current === libraryRequest) {
        dispatch({
          type: "errorArrived",
          error: sourcesErrorMessage(cause),
          retry: () => showZoteroLibrary(connection, groupId),
        });
      }
    }
  };

  const openZoteroLibrary = async (showRetryFeedback = false) => {
    const status = await checkZotero(showRetryFeedback);
    if (status?.state === "ready" && isCurrentContext()) {
      const firstGroup = status.myLibrary === false ? status.groups?.[0]?.groupId : undefined;
      await showZoteroLibrary(status.connection, firstGroup ?? null);
    }
    return status;
  };

  /** My Library (null) or one of the groups the connection can read. */
  const selectZoteroLibrary = (groupId: string | null) =>
    showZoteroLibrary(zoteroConnection, groupId);

  const selectZoteroScope = async (scope: ZoteroImportScope) => {
    dispatch({ type: "zoteroScopeChanged", scope });
    dispatch({ type: "zoteroLibrarySeeded", page: emptyZoteroPage(scope) });
    await searchZotero("", 0, scope);
  };

  /** Begins the next part of a large Zotero import; its record says what it brings. */
  const beginNextZoteroPart = (runId: string, retryFailed = false) =>
    beginZoteroScopeImport(input.environmentId, {
      root: input.root,
      continueRun: runId,
      ...(retryFailed ? { retryFailed } : {}),
    });

  /**
   * A part of a large import as the panel shows it: with the parts before it, so the counts
   * and lists are the whole import's. A reference a later part took again (after a stop, or
   * a failure tried again) counts once, as it was left last.
   */
  const wholeRun = (part: ScientSourceImportOperation): ScientSourceImportOperation => {
    const before = runSoFar.current;
    if (!part.run || before?.runId !== part.run.runId || before.items.length === 0) return part;
    const items = new Map([...before.items, ...part.items].map((item) => [item.itemKey, item]));
    return {
      ...part,
      items: [...items.values()],
      ...(before.notBrought ? { notBrought: before.notBrought } : {}),
    };
  };

  /**
   * Imports a Zotero scope to its end. A scope too large for one operation comes as a run of
   * parts: when a part completes and something remains, the next is begun. `begin` starts
   * the first part to run here; `shown` is the same run's summary when one is on screen.
   */
  const runZoteroScope = async (
    request: number,
    begin: () => Promise<ScientSourceImportOperation>,
    shown: ScientSourceImportOperation | null,
  ): Promise<ScientSourceImportOperation> => {
    let next = await begin();
    // Nothing was left to bring: the part shown comes back, and what is shown stays.
    if (shown && next.operationId === shown.operationId && next.state !== "running") {
      return { ...shown, ...(next.run ? { run: next.run } : {}) };
    }
    if (next.run && runSoFar.current?.runId !== next.run.runId) {
      runSoFar.current = { runId: next.run.runId, items: [] };
    }
    for (let first = true; ; first = false) {
      if (isCurrentRequest(request)) {
        dispatch({
          type: "operationArrived",
          request,
          operation: wholeRun(next),
          ...(first && shown === null ? { clearLibrary: true } : {}),
        });
      }
      next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation: next,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: (value) => {
          if (isCurrentRequest(request)) {
            dispatch({ type: "operationArrived", request, operation: wholeRun(value) });
          }
        },
      });
      const { run } = next;
      if (next.state !== "completed" || !run || run.remaining === 0 || !isCurrentRequest(request)) {
        return wholeRun(next);
      }
      const began = await beginNextZoteroPart(run.runId);
      // Nothing was left after all: the same part comes back, with nothing remaining.
      if (began.operationId === next.operationId) return wholeRun(began);
      const before = runSoFar.current;
      if (before?.runId === run.runId) {
        before.items.push(...next.items);
        // What belongs to no reference was counted once, with the first part.
        if (!before.notBrought && next.notBrought) before.notBrought = next.notBrought;
      }
      next = began;
    }
  };

  const zoteroScopeImport = async (
    preparation: { readonly kind: "zotero"; readonly count: number },
    begin: () => Promise<ScientSourceImportOperation>,
    shown: ScientSourceImportOperation | null,
  ): Promise<ScientSourcesImportOutcome | null> => {
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({ type: "importPreparationChanged", preparation });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const next = await runZoteroScope(request, begin, shown);
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: next });
        await refreshAfterChange();
      }
      return importOutcomeFromOperation({ operation: next, revealSingleSource: false });
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request)) {
          dispatch({
            type: "errorArrived",
            error: sourcesErrorMessage(cause),
            retry: () => zoteroScopeImport(preparation, begin, shown),
          });
        }
        return null;
      })
      .finally(() => {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      });
  };

  const importZoteroScope = async (): Promise<ScientSourcesImportOutcome | null> => {
    const count = state.zoteroScopeTotal ?? 0;
    if (count === 0) return null;
    dispatch({ type: "operationCleared" });
    // Once per import, so Try again after a lost answer goes on with the import already begun.
    const operationId = randomUUID();
    return zoteroScopeImport(
      { kind: "zotero", count },
      () =>
        beginZoteroScopeImport(input.environmentId, {
          root: input.root,
          operationId,
          scope: state.zoteroScope,
          ...(zoteroConnection ? { connection: zoteroConnection } : {}),
          ...zoteroGroupInput,
          ...pinInput(),
        }),
      null,
    );
  };

  /** How many references of a large Zotero import are still to come after the part shown. */
  const zoteroRunRemaining = (() => {
    const operation = state.operation;
    return !operation?.run || operation.state === "running" ? 0 : operation.run.remaining;
  })();

  /** Goes on with a large Zotero import from its line in Recent changes. */
  const importZoteroRun = (runId: string, count: number) =>
    zoteroScopeImport({ kind: "zotero", count }, () => beginNextZoteroPart(runId), null);

  /** Goes on with a large Zotero import that stopped part way. */
  const importZoteroRest = async (): Promise<ScientSourcesImportOutcome | null> => {
    const operation = state.operation;
    const run = operation?.run;
    if (!operation || !run || zoteroRunRemaining === 0) return null;
    return zoteroScopeImport(
      { kind: "zotero", count: zoteroRunRemaining },
      () => beginNextZoteroPart(run.runId),
      operation,
    );
  };

  /** Imports a .bib, RIS, CSL-JSON or EndNote XML file; entries already in the Library are left out. */
  const importReferenceFile = async (
    file: File,
  ): Promise<{
    readonly outcome: ScientSourcesImportOutcome | null;
    readonly report: ScientSourcesFileImportResult["report"];
  } | null> => {
    dispatch({ type: "operationCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({ type: "importPreparationChanged", preparation: { kind: "file", name: file.name } });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const begun = await importScientSourcesFile(input.environmentId, {
        root: input.root,
        operationId: randomUUID(),
        file,
        ...pinInput(),
      });
      const priorCounts = {
        imported: 0,
        alreadyPresent: begun.report.alreadyInLibrary,
        reviewRequired: 0,
        failed: 0,
      };
      if (!begun.operation) {
        return {
          report: begun.report,
          outcome:
            priorCounts.alreadyPresent > 0
              ? {
                  kind: "already-present" as const,
                  operation: null,
                  sourceId: null,
                  existingSourceId: null,
                  counts: priorCounts,
                }
              : null,
        };
      }
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: begun.operation });
      }
      const next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation: begun.operation,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: (value) => {
          if (isCurrentRequest(request)) {
            dispatch({ type: "operationArrived", request, operation: value });
          }
        },
      });
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: next });
        await refreshAfterChange();
      }
      return {
        report: begun.report,
        outcome: importOutcomeFromOperation({
          operation: next,
          revealSingleSource: false,
          priorCounts,
        }),
      };
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request))
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
        return null;
      })
      .finally(() => {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      });
  };

  const executeImport = async (options: {
    readonly adapter: "zotero" | "local-files";
    readonly itemKeys: ReadonlyArray<string>;
    readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
    readonly allLocalItemKeys?: ReadonlyArray<string>;
    readonly request: number;
    readonly revealSingleSource: boolean;
    readonly priorCounts?: ScientSourcesImportCounts;
    readonly onStarted?: () => void;
  }): Promise<ScientSourcesImportOutcome> => {
    const begin =
      options.adapter === "local-files" ? beginLocalSourcesImport : beginZoteroItemsImport;
    let next = await begin(input.environmentId, {
      root: input.root,
      operationId: randomUUID(),
      itemKeys: options.itemKeys,
      possibleMetadataMatchOverrides: options.possibleMetadataMatchOverrides,
      ...(options.adapter === "zotero" && zoteroConnection ? { connection: zoteroConnection } : {}),
      ...(options.adapter === "zotero" ? zoteroGroupInput : {}),
      ...pinInput(),
    });
    options.onStarted?.();

    if (options.adapter === "local-files") {
      const selectedKeys = new Set(options.itemKeys);
      const unselectedKeys = (options.allLocalItemKeys ?? []).filter(
        (itemKey) => !selectedKeys.has(itemKey),
      );
      stagedLocalKeys.current = [];
      if (unselectedKeys.length > 0) {
        await discardLocalSourcePdfs(input.environmentId, {
          root: input.root,
          itemKeys: unselectedKeys,
        }).catch(() => undefined);
      }
    }

    if (isCurrentRequest(options.request)) {
      dispatch({
        type: "operationArrived",
        request: options.request,
        operation: next,
        clearLibrary: true,
        clearPreflight: true,
      });
    }
    next = await continueSourceImport({
      environmentId: input.environmentId,
      root: input.root,
      operation: next,
      advance: (operationId) =>
        advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
      onProgress: (value) => {
        if (isCurrentRequest(options.request)) {
          dispatch({ type: "operationArrived", request: options.request, operation: value });
        }
      },
    });

    if (isCurrentRequest(options.request)) {
      dispatch({ type: "operationArrived", request: options.request, operation: next });
      await refreshAfterChange();
    }
    return importOutcomeFromOperation({
      operation: next,
      revealSingleSource: options.revealSingleSource,
      ...(options.priorCounts ? { priorCounts: options.priorCounts } : {}),
    });
  };

  const importPreflight = async (options: {
    readonly adapter: "zotero" | "local-files";
    readonly result: ScientSourcesPreflightResult;
    readonly request: number;
    readonly onStarted?: () => void;
  }): Promise<ScientSourcesImportOutcome | null> => {
    const allItemKeys = options.result.items.map((item) => item.candidate.sourceKey);
    const counts = workflowPreflightImportCounts(options.result);
    const needsDuplicateDecision = options.result.items.some(
      (item) => item.duplicate.kind === "possible-metadata-match",
    );
    if (needsDuplicateDecision) {
      if (isCurrentRequest(options.request)) {
        if (options.adapter === "local-files") stagedLocalKeys.current = allItemKeys;
        dispatch({
          type: "preflightArrived",
          request: options.request,
          preflight: options.result,
          adapter: options.adapter,
        });
      } else if (options.adapter === "local-files") {
        await discardLocalSourcePdfs(input.environmentId, {
          root: input.root,
          itemKeys: allItemKeys,
        }).catch(() => undefined);
      }
      return {
        kind: "review-required",
        operation: null,
        sourceId: null,
        existingSourceId: null,
        counts,
      };
    }

    // A PDF of a paper already here goes in too: it is added to that source if it has no copy.
    const itemKeys = options.result.items.flatMap((item) =>
      item.duplicate.kind === "new" ||
      (options.adapter === "local-files" && isExactSourceDuplicate(item.duplicate.kind))
        ? [item.candidate.sourceKey]
        : [],
    );
    if (itemKeys.length === 0) {
      if (options.adapter === "local-files" && allItemKeys.length > 0) {
        await discardLocalSourcePdfs(input.environmentId, {
          root: input.root,
          itemKeys: allItemKeys,
        }).catch(() => undefined);
      }
      if (isCurrentRequest(options.request)) {
        dispatch({ type: "importPreparationChanged", preparation: null });
        dispatch({ type: "zoteroLibraryClosed" });
        await refreshAfterChange();
      }
      return {
        kind: "already-present",
        operation: null,
        sourceId: null,
        existingSourceId: singleMatchingSourceId(options.result),
        counts,
      };
    }

    return executeImport({
      adapter: options.adapter,
      itemKeys,
      possibleMetadataMatchOverrides: [],
      ...(options.adapter === "local-files" ? { allLocalItemKeys: allItemKeys } : {}),
      request: options.request,
      revealSingleSource: options.result.items.length === 1,
      priorCounts: workflowReviewedImportCounts(options.result, new Set(itemKeys)),
      ...(options.onStarted ? { onStarted: options.onStarted } : {}),
    });
  };

  const previewImport = async (
    itemKeys: ReadonlyArray<string>,
  ): Promise<ScientSourcesImportOutcome | null> => {
    if (itemKeys.length === 0) return null;
    dispatch({ type: "operationCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({
      type: "importPreparationChanged",
      preparation: { kind: "zotero", count: itemKeys.length },
    });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const result = await preflightZoteroItems(input.environmentId, {
        root: input.root,
        itemKeys,
        ...(zoteroConnection ? { connection: zoteroConnection } : {}),
        ...zoteroGroupInput,
      });
      return await importPreflight({ adapter: "zotero", result, request });
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request)) {
          dispatch({
            type: "errorArrived",
            error: sourcesErrorMessage(cause),
            retry: () => previewImport(itemKeys),
          });
        }
        return null;
      })
      .finally(() => {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      });
  };

  const uploadLocalFiles = async (
    files: ReadonlyArray<File>,
  ): Promise<ScientSourcesImportOutcome | null> => {
    if (files.length === 0) return null;
    const validFiles = files.filter(
      (file) =>
        !file.type || file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    const invalidFiles = files.filter((file) => !validFiles.includes(file));
    if (validFiles.length === 0) {
      dispatch({
        type: "errorArrived",
        error:
          invalidFiles.length === 1
            ? invalidFiles.at(0)?.name !== undefined
              ? m(msg("{name} is not a PDF.", { name: invalidFiles.at(0)!.name }))
              : m(msg("The selected file is not a PDF."))
            : m(msg("Choose at least one PDF file.")),
      });
      return null;
    }
    const invalidFilesMessage =
      invalidFiles.length > 0
        ? m(
            msg(
              "{count, plural, one {Skipped {count} non-PDF file.} other {Skipped {count} non-PDF files.}}",
              { count: invalidFiles.length },
            ),
          )
        : null;
    dispatch({ type: "operationCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({
      type: "importPreparationChanged",
      preparation: { kind: "local-files", names: validFiles.map((file) => file.name) },
      error: invalidFilesMessage,
    });
    dispatch({ type: "busyChanged", busy: true });
    const items: ScientSourcesPreflightResult["items"][number][] = [];
    const failedFiles: Array<{ readonly name: string; readonly reason: string }> = [];
    let operationStarted = false;
    return await (async () => {
      for (const file of validFiles) {
        try {
          const result = await uploadLocalSourcePdf(input.environmentId, {
            root: input.root,
            file,
          });
          items.push(result.item);
        } catch (cause) {
          failedFiles.push({ name: file.name, reason: sourcesErrorMessage(cause) });
        }
      }
      if (failedFiles.length > 0 && isCurrentRequest(request)) {
        dispatch({
          type: "errorArrived",
          error: [
            invalidFilesMessage,
            `Skipped ${failedFiles.length} PDF${failedFiles.length === 1 ? "" : "s"} that could not be read: ${failedFiles.map((file) => `${file.name} (${file.reason})`).join(", ")}.`,
          ]
            .filter((value): value is string => value !== null)
            .join(" "),
        });
      }
      if (items.length === 0) {
        return null;
      }
      const uploadedItems = [
        ...new Map(items.map((item) => [item.candidate.sourceKey, item])).values(),
      ];
      return await importPreflight({
        adapter: "local-files",
        result: { items: uploadedItems },
        request,
        onStarted: () => {
          operationStarted = true;
        },
      });
    })()
      .catch(async (cause) => {
        if (!operationStarted && items.length > 0) {
          await discardLocalSourcePdfs(input.environmentId, {
            root: input.root,
            itemKeys: items.map((item) => item.candidate.sourceKey),
          }).catch(() => undefined);
        }
        if (isCurrentRequest(request))
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
        return null;
      })
      .finally(() => {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      });
  };

  const runImport = async (
    itemKeys: ReadonlyArray<string>,
    possibleMetadataMatchOverrides: ReadonlyArray<string>,
  ): Promise<ScientSourcesImportOutcome | null> => {
    const preflight = state.preflight;
    const preflightAdapter = state.preflightAdapter;
    if (!preflight || !preflightAdapter || itemKeys.length === 0) return null;
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "cancellingChanged", cancelling: false });
    dispatch({ type: "errorCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    return await (async () => {
      const selectedKeys = new Set(itemKeys);
      const reviewedCounts = workflowReviewedImportCounts(preflight, selectedKeys);
      return await executeImport({
        adapter: preflightAdapter,
        itemKeys,
        possibleMetadataMatchOverrides,
        ...(preflightAdapter === "local-files"
          ? {
              allLocalItemKeys: preflight.items.map((item) => item.candidate.sourceKey),
            }
          : {}),
        request,
        revealSingleSource: preflight.items.length === 1,
        priorCounts: reviewedCounts,
      });
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request))
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
        return null;
      })
      .finally(() => {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      });
  };

  const resumeImport = async () => {
    const operation = state.operation;
    if (
      !operation ||
      operation.state !== "running" ||
      !operation.items.some((item) => item.state === "pending") ||
      state.busy
    )
      return;
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "cancellingChanged", cancelling: false });
    dispatch({ type: "errorCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    return await (async () => {
      const next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: (value) => {
          if (isCurrentRequest(request)) {
            dispatch({ type: "operationArrived", request, operation: value });
          }
        },
      });
      // A large import that was under way when Scient closed goes on to its end.
      const { run } = next;
      const last =
        next.state === "completed" && run && run.remaining > 0 && isCurrentRequest(request)
          ? await runZoteroScope(request, () => beginNextZoteroPart(run.runId), next)
          : next;
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: last });
        await refreshAfterChange();
      }
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request))
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
      })
      .finally(() => {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes a running import operation when pending items remain
  useEffect(() => {
    const operation = state.operation;
    if (
      !operation ||
      operation.state !== "running" ||
      !operation.items.some((item) => item.state === "pending") ||
      state.busy ||
      state.cancelling
    )
      return;
    void resumeImport();
  }, [resumeImport, state.busy, state.cancelling, state.operation]);

  const cancelImport = async () => {
    const operation = state.operation;
    if (!operation || operation.state !== "running" || state.cancelling) return;
    stopSourceImportContinuation({
      environmentId: input.environmentId,
      projectId: operation.projectId,
      operationId: operation.operationId,
    });
    // Supersede every in-flight import request, including the durable
    // continuation whose progress updates would otherwise keep arriving.
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({ type: "cancellingChanged", cancelling: true });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const cancelled = await cancelSourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
      });
      if (isCurrentContext()) {
        // A stopped part of a large import stays shown with the parts before it.
        dispatch({ type: "operationArrived", request, operation: wholeRun(cancelled) });
        dispatch({ type: "zoteroLibraryClosed" });
        await refreshAfterChange();
      }
    })()
      .catch(async (cause) => {
        if (isCurrentContext())
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
      })
      .finally(() => {
        if (isCurrentContext()) {
          dispatch({ type: "busyChanged", busy: false });
          dispatch({ type: "cancellingChanged", cancelling: false });
        }
      });
  };

  const retryFailedImport = async () => {
    const operation = state.operation;
    if (
      !operation ||
      (operation.state !== "running" && operation.state !== "completed") ||
      state.busy ||
      state.cancelling
    )
      return;
    const itemKeys = operation.items
      .filter((item) => item.state === "failed")
      .map((item) => item.itemKey);
    if (itemKeys.length === 0) return;
    // In a large import the failures may be in any part: a further part takes them again.
    const { run } = operation;
    if (run) {
      await zoteroScopeImport(
        { kind: "zotero", count: itemKeys.length + run.remaining },
        () => beginNextZoteroPart(run.runId, true),
        operation,
      );
      return;
    }
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    return await (async () => {
      const retried = await retrySourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
        itemKeys,
      });
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: retried });
      }
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request))
          dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
      })
      .finally(() => {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      });
  };

  const zoteroLoading = state.zoteroRequest !== state.zoteroSettled;
  return {
    /** Any change or Zotero browse runs; reading the list does not count. */
    busy: state.busy || state.removals > 0 || zoteroLoading,
    /** An import (preparing, running, cancelled or retried here); the Import button's own work. */
    importing: state.busy,
    /** The list is being read; a read never sets `busy`. */
    overviewLoading: state.overviewRequest !== state.overviewSettled,
    /** The newest list read failed; with no `overview` yet, the Library could not be loaded. */
    overviewError: state.overviewError,
    checkingZotero: state.checkingZotero,
    cancelling: state.cancelling,
    error: state.error,
    /** Runs the action behind `error` again; null when it cannot be repeated from here. */
    retryError: state.errorRetry,
    overview: state.overview,
    sourceDetails: state.sourceDetails,
    outdatedDetails: state.outdatedDetails,
    zoteroStatus: state.zoteroStatus,
    zoteroCollections: state.zoteroCollections,
    zoteroScope: state.zoteroScope,
    zoteroGroups: state.zoteroStatus?.groups ?? [],
    zoteroMyLibrary: state.zoteroStatus?.myLibrary !== false,
    zoteroGroupId: state.zoteroGroupId,
    zoteroCheckFeedback: state.zoteroCheckFeedback,
    library: state.library,
    zoteroScopeTotal: state.zoteroScopeTotal,
    preflight: state.preflight,
    preflightAdapter: state.preflightAdapter,
    operation: state.operation,
    importPreparation: state.importPreparation,
    openZoteroLibrary,
    uploadLocalFiles,
    importReferenceFile,
    searchZotero,
    selectZoteroScope,
    selectZoteroLibrary,
    importZoteroScope,
    importZoteroRest,
    importZoteroRun,
    zoteroRunRemaining,
    previewImport,
    runImport,
    cancelImport,
    retryFailedImport,
    refreshOverview,
    reloadOverview,
    /** "This project" (its pins) or the whole Library; only a library server offers the choice. */
    selectScope: async (scope: ScientSourcesScope) => {
      const asked = { context: contextKey, scope };
      scopeRef.current = asked;
      setRequested(asked);
      const answer = await reloadOverview();
      // A switch whose list could not be read goes back to the scope still shown, never to an
      // earlier switch this one superseded.
      if (answer === null && scopeRef.current === asked && isCurrentContext()) {
        const shown =
          acceptedScopeRef.current?.context === contextKey ? acceptedScopeRef.current : null;
        scopeRef.current = shown;
        setRequested(shown);
      }
      return answer;
    },
    /** The scope the switch shows: the one asked for, or the one listed. */
    requestedScope:
      requested?.context === contextKey
        ? requested.scope
        : (state.overview?.scopes?.listed ?? null),
    /** A scope was asked for and its list has not come yet; imports go to the one still shown. */
    switchingScope:
      requested?.context === contextKey &&
      state.overview?.scopes !== undefined &&
      requested.scope !== state.overview.scopes.listed,
    acceptSourceRecord,
    loadSource,
    refreshSourceMetadata,
    saveSourceNote,
    /** Rows and details take a reading change from the route's answer: it changes no revision. */
    applyReadingState: (result: ScientSourcesReadingStateResult) => {
      if (isCurrentContext()) {
        dispatch({
          type: "readingStateArrived",
          result,
          atDetailFetch: detailFetchRef.current,
        });
      }
    },
    removeSource,
    clearError: () => dispatch({ type: "errorCleared" }),
    clearOperationSummary: () => dispatch({ type: "operationCleared" }),
    closeZoteroStatus: () => dispatch({ type: "zoteroStatusDismissed" }),
    closeLibrary: () => dispatch({ type: "zoteroLibraryClosed" }),
    resetImport: () => {
      const current = state.preflight;
      const adapter = state.preflightAdapter;
      dispatch({ type: "importReviewDismissed" });
      if (adapter === "local-files" && current) {
        stagedLocalKeys.current = [];
        void discardLocalSourcePdfs(input.environmentId, {
          root: input.root,
          itemKeys: current.items.map((item) => item.candidate.sourceKey),
        }).catch((cause) => {
          if (isCurrentContext())
            dispatch({ type: "errorArrived", error: sourcesErrorMessage(cause) });
        });
      }
    },
  } as const;
}
