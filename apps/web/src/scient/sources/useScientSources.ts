import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourcesPreflightResult,
  ZoteroImportScope,
} from "@t3tools/contracts";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { randomUUID } from "../../lib/utils";
import {
  advanceSourcesImport,
  approveScientSource,
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
} from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import type { ScientSourcesImportOutcome, ScientSourcesImportCounts } from "./importOutcome";
import { continueSourceImport, stopSourceImportContinuation } from "./importPipeline";
import {
  emptyZoteroPage,
  importOutcomeFromOperation,
  initialSourcesWorkflowState,
  sourcesWorkflowReducer,
  workflowPreflightImportCounts,
  workflowReviewedImportCounts,
} from "./sourcesWorkflow";

export type { ScientSourcesImportOutcome } from "./importOutcome";
export type { ImportPreparation } from "./sourcesWorkflow";

const DEFAULT_ZOTERO_SCOPE: ZoteroImportScope = { kind: "library" };

const message = (error: unknown): string => scientSourcesErrorMessage(error, import.meta.env.DEV);

function singleMatchingSourceId(preflight: ScientSourcesPreflightResult): string | null {
  if (preflight.items.length !== 1) return null;
  const matchingSourceIds = preflight.items[0]?.duplicate.matchingSourceIds ?? [];
  return matchingSourceIds.length === 1 ? (matchingSourceIds[0] ?? null) : null;
}

/**
 * Transient Sources workflow orchestration.
 *
 * The durable server operation remains the only authority for import phase,
 * item states, retries, and resumability. This hook owns presentation
 * transitions only; every network response lands through a request token so a
 * late or superseded response can never overwrite newer state.
 */
export function useScientSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const [state, dispatch] = useReducer(sourcesWorkflowReducer, initialSourcesWorkflowState);
  const mounted = useRef(true);
  const stagedLocalKeys = useRef<ReadonlyArray<string>>([]);
  const contextKey = `${input.environmentId}\0${input.root}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  // Request tokens live in the reducer state; this ref mirrors the current
  // token for imperative guards inside long-running async flows.
  const requestRef = useRef(0);
  requestRef.current = state.request;
  const isCurrentContext = useCallback(
    () => mounted.current && contextKeyRef.current === contextKey,
    [contextKey],
  );
  const isCurrentRequest = useCallback(
    (request: number) => isCurrentContext() && requestRef.current === request,
    [isCurrentContext],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const refreshOverview = useCallback(async () => {
    dispatch({ type: "requestStarted" });
    const request = requestRef.current;
    const next = await readScientSources(input.environmentId, input.root);
    if (isCurrentContext() && requestRef.current === request) {
      dispatch({ type: "overviewArrived", request, overview: next });
    }
    return next;
  }, [input.environmentId, input.root, isCurrentContext]);

  const reloadOverview = useCallback(async () => {
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    try {
      return await refreshOverview();
    } catch (cause) {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
      return null;
    } finally {
      if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
    }
  }, [isCurrentContext, refreshOverview]);

  const acceptSourceRecord = useCallback((record: ScientSourceDetailResult) => {
    dispatch({ type: "sourceRecordAccepted", record });
  }, []);

  const loadSource = useCallback(
    async (sourceId: string): Promise<ScientSourceDetailResult> => {
      const cached = state.sourceDetails[sourceId];
      const summary = state.overview?.records.find((record) => record.sourceId === sourceId);
      if (cached && summary?.revision === cached.revision) return cached;
      try {
        const detail = await readScientSource(input.environmentId, { root: input.root, sourceId });
        if (isCurrentContext()) {
          dispatch({ type: "sourceDetailArrived", request: requestRef.current, sourceId, detail });
        }
        return detail;
      } catch (cause) {
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        throw cause;
      }
    },
    [
      input.environmentId,
      input.root,
      isCurrentContext,
      state.overview?.records,
      state.sourceDetails,
    ],
  );

  const refreshSourceMetadata = useCallback(
    async (sourceId: string, expectedRevision: number) => {
      const result = await refreshScientSourceMetadata(input.environmentId, {
        root: input.root,
        sourceId,
        expectedRevision,
      });
      if (isCurrentContext() && result.outcome === "stale") {
        acceptSourceRecord(result.record);
      }
      return result;
    },
    [acceptSourceRecord, input.environmentId, input.root, isCurrentContext],
  );

  const removeSource = useCallback(
    async (sourceId: string, expectedRevision: number) => {
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "errorCleared" });
      try {
        const result = await removeScientSource(input.environmentId, {
          root: input.root,
          sourceId,
          expectedRevision,
        });
        if (isCurrentContext() && result.outcome !== "stale") {
          dispatch({ type: "sourceRemoved", sourceId });
        }
        if (isCurrentContext()) {
          await refreshOverview().catch((cause: unknown) =>
            dispatch({ type: "errorArrived", error: message(cause) }),
          );
        }
        return result;
      } catch (cause) {
        const safeMessage = message(cause);
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: safeMessage });
        throw new Error(safeMessage, { cause });
      } finally {
        if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
      }
    },
    [input.environmentId, input.root, isCurrentContext, refreshOverview],
  );

  const saveSourceNote = useCallback(
    async (sourceId: string, expectedRevision: number, note: string | null) => {
      const result = await updateScientSourceNote(input.environmentId, {
        root: input.root,
        sourceId,
        expectedRevision,
        note,
      });
      if (isCurrentContext()) acceptSourceRecord(result.record);
      return result;
    },
    [acceptSourceRecord, input.environmentId, input.root, isCurrentContext],
  );

  const approveSource = useCallback(
    async (sourceId: string, expectedRevision: number) => {
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "errorCleared" });
      try {
        const result = await approveScientSource(input.environmentId, {
          root: input.root,
          sourceId,
          expectedRevision,
        });
        if (isCurrentContext()) {
          acceptSourceRecord(result.record);
          await refreshOverview();
        }
        return result;
      } catch (cause) {
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        throw cause;
      } finally {
        if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
      }
    },
    [acceptSourceRecord, input.environmentId, input.root, isCurrentContext, refreshOverview],
  );

  useEffect(() => {
    dispatch({ type: "contextReset" });
    const request = requestRef.current;
    void refreshOverview().catch((cause) => {
      if (requestRef.current === request) dispatch({ type: "errorArrived", error: message(cause) });
    });
  }, [input.environmentId, input.root, refreshOverview]);

  const checkZotero = useCallback(
    async (showRetryFeedback: boolean) => {
      dispatch({ type: "checkingZoteroChanged", checking: true });
      dispatch({ type: "errorCleared" });
      try {
        const status = await readZoteroStatus(input.environmentId);
        if (isCurrentContext()) {
          dispatch({
            type: "zoteroStatusArrived",
            status,
            feedback:
              showRetryFeedback && status.state !== "ready"
                ? status.state === "unreachable"
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
      } catch (cause) {
        if (isCurrentContext()) {
          dispatch({ type: "errorArrived", error: message(cause) });
          if (showRetryFeedback) {
            dispatch({
              type: "zoteroCheckFeedbackChanged",
              feedback: "Scient could not check Zotero. Please try again.",
            });
          }
        }
        return null;
      } finally {
        if (isCurrentContext()) dispatch({ type: "checkingZoteroChanged", checking: false });
      }
    },
    [input.environmentId, isCurrentContext],
  );

  const searchZotero = useCallback(
    async (query: string, start = 0, scope: ZoteroImportScope = state.zoteroScope) => {
      dispatch({ type: "requestStarted" });
      const request = requestRef.current;
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "errorCleared" });
      try {
        const page = await readZoteroLibrary(input.environmentId, {
          scope,
          query,
          start,
          limit: 50,
        });
        if (isCurrentRequest(request)) {
          dispatch({ type: "zoteroLibraryArrived", request, page });
        }
      } catch (cause) {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
      } finally {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      }
    },
    [input.environmentId, isCurrentRequest, state.zoteroScope],
  );

  const openZoteroLibrary = useCallback(
    async (showRetryFeedback = false) => {
      const status = await checkZotero(showRetryFeedback);
      if (status?.state === "ready" && isCurrentContext()) {
        dispatch({ type: "zoteroScopeChanged", scope: DEFAULT_ZOTERO_SCOPE });
        dispatch({
          type: "zoteroLibraryArrived",
          request: requestRef.current,
          page: emptyZoteroPage(DEFAULT_ZOTERO_SCOPE),
        });
        try {
          const [collections] = await Promise.all([
            readZoteroCollections(input.environmentId),
            searchZotero("", 0, DEFAULT_ZOTERO_SCOPE),
          ]);
          if (isCurrentContext()) {
            dispatch({ type: "zoteroCollectionsArrived", collections: collections.collections });
          }
        } catch (cause) {
          if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        }
      }
      return status;
    },
    [checkZotero, input.environmentId, isCurrentContext, searchZotero],
  );

  const selectZoteroScope = useCallback(
    async (scope: ZoteroImportScope) => {
      dispatch({ type: "zoteroScopeChanged", scope });
      dispatch({
        type: "zoteroLibraryArrived",
        request: requestRef.current,
        page: emptyZoteroPage(scope),
      });
      await searchZotero("", 0, scope);
    },
    [searchZotero],
  );

  const importZoteroScope = useCallback(async (): Promise<ScientSourcesImportOutcome | null> => {
    const count = state.library?.total ?? 0;
    if (count === 0) return null;
    dispatch({ type: "importPreparationChanged", preparation: { kind: "zotero", count } });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    dispatch({ type: "requestStarted" });
    const request = requestRef.current;
    try {
      let next = await beginZoteroScopeImport(input.environmentId, {
        root: input.root,
        operationId: randomUUID(),
        scope: state.zoteroScope,
      });
      if (isCurrentRequest(request)) {
        dispatch({
          type: "operationArrived",
          request,
          operation: next,
          clearLibrary: true,
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
            dispatch({ type: "operationArrived", request, operation: value });
          }
        },
      });
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: next });
        await refreshOverview().catch((cause: unknown) =>
          dispatch({ type: "errorArrived", error: message(cause) }),
        );
      }
      return importOutcomeFromOperation({ operation: next, revealSingleSource: false });
    } catch (cause) {
      if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
      return null;
    } finally {
      if (isCurrentRequest(request)) {
        dispatch({ type: "importPreparationChanged", preparation: null });
        dispatch({ type: "busyChanged", busy: false });
      }
    }
  }, [
    input.environmentId,
    input.root,
    isCurrentRequest,
    refreshOverview,
    state.library?.total,
    state.zoteroScope,
  ]);

  const executeImport = useCallback(
    async (options: {
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
        await refreshOverview().catch((cause: unknown) =>
          dispatch({ type: "errorArrived", error: message(cause) }),
        );
      }
      return importOutcomeFromOperation({
        operation: next,
        revealSingleSource: options.revealSingleSource,
        ...(options.priorCounts ? { priorCounts: options.priorCounts } : {}),
      });
    },
    [input.environmentId, input.root, isCurrentRequest, refreshOverview],
  );

  const importPreflight = useCallback(
    async (options: {
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

      const itemKeys = options.result.items.flatMap((item) =>
        item.duplicate.kind === "new" ? [item.candidate.sourceKey] : [],
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
          await refreshOverview().catch((cause: unknown) =>
            dispatch({ type: "errorArrived", error: message(cause) }),
          );
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
        priorCounts: counts,
        ...(options.onStarted ? { onStarted: options.onStarted } : {}),
      });
    },
    [executeImport, input.environmentId, input.root, isCurrentRequest, refreshOverview],
  );

  const previewImport = useCallback(
    async (itemKeys: ReadonlyArray<string>): Promise<ScientSourcesImportOutcome | null> => {
      if (itemKeys.length === 0) return null;
      dispatch({
        type: "importPreparationChanged",
        preparation: { kind: "zotero", count: itemKeys.length },
      });
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "errorCleared" });
      dispatch({ type: "requestStarted" });
      const request = requestRef.current;
      try {
        const result = await preflightZoteroItems(input.environmentId, {
          root: input.root,
          itemKeys,
        });
        return await importPreflight({ adapter: "zotero", result, request });
      } catch (cause) {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
        return null;
      } finally {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      }
    },
    [importPreflight, input.environmentId, input.root, isCurrentRequest],
  );

  const uploadLocalFiles = useCallback(
    async (files: ReadonlyArray<File>): Promise<ScientSourcesImportOutcome | null> => {
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
              ? `${invalidFiles.at(0)?.name ?? "The selected file"} is not a PDF.`
              : "Choose at least one PDF file.",
        });
        return null;
      }
      const invalidFilesMessage =
        invalidFiles.length > 0
          ? `Skipped ${invalidFiles.length} non-PDF file${invalidFiles.length === 1 ? "" : "s"}.`
          : null;
      dispatch({
        type: "importPreparationChanged",
        preparation: { kind: "local-files", names: validFiles.map((file) => file.name) },
        error: invalidFilesMessage,
      });
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "requestStarted" });
      const request = requestRef.current;
      const items: ScientSourcesPreflightResult["items"][number][] = [];
      const failedFiles: Array<{ readonly name: string; readonly reason: string }> = [];
      let operationStarted = false;
      try {
        for (const file of validFiles) {
          try {
            const result = await uploadLocalSourcePdf(input.environmentId, {
              root: input.root,
              file,
            });
            items.push(result.item);
          } catch (cause) {
            failedFiles.push({ name: file.name, reason: message(cause) });
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
      } catch (cause) {
        if (!operationStarted && items.length > 0) {
          await discardLocalSourcePdfs(input.environmentId, {
            root: input.root,
            itemKeys: items.map((item) => item.candidate.sourceKey),
          }).catch(() => undefined);
        }
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
        return null;
      } finally {
        if (isCurrentRequest(request)) {
          dispatch({ type: "importPreparationChanged", preparation: null });
          dispatch({ type: "busyChanged", busy: false });
        }
      }
    },
    [importPreflight, input.environmentId, input.root, isCurrentRequest],
  );

  const runImport = useCallback(
    async (
      itemKeys: ReadonlyArray<string>,
      possibleMetadataMatchOverrides: ReadonlyArray<string>,
    ): Promise<ScientSourcesImportOutcome | null> => {
      if (!state.preflight || !state.preflightAdapter || itemKeys.length === 0) return null;
      dispatch({ type: "busyChanged", busy: true });
      dispatch({ type: "cancellingChanged", cancelling: false });
      dispatch({ type: "errorCleared" });
      dispatch({ type: "requestStarted" });
      const request = requestRef.current;
      try {
        const selectedKeys = new Set(itemKeys);
        const reviewedCounts = workflowReviewedImportCounts(state.preflight, selectedKeys);
        return await executeImport({
          adapter: state.preflightAdapter,
          itemKeys,
          possibleMetadataMatchOverrides,
          ...(state.preflightAdapter === "local-files"
            ? {
                allLocalItemKeys: state.preflight.items.map((item) => item.candidate.sourceKey),
              }
            : {}),
          request,
          revealSingleSource: state.preflight.items.length === 1,
          priorCounts: reviewedCounts,
        });
      } catch (cause) {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
        return null;
      } finally {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      }
    },
    [executeImport, isCurrentRequest, state.preflight, state.preflightAdapter],
  );

  const resumeImport = useCallback(async () => {
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
    dispatch({ type: "requestStarted" });
    const request = requestRef.current;
    try {
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
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: next });
        await refreshOverview();
      }
    } catch (cause) {
      if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
    } finally {
      if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
    }
  }, [
    input.environmentId,
    input.root,
    isCurrentRequest,
    refreshOverview,
    state.busy,
    state.operation,
  ]);

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

  const cancelImport = useCallback(async () => {
    const operation = state.operation;
    if (!operation || operation.state !== "running" || state.cancelling) return;
    stopSourceImportContinuation({
      environmentId: input.environmentId,
      projectId: operation.projectId,
      operationId: operation.operationId,
    });
    dispatch({ type: "requestStarted" });
    dispatch({ type: "cancellingChanged", cancelling: true });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    try {
      const cancelled = await cancelSourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
      });
      if (isCurrentContext()) {
        dispatch({ type: "operationArrived", request: requestRef.current, operation: cancelled });
        dispatch({ type: "zoteroLibraryClosed" });
        await refreshOverview();
      }
    } catch (cause) {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
    } finally {
      if (isCurrentContext()) {
        dispatch({ type: "busyChanged", busy: false });
        dispatch({ type: "cancellingChanged", cancelling: false });
      }
    }
  }, [
    input.environmentId,
    input.root,
    isCurrentContext,
    refreshOverview,
    state.cancelling,
    state.operation,
  ]);

  const retryFailedImport = useCallback(async () => {
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
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    try {
      const retried = await retrySourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
        itemKeys,
      });
      if (isCurrentContext()) {
        dispatch({ type: "operationArrived", request: requestRef.current, operation: retried });
      }
    } catch (cause) {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
    } finally {
      if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
    }
  }, [
    input.environmentId,
    input.root,
    isCurrentContext,
    state.busy,
    state.cancelling,
    state.operation,
  ]);

  return {
    busy: state.busy,
    checkingZotero: state.checkingZotero,
    cancelling: state.cancelling,
    error: state.error,
    overview: state.overview,
    sourceDetails: state.sourceDetails,
    zoteroStatus: state.zoteroStatus,
    zoteroCollections: state.zoteroCollections,
    zoteroScope: state.zoteroScope,
    zoteroCheckFeedback: state.zoteroCheckFeedback,
    library: state.library,
    preflight: state.preflight,
    preflightAdapter: state.preflightAdapter,
    operation: state.operation,
    importPreparation: state.importPreparation,
    openZoteroLibrary,
    uploadLocalFiles,
    searchZotero,
    selectZoteroScope,
    importZoteroScope,
    previewImport,
    runImport,
    cancelImport,
    retryFailedImport,
    resumeImport,
    refreshOverview,
    reloadOverview,
    acceptSourceRecord,
    loadSource,
    refreshSourceMetadata,
    saveSourceNote,
    approveSource,
    removeSource,
    clearError: () => dispatch({ type: "errorCleared" }),
    clearOperationSummary: () => dispatch({ type: "importReviewDismissed" }),
    closeZoteroStatus: () => dispatch({ type: "zoteroCheckFeedbackChanged", feedback: null }),
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
          if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        });
      }
    },
  } as const;
}
