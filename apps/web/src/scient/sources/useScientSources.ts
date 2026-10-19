import { useStableCallback } from "~/hooks/useStableCallback";
import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourcesPreflightResult,
  ZoteroImportScope,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";

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
 * transitions only. Import, overview, and Zotero browse responses land through
 * independent request-token lanes so a late or superseded workflow response
 * cannot overwrite newer state.
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
  useLayoutEffect(() => {
    contextKeyRef.current = contextKey;
  }, [contextKey]);
  // Request tokens are issued synchronously here rather than derived from
  // reducer state: dispatch commits on the next render, so a token captured
  // from render timing would read stale and every guarded response would be
  // dropped. The reducer validates tokens; these refs are their only issuers.
  // Three lanes because overview refreshes (live-refresh repeats them during
  // long imports) and Zotero browsing must never invalidate import progress.
  const requestRef = useRef(0);
  const overviewRequestRef = useRef(0);
  const zoteroRequestRef = useRef(0);
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
  const isCurrentContext = () => mounted.current && contextKeyRef.current === contextKey;
  const isCurrentRequest = (request: number) =>
    isCurrentContext() && requestRef.current === request;

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

  const refreshOverview = useStableCallback(async () => {
    // The overview lane is independent of imports: live-refresh repeats this
    // call while a durable import runs, and neither may starve the other.
    const request = nextOverviewRequestToken();
    dispatch({ type: "overviewRequestStarted", request });
    const next = await readScientSources(input.environmentId, input.root);
    if (isCurrentContext() && overviewRequestRef.current === request) {
      dispatch({ type: "overviewArrived", request, overview: next });
    }
    return next;
  });

  const reloadOverview = async () => {
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      return await refreshOverview();
    })()
      .catch(async (cause) => {
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        return null;
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
      });
  };

  const acceptSourceRecord = (record: ScientSourceDetailResult) => {
    dispatch({ type: "sourceRecordAccepted", record });
  };

  const loadSource = async (sourceId: string): Promise<ScientSourceDetailResult> => {
    const cached = state.sourceDetails[sourceId];
    const summary = state.overview?.records.find((record) => record.sourceId === sourceId);
    if (cached && summary?.revision === cached.revision) return cached;
    try {
      const detail = await readScientSource(input.environmentId, { root: input.root, sourceId });
      if (isCurrentContext()) {
        dispatch({ type: "sourceDetailArrived", sourceId, detail });
      }
      return detail;
    } catch (cause) {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
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

  const removeSource = async (sourceId: string, expectedRevision: number) => {
    dispatch({ type: "busyChanged", busy: true });
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
      if (isCurrentContext()) {
        await refreshOverview().catch((cause: unknown) =>
          dispatch({ type: "errorArrived", error: message(cause) }),
        );
      }
      return result;
    })()
      .catch(async (cause) => {
        const safeMessage = message(cause);
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: safeMessage });
        throw new Error(safeMessage, { cause });
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
      });
  };

  const saveSourceNote = async (
    sourceId: string,
    expectedRevision: number,
    note: string | null,
  ) => {
    const result = await updateScientSourceNote(input.environmentId, {
      root: input.root,
      sourceId,
      expectedRevision,
      note,
    });
    if (isCurrentContext()) acceptSourceRecord(result.record);
    return result;
  };

  const approveSource = async (sourceId: string, expectedRevision: number) => {
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
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
    })()
      .catch(async (cause) => {
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        throw cause;
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "busyChanged", busy: false });
      });
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
    void refreshOverview().catch((cause) => {
      if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
    });
  });
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
    })()
      .catch(async (cause) => {
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
      })
      .finally(() => {
        if (isCurrentContext()) dispatch({ type: "checkingZoteroChanged", checking: false });
      });
  };

  const searchZotero = async (query: string, start = 0, scopeInput?: ZoteroImportScope) => {
    const scope = scopeInput ?? state.zoteroScope;
    // The Zotero browse lane is independent of imports and overview loads.
    const request = nextZoteroRequestToken();
    dispatch({ type: "zoteroRequestStarted", request });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
      const page = await readZoteroLibrary(input.environmentId, {
        scope,
        query,
        start,
        limit: 50,
      });
      if (isCurrentContext() && zoteroRequestRef.current === request) {
        dispatch({ type: "zoteroLibraryArrived", request, page });
      }
    })()
      .catch(async (cause) => {
        if (isCurrentContext() && zoteroRequestRef.current === request) {
          dispatch({ type: "errorArrived", error: message(cause) });
        }
      })
      .finally(() => {
        if (isCurrentContext() && zoteroRequestRef.current === request) {
          dispatch({ type: "busyChanged", busy: false });
        }
      });
  };

  const openZoteroLibrary = async (showRetryFeedback = false) => {
    const status = await checkZotero(showRetryFeedback);
    if (status?.state === "ready" && isCurrentContext()) {
      dispatch({ type: "zoteroScopeChanged", scope: DEFAULT_ZOTERO_SCOPE });
      dispatch({ type: "zoteroLibrarySeeded", page: emptyZoteroPage(DEFAULT_ZOTERO_SCOPE) });
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
  };

  const selectZoteroScope = async (scope: ZoteroImportScope) => {
    dispatch({ type: "zoteroScopeChanged", scope });
    dispatch({ type: "zoteroLibrarySeeded", page: emptyZoteroPage(scope) });
    await searchZotero("", 0, scope);
  };

  const importZoteroScope = async (): Promise<ScientSourcesImportOutcome | null> => {
    const count = state.library?.total ?? 0;
    if (count === 0) return null;
    dispatch({ type: "operationCleared" });
    const request = nextRequestToken();
    dispatch({ type: "requestStarted", request });
    dispatch({ type: "importPreparationChanged", preparation: { kind: "zotero", count } });
    dispatch({ type: "busyChanged", busy: true });
    dispatch({ type: "errorCleared" });
    return await (async () => {
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
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
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
      });
      return await importPreflight({ adapter: "zotero", result, request });
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
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
            ? `${invalidFiles.at(0)?.name ?? "The selected file"} is not a PDF.`
            : "Choose at least one PDF file.",
      });
      return null;
    }
    const invalidFilesMessage =
      invalidFiles.length > 0
        ? `Skipped ${invalidFiles.length} non-PDF file${invalidFiles.length === 1 ? "" : "s"}.`
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
    })()
      .catch(async (cause) => {
        if (!operationStarted && items.length > 0) {
          await discardLocalSourcePdfs(input.environmentId, {
            root: input.root,
            itemKeys: items.map((item) => item.candidate.sourceKey),
          }).catch(() => undefined);
        }
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
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
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
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
      if (isCurrentRequest(request)) {
        dispatch({ type: "operationArrived", request, operation: next });
        await refreshOverview();
      }
    })()
      .catch(async (cause) => {
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
      })
      .finally(() => {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      });
  };

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
        dispatch({ type: "operationArrived", request, operation: cancelled });
        dispatch({ type: "zoteroLibraryClosed" });
        await refreshOverview();
      }
    })()
      .catch(async (cause) => {
        if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
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
        if (isCurrentRequest(request)) dispatch({ type: "errorArrived", error: message(cause) });
      })
      .finally(() => {
        if (isCurrentRequest(request)) dispatch({ type: "busyChanged", busy: false });
      });
  };

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
          if (isCurrentContext()) dispatch({ type: "errorArrived", error: message(cause) });
        });
      }
    },
  } as const;
}
