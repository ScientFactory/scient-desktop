import type {
  EnvironmentId,
  ScientSourceImportOperation,
  ScientSourcesPreflightResult,
  ScientSourcesOverviewResult,
  ZoteroConnectionStatus,
  ZoteroLibraryPage,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import {
  advanceSourcesImport,
  beginLocalSourcesImport,
  beginZoteroItemsImport,
  cancelSourcesImport,
  discardLocalSourcePdfs,
  preflightZoteroItems,
  readScientSources,
  removeScientSource,
  readZoteroLibrary,
  readZoteroStatus,
  uploadLocalSourcePdf,
} from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";

const message = (error: unknown): string => scientSourcesErrorMessage(error, import.meta.env.DEV);

export function useScientSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const [overview, setOverview] = useState<ScientSourcesOverviewResult | null>(null);
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroConnectionStatus | null>(null);
  const [library, setLibrary] = useState<ZoteroLibraryPage | null>(null);
  const [preflight, setPreflight] = useState<ScientSourcesPreflightResult | null>(null);
  const [preflightAdapter, setPreflightAdapter] = useState<"zotero" | "local-files" | null>(null);
  const [operation, setOperation] = useState<ScientSourceImportOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparingLocalFiles, setPreparingLocalFiles] = useState<ReadonlyArray<string>>([]);
  const [checkingZotero, setCheckingZotero] = useState(false);
  const [zoteroCheckFeedback, setZoteroCheckFeedback] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const cancelRequested = useRef(false);
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
    const next = await readScientSources(input.environmentId, input.root);
    if (isCurrentContext()) {
      setOverview(next);
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

  const acceptSourceRecord = useCallback(
    (record: ScientSourcesOverviewResult["records"][number]) => {
      setOverview((current) => {
        if (!current) return current;
        const recordIndex = current.records.findIndex(
          (entry) => entry.sourceId === record.sourceId,
        );
        if (recordIndex === -1) return current;
        const records = [...current.records];
        records[recordIndex] = record;
        return { ...current, records };
      });
    },
    [],
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

  useEffect(() => {
    setOverview(null);
    setLibrary(null);
    setPreflight(null);
    setPreflightAdapter(null);
    setOperation(null);
    setZoteroStatus(null);
    setBusy(false);
    setPreparingLocalFiles([]);
    setCheckingZotero(false);
    setZoteroCheckFeedback(null);
    setCancelling(false);
    setError(null);
    cancelRequested.current = false;
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
    async (query: string, start = 0) => {
      setBusy(true);
      setError(null);
      try {
        const page = await readZoteroLibrary(input.environmentId, { query, start, limit: 50 });
        if (isCurrentContext()) {
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
        if (isCurrentContext()) setError(message(cause));
      } finally {
        if (isCurrentContext()) setBusy(false);
      }
    },
    [input.environmentId, isCurrentContext],
  );

  const previewImport = useCallback(
    async (itemKeys: ReadonlyArray<string>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await preflightZoteroItems(input.environmentId, {
          root: input.root,
          itemKeys,
        });
        if (isCurrentContext()) {
          setPreflight(result);
          setPreflightAdapter("zotero");
        }
      } catch (cause) {
        if (isCurrentContext()) setError(message(cause));
      } finally {
        if (isCurrentContext()) setBusy(false);
      }
    },
    [input.environmentId, input.root, isCurrentContext],
  );

  const openZoteroLibrary = useCallback(
    async (showRetryFeedback = false) => {
      const status = await checkZotero(showRetryFeedback);
      if (status?.state === "ready") await searchZotero("", 0);
      return status;
    },
    [checkZotero, searchZotero],
  );

  const uploadLocalFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      setPreparingLocalFiles(files.map((file) => file.name));
      setBusy(true);
      setError(null);
      const request = ++generation.current;
      const items = [];
      try {
        for (const file of files) {
          if (
            file.type &&
            file.type !== "application/pdf" &&
            !file.name.toLowerCase().endsWith(".pdf")
          ) {
            throw new Error(`${file.name} is not a PDF.`);
          }
          const result = await uploadLocalSourcePdf(input.environmentId, {
            root: input.root,
            file,
          });
          items.push(result.item);
          if (!isCurrentContext() || generation.current !== request) {
            await discardLocalSourcePdfs(input.environmentId, {
              root: input.root,
              itemKeys: items.map((item) => item.candidate.sourceKey),
            }).catch(() => undefined);
            return;
          }
        }
        const unique = new Map(items.map((item) => [item.candidate.sourceKey, item]));
        if (isCurrentContext() && generation.current === request) {
          const uploadedItems = [...unique.values()];
          stagedLocalKeys.current = uploadedItems.map((item) => item.candidate.sourceKey);
          setPreflight({ items: uploadedItems });
          setPreflightAdapter("local-files");
        }
      } catch (cause) {
        if (items.length > 0) {
          await discardLocalSourcePdfs(input.environmentId, {
            root: input.root,
            itemKeys: items.map((item) => item.candidate.sourceKey),
          }).catch(() => undefined);
        }
        if (isCurrentContext() && generation.current === request) setError(message(cause));
      } finally {
        if (isCurrentContext() && generation.current === request) {
          setPreparingLocalFiles([]);
          setBusy(false);
        }
      }
    },
    [input.environmentId, input.root, isCurrentContext],
  );

  const runImport = useCallback(
    async (
      itemKeys: ReadonlyArray<string>,
      possibleMetadataMatchOverrides: ReadonlyArray<string>,
    ) => {
      setBusy(true);
      setCancelling(false);
      setError(null);
      cancelRequested.current = false;
      const request = ++generation.current;
      try {
        const begin =
          preflightAdapter === "local-files" ? beginLocalSourcesImport : beginZoteroItemsImport;
        let next = await begin(input.environmentId, {
          root: input.root,
          operationId: randomUUID(),
          itemKeys,
          possibleMetadataMatchOverrides,
        });
        if (preflightAdapter === "local-files") {
          const selectedKeys = new Set(itemKeys);
          const unselectedKeys = (preflight?.items ?? []).flatMap((item) =>
            selectedKeys.has(item.candidate.sourceKey) ? [] : [item.candidate.sourceKey],
          );
          stagedLocalKeys.current = [];
          if (unselectedKeys.length > 0) {
            await discardLocalSourcePdfs(input.environmentId, {
              root: input.root,
              itemKeys: unselectedKeys,
            }).catch(() => undefined);
          }
        }
        if (isCurrentContext() && generation.current === request) setOperation(next);
        while (
          !cancelRequested.current &&
          next.state === "running" &&
          next.items.some((item) => item.state === "pending")
        ) {
          next = await advanceSourcesImport(input.environmentId, {
            root: input.root,
            operationId: next.operationId,
          });
          if (!isCurrentContext() || generation.current !== request) return;
          setOperation(next);
        }
        if (isCurrentContext() && generation.current === request) {
          setOperation(next);
          setPreflight(null);
          setPreflightAdapter(null);
          setLibrary(null);
          await refreshOverview();
        }
      } catch (cause) {
        if (isCurrentContext() && generation.current === request) setError(message(cause));
      } finally {
        if (isCurrentContext() && generation.current === request) setBusy(false);
      }
    },
    [
      input.environmentId,
      input.root,
      isCurrentContext,
      preflight,
      preflightAdapter,
      refreshOverview,
    ],
  );

  const resumeImport = useCallback(async () => {
    if (!operation || operation.state !== "running" || busy) return;
    setBusy(true);
    setCancelling(false);
    setError(null);
    cancelRequested.current = false;
    const request = ++generation.current;
    let next = operation;
    try {
      while (
        !cancelRequested.current &&
        next.state === "running" &&
        next.items.some((item) => item.state === "pending")
      ) {
        next = await advanceSourcesImport(input.environmentId, {
          root: input.root,
          operationId: next.operationId,
        });
        if (!isCurrentContext() || generation.current !== request) return;
        setOperation(next);
      }
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

  const cancelImport = useCallback(async () => {
    if (!operation || operation.state !== "running" || cancelRequested.current) return;
    cancelRequested.current = true;
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
      cancelRequested.current = false;
    }
  }, [input.environmentId, input.root, isCurrentContext, operation, refreshOverview]);

  return {
    busy,
    checkingZotero,
    cancelling,
    error,
    overview,
    zoteroStatus,
    zoteroCheckFeedback,
    library,
    preflight,
    preflightAdapter,
    operation,
    preparingLocalFiles,
    openZoteroLibrary,
    uploadLocalFiles,
    searchZotero,
    previewImport,
    runImport,
    cancelImport,
    resumeImport,
    refreshOverview,
    reloadOverview,
    acceptSourceRecord,
    removeSource,
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
