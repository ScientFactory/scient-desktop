import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourceImportOperation,
  ScientSourcesPreflightResult,
  ScientSourcesOverviewResult,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

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
import {
  completedImportCounts,
  preflightImportCounts,
  reviewedImportCounts,
  type ScientSourcesImportOutcome,
  type ScientSourcesImportCounts,
} from "./importOutcome";
import { continueSourceImport, stopSourceImportContinuation } from "./importPipeline";

const message = (error: unknown): string => scientSourcesErrorMessage(error, import.meta.env.DEV);

export type { ScientSourcesImportOutcome } from "./importOutcome";

type ImportPreparation =
  | { readonly kind: "local-files"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "zotero"; readonly count: number };

const DEFAULT_ZOTERO_SCOPE: ZoteroImportScope = { kind: "library" };

function emptyZoteroPage(scope: ZoteroImportScope): ZoteroLibraryPage {
  return { scope, items: [], start: 0, nextStart: 0, total: 0, hasMore: false };
}

function singleMatchingSourceId(preflight: ScientSourcesPreflightResult): string | null {
  if (preflight.items.length !== 1) return null;
  const matchingSourceIds = preflight.items[0]?.duplicate.matchingSourceIds ?? [];
  return matchingSourceIds.length === 1 ? (matchingSourceIds[0] ?? null) : null;
}

function singleImportedSourceId(operation: ScientSourceImportOperation): string | null {
  if (operation.items.length !== 1) return null;
  const item = operation.items[0];
  return item?.state === "imported" ? item.sourceId : null;
}

function importOutcomeFromOperation(input: {
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

export function useScientSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const [overview, setOverview] = useState<ScientSourcesOverviewResult | null>(null);
  const [sourceDetails, setSourceDetails] = useState<
    Readonly<Record<string, ScientSourceDetailResult>>
  >({});
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroConnectionStatus | null>(null);
  const [library, setLibrary] = useState<ZoteroLibraryPage | null>(null);
  const [zoteroCollections, setZoteroCollections] = useState<ReadonlyArray<ZoteroCollection>>([]);
  const [zoteroScope, setZoteroScope] = useState<ZoteroImportScope>(DEFAULT_ZOTERO_SCOPE);
  const [preflight, setPreflight] = useState<ScientSourcesPreflightResult | null>(null);
  const [preflightAdapter, setPreflightAdapter] = useState<"zotero" | "local-files" | null>(null);
  const [operation, setOperation] = useState<ScientSourceImportOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [importPreparation, setImportPreparation] = useState<ImportPreparation | null>(null);
  const [checkingZotero, setCheckingZotero] = useState(false);
  const [zoteroCheckFeedback, setZoteroCheckFeedback] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const overviewGeneration = useRef(0);
  const zoteroSearchGeneration = useRef(0);
  const stagedLocalKeys = useRef<ReadonlyArray<string>>([]);
  const contextKey = `${input.environmentId}\0${input.root}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const isCurrentContext = useCallback(
    () => mounted.current && contextKeyRef.current === contextKey,
    [contextKey],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      overviewGeneration.current += 1;
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
    const request = ++overviewGeneration.current;
    const next = await readScientSources(input.environmentId, input.root);
    if (isCurrentContext() && overviewGeneration.current === request) {
      setOverview(next);
      setSourceDetails((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([sourceId, detail]) =>
            next.records.some(
              (summary) => summary.sourceId === sourceId && summary.revision === detail.revision,
            ),
          ),
        ),
      );
      if (next.activeOperation) setOperation(next.activeOperation);
    }
    return next;
  }, [input.environmentId, input.root, isCurrentContext]);

  const reloadOverview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      return await refreshOverview();
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause));
      return null;
    } finally {
      if (isCurrentContext()) setBusy(false);
    }
  }, [isCurrentContext, refreshOverview]);

  const acceptSourceRecord = useCallback((record: ScientSourceDetailResult) => {
    setSourceDetails((current) => ({ ...current, [record.sourceId]: record }));
    setOverview((current) => {
      if (!current) return current;
      const recordIndex = current.records.findIndex((entry) => entry.sourceId === record.sourceId);
      if (recordIndex === -1) return current;
      const records = [...current.records];
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
      return { ...current, records };
    });
  }, []);

  const loadSource = useCallback(
    async (sourceId: string): Promise<ScientSourceDetailResult> => {
      const cached = sourceDetails[sourceId];
      const summary = overview?.records.find((record) => record.sourceId === sourceId);
      if (cached && summary?.revision === cached.revision) return cached;
      try {
        const detail = await readScientSource(input.environmentId, { root: input.root, sourceId });
        if (isCurrentContext()) {
          setSourceDetails((current) => ({ ...current, [sourceId]: detail }));
        }
        return detail;
      } catch (cause) {
        if (isCurrentContext()) setError(message(cause));
        throw cause;
      }
    },
    [input.environmentId, input.root, isCurrentContext, overview?.records, sourceDetails],
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
      setBusy(true);
      setError(null);
      try {
        const result = await removeScientSource(input.environmentId, {
          root: input.root,
          sourceId,
          expectedRevision,
        });
        if (isCurrentContext() && result.outcome !== "stale") {
          setSourceDetails((current) => {
            const { [sourceId]: _removed, ...remaining } = current;
            return remaining;
          });
          setOverview((current) =>
            current
              ? {
                  ...current,
                  records: current.records.filter((record) => record.sourceId !== sourceId),
                  recordDiagnostics: current.recordDiagnostics.filter(
                    (entry) => entry.sourceId !== sourceId,
                  ),
                }
              : current,
          );
        }
        if (isCurrentContext()) {
          await refreshOverview().catch((cause: unknown) => setError(message(cause)));
        }
        return result;
      } catch (cause) {
        const safeMessage = message(cause);
        if (isCurrentContext()) setError(safeMessage);
        throw new Error(safeMessage, { cause });
      } finally {
        if (isCurrentContext()) setBusy(false);
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
      setBusy(true);
      setError(null);
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
        if (isCurrentContext()) setError(message(cause));
        throw cause;
      } finally {
        if (isCurrentContext()) setBusy(false);
      }
    },
    [acceptSourceRecord, input.environmentId, input.root, isCurrentContext, refreshOverview],
  );

  useEffect(() => {
    setOverview(null);
    setSourceDetails({});
    setLibrary(null);
    setZoteroCollections([]);
    setZoteroScope(DEFAULT_ZOTERO_SCOPE);
    setPreflight(null);
    setPreflightAdapter(null);
    setOperation(null);
    setZoteroStatus(null);
    setBusy(false);
    setImportPreparation(null);
    setCheckingZotero(false);
    setZoteroCheckFeedback(null);
    setCancelling(false);
    setError(null);
    const request = ++generation.current;
    void refreshOverview().catch((cause) => {
      if (isCurrentContext() && generation.current === request) setError(message(cause));
    });
  }, [isCurrentContext, refreshOverview]);

  const checkZotero = useCallback(
    async (showRetryFeedback: boolean) => {
      setCheckingZotero(true);
      setZoteroCheckFeedback(null);
      setError(null);
      try {
        const status = await readZoteroStatus(input.environmentId);
        if (isCurrentContext()) {
          setZoteroStatus(status);
          if (showRetryFeedback && status.state !== "ready") {
            setZoteroCheckFeedback(
              status.state === "unreachable"
                ? "Zotero is still unavailable. Make sure it is open on the computer running this project."
                : status.state === "access-disabled"
                  ? "Local access is still turned off in Zotero."
                  : status.state === "incompatible"
                    ? "This Zotero version is still not compatible with Scient."
                    : "Zotero responded, but its local API still could not be verified.",
            );
          }
        }
        return status;
      } catch (cause) {
        if (isCurrentContext()) {
          setError(message(cause));
          if (showRetryFeedback) {
            setZoteroCheckFeedback("Scient could not check Zotero. Please try again.");
          }
        }
        return null;
      } finally {
        if (isCurrentContext()) setCheckingZotero(false);
      }
    },
    [input.environmentId, isCurrentContext],
  );

  const searchZotero = useCallback(
    async (query: string, start = 0, scope: ZoteroImportScope = zoteroScope) => {
      const request = ++zoteroSearchGeneration.current;
      setBusy(true);
      setError(null);
      try {
        const page = await readZoteroLibrary(input.environmentId, {
          scope,
          query,
          start,
          limit: 50,
        });
        if (isCurrentContext() && zoteroSearchGeneration.current === request) {
          setLibrary((current) => {
            if (start === 0 || !current) return page;
            const items = [...current.items];
            const seen = new Set(items.map((item) => item.sourceKey));
            for (const item of page.items) {
              if (!seen.has(item.sourceKey)) items.push(item);
            }
            return { ...page, items, start: 0 };
          });
        }
      } catch (cause) {
        if (isCurrentContext() && zoteroSearchGeneration.current === request) {
          setError(message(cause));
        }
      } finally {
        if (isCurrentContext() && zoteroSearchGeneration.current === request) setBusy(false);
      }
    },
    [input.environmentId, isCurrentContext, zoteroScope],
  );

  const openZoteroLibrary = useCallback(
    async (showRetryFeedback = false) => {
      const status = await checkZotero(showRetryFeedback);
      if (status?.state === "ready") {
        if (isCurrentContext()) {
          setZoteroScope(DEFAULT_ZOTERO_SCOPE);
          setLibrary(emptyZoteroPage(DEFAULT_ZOTERO_SCOPE));
        }
        try {
          const [collections] = await Promise.all([
            readZoteroCollections(input.environmentId),
            searchZotero("", 0, DEFAULT_ZOTERO_SCOPE),
          ]);
          if (isCurrentContext()) setZoteroCollections(collections.collections);
        } catch (cause) {
          if (isCurrentContext()) setError(message(cause));
        }
      }
      return status;
    },
    [checkZotero, input.environmentId, isCurrentContext, searchZotero],
  );

  const selectZoteroScope = useCallback(
    async (scope: ZoteroImportScope) => {
      setZoteroScope(scope);
      setLibrary(emptyZoteroPage(scope));
      await searchZotero("", 0, scope);
    },
    [searchZotero],
  );

  const importZoteroScope = useCallback(async (): Promise<ScientSourcesImportOutcome | null> => {
    const count = library?.total ?? 0;
    if (count === 0) return null;
    setImportPreparation({ kind: "zotero", count });
    setOperation(null);
    setBusy(true);
    setError(null);
    const request = ++generation.current;
    try {
      let next = await beginZoteroScopeImport(input.environmentId, {
        root: input.root,
        operationId: randomUUID(),
        scope: zoteroScope,
      });
      if (isCurrentContext() && generation.current === request) {
        setImportPreparation(null);
        setOperation(next);
        setLibrary(null);
      }
      next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation: next,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: (value) => {
          if (isCurrentContext() && generation.current === request) setOperation(value);
        },
      });
      if (isCurrentContext() && generation.current === request) {
        setOperation(next);
        await refreshOverview().catch((cause: unknown) => setError(message(cause)));
      }
      return importOutcomeFromOperation({ operation: next, revealSingleSource: false });
    } catch (cause) {
      if (isCurrentContext() && generation.current === request) setError(message(cause));
      return null;
    } finally {
      if (isCurrentContext() && generation.current === request) {
        setImportPreparation(null);
        setBusy(false);
      }
    }
  }, [
    input.environmentId,
    input.root,
    isCurrentContext,
    library?.total,
    refreshOverview,
    zoteroScope,
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

      const reportProgress = (value: ScientSourceImportOperation) => {
        if (isCurrentContext() && generation.current === options.request) setOperation(value);
      };
      if (isCurrentContext() && generation.current === options.request) {
        setImportPreparation(null);
        setOperation(next);
        setPreflight(null);
        setPreflightAdapter(null);
        setLibrary(null);
      }
      next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation: next,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: reportProgress,
      });

      if (isCurrentContext() && generation.current === options.request) {
        setOperation(next);
        await refreshOverview().catch((cause: unknown) => setError(message(cause)));
      }
      return importOutcomeFromOperation({
        operation: next,
        revealSingleSource: options.revealSingleSource,
        ...(options.priorCounts ? { priorCounts: options.priorCounts } : {}),
      });
    },
    [input.environmentId, input.root, isCurrentContext, refreshOverview],
  );

  const importPreflight = useCallback(
    async (options: {
      readonly adapter: "zotero" | "local-files";
      readonly result: ScientSourcesPreflightResult;
      readonly request: number;
      readonly onStarted?: () => void;
    }): Promise<ScientSourcesImportOutcome | null> => {
      const allItemKeys = options.result.items.map((item) => item.candidate.sourceKey);
      const counts = preflightImportCounts(options.result);
      const needsDuplicateDecision = options.result.items.some(
        (item) => item.duplicate.kind === "possible-metadata-match",
      );
      if (needsDuplicateDecision) {
        if (isCurrentContext() && generation.current === options.request) {
          if (options.adapter === "local-files") stagedLocalKeys.current = allItemKeys;
          setImportPreparation(null);
          setPreflight(options.result);
          setPreflightAdapter(options.adapter);
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
        if (isCurrentContext() && generation.current === options.request) {
          setImportPreparation(null);
          setLibrary(null);
          await refreshOverview().catch((cause: unknown) => setError(message(cause)));
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
    [executeImport, input.environmentId, input.root, isCurrentContext, refreshOverview],
  );

  const previewImport = useCallback(
    async (itemKeys: ReadonlyArray<string>): Promise<ScientSourcesImportOutcome | null> => {
      if (itemKeys.length === 0) return null;
      setOperation(null);
      setImportPreparation({ kind: "zotero", count: itemKeys.length });
      setBusy(true);
      setError(null);
      const request = ++generation.current;
      try {
        const result = await preflightZoteroItems(input.environmentId, {
          root: input.root,
          itemKeys,
        });
        return await importPreflight({ adapter: "zotero", result, request });
      } catch (cause) {
        if (isCurrentContext() && generation.current === request) setError(message(cause));
        return null;
      } finally {
        if (isCurrentContext() && generation.current === request) {
          setImportPreparation(null);
          setBusy(false);
        }
      }
    },
    [importPreflight, input.environmentId, input.root, isCurrentContext],
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
        setError(
          invalidFiles.length === 1
            ? `${invalidFiles.at(0)?.name ?? "The selected file"} is not a PDF.`
            : "Choose at least one PDF file.",
        );
        return null;
      }
      const invalidFilesMessage =
        invalidFiles.length > 0
          ? `Skipped ${invalidFiles.length} non-PDF file${invalidFiles.length === 1 ? "" : "s"}.`
          : null;
      setOperation(null);
      setImportPreparation({ kind: "local-files", names: validFiles.map((file) => file.name) });
      setBusy(true);
      setError(invalidFilesMessage);
      const request = ++generation.current;
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
        if (failedFiles.length > 0 && isCurrentContext() && generation.current === request) {
          setError(
            [
              invalidFilesMessage,
              `Skipped ${failedFiles.length} PDF${failedFiles.length === 1 ? "" : "s"} that could not be read: ${failedFiles.map((file) => `${file.name} (${file.reason})`).join(", ")}.`,
            ]
              .filter((value): value is string => value !== null)
              .join(" "),
          );
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
        if (isCurrentContext() && generation.current === request) setError(message(cause));
        return null;
      } finally {
        if (isCurrentContext() && generation.current === request) {
          setImportPreparation(null);
          setBusy(false);
        }
      }
    },
    [importPreflight, input.environmentId, input.root, isCurrentContext],
  );

  const runImport = useCallback(
    async (
      itemKeys: ReadonlyArray<string>,
      possibleMetadataMatchOverrides: ReadonlyArray<string>,
    ): Promise<ScientSourcesImportOutcome | null> => {
      if (!preflight || !preflightAdapter || itemKeys.length === 0) return null;
      setBusy(true);
      setCancelling(false);
      setError(null);
      const request = ++generation.current;
      try {
        const selectedKeys = new Set(itemKeys);
        const reviewedCounts = reviewedImportCounts(preflight, selectedKeys);
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
      } catch (cause) {
        if (isCurrentContext() && generation.current === request) setError(message(cause));
        return null;
      } finally {
        if (isCurrentContext() && generation.current === request) setBusy(false);
      }
    },
    [executeImport, isCurrentContext, preflight, preflightAdapter],
  );

  const resumeImport = useCallback(async () => {
    if (
      !operation ||
      operation.state !== "running" ||
      !operation.items.some((item) => item.state === "pending") ||
      busy
    )
      return;
    setBusy(true);
    setCancelling(false);
    setError(null);
    const request = ++generation.current;
    try {
      const next = await continueSourceImport({
        environmentId: input.environmentId,
        root: input.root,
        operation,
        advance: (operationId) =>
          advanceSourcesImport(input.environmentId, { root: input.root, operationId }),
        onProgress: (value) => {
          if (isCurrentContext() && generation.current === request) setOperation(value);
        },
      });
      if (isCurrentContext() && generation.current === request) {
        setOperation(next);
        await refreshOverview();
      }
    } catch (cause) {
      if (isCurrentContext() && generation.current === request) setError(message(cause));
    } finally {
      if (isCurrentContext() && generation.current === request) setBusy(false);
    }
  }, [busy, input.environmentId, input.root, isCurrentContext, operation, refreshOverview]);

  useEffect(() => {
    if (
      !operation ||
      operation.state !== "running" ||
      !operation.items.some((item) => item.state === "pending") ||
      busy ||
      cancelling
    )
      return;
    void resumeImport();
  }, [busy, cancelling, operation, resumeImport]);

  const cancelImport = useCallback(async () => {
    if (!operation || operation.state !== "running" || cancelling) return;
    stopSourceImportContinuation({
      environmentId: input.environmentId,
      projectId: operation.projectId,
      operationId: operation.operationId,
    });
    generation.current += 1;
    setCancelling(true);
    setBusy(true);
    setError(null);
    try {
      const cancelled = await cancelSourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
      });
      if (isCurrentContext()) {
        setOperation(cancelled);
        setLibrary(null);
        await refreshOverview();
      }
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause));
    } finally {
      if (isCurrentContext()) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }, [cancelling, input.environmentId, input.root, isCurrentContext, operation, refreshOverview]);

  const retryFailedImport = useCallback(async () => {
    if (
      !operation ||
      (operation.state !== "running" && operation.state !== "completed") ||
      busy ||
      cancelling
    )
      return;
    const itemKeys = operation.items
      .filter((item) => item.state === "failed")
      .map((item) => item.itemKey);
    if (itemKeys.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const retried = await retrySourcesImport(input.environmentId, {
        root: input.root,
        operationId: operation.operationId,
        itemKeys,
      });
      if (isCurrentContext()) setOperation(retried);
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause));
    } finally {
      if (isCurrentContext()) setBusy(false);
    }
  }, [busy, cancelling, input.environmentId, input.root, isCurrentContext, operation]);

  return {
    busy,
    checkingZotero,
    cancelling,
    error,
    overview,
    sourceDetails,
    zoteroStatus,
    zoteroCollections,
    zoteroScope,
    zoteroCheckFeedback,
    library,
    preflight,
    preflightAdapter,
    operation,
    importPreparation,
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
    clearError: () => setError(null),
    closeZoteroStatus: () => setZoteroStatus(null),
    closeLibrary: () => setLibrary(null),
    clearOperationSummary: () => setOperation(null),
    resetImport: () => {
      const current = preflight;
      const adapter = preflightAdapter;
      setPreflight(null);
      setPreflightAdapter(null);
      if (adapter === "local-files" && current) {
        stagedLocalKeys.current = [];
        void discardLocalSourcePdfs(input.environmentId, {
          root: input.root,
          itemKeys: current.items.map((item) => item.candidate.sourceKey),
        }).catch((cause) => {
          if (isCurrentContext()) setError(message(cause));
        });
      }
    },
  } as const;
}
