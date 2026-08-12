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
  advanceZoteroItemsImport,
  beginZoteroItemsImport,
  cancelZoteroItemsImport,
  preflightZoteroItems,
  readScientSources,
  readZoteroLibrary,
  readZoteroStatus,
} from "./client";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function useScientSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const [overview, setOverview] = useState<ScientSourcesOverviewResult | null>(null);
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroConnectionStatus | null>(null);
  const [library, setLibrary] = useState<ZoteroLibraryPage | null>(null);
  const [preflight, setPreflight] = useState<ScientSourcesPreflightResult | null>(null);
  const [operation, setOperation] = useState<ScientSourceImportOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const cancelRequested = useRef(false);
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

  useEffect(() => {
    setOverview(null);
    setLibrary(null);
    setPreflight(null);
    setOperation(null);
    setZoteroStatus(null);
    setBusy(false);
    setCancelling(false);
    setError(null);
    cancelRequested.current = false;
    const request = ++generation.current;
    void refreshOverview().catch((cause) => {
      if (isCurrentContext() && generation.current === request) setError(message(cause));
    });
  }, [isCurrentContext, refreshOverview]);

  const checkZotero = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await readZoteroStatus(input.environmentId);
      if (isCurrentContext()) setZoteroStatus(status);
      return status;
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause));
      return null;
    } finally {
      if (isCurrentContext()) setBusy(false);
    }
  }, [input.environmentId, isCurrentContext]);

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
            const seen = new Set(items.map((item) => item.externalReference.itemKey));
            for (const item of page.items) {
              if (!seen.has(item.externalReference.itemKey)) items.push(item);
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
        if (isCurrentContext()) setPreflight(result);
      } catch (cause) {
        if (isCurrentContext()) setError(message(cause));
      } finally {
        if (isCurrentContext()) setBusy(false);
      }
    },
    [input.environmentId, input.root, isCurrentContext],
  );

  const runImport = useCallback(
    async (itemKeys: ReadonlyArray<string>) => {
      setBusy(true);
      setCancelling(false);
      setError(null);
      cancelRequested.current = false;
      const request = ++generation.current;
      try {
        let next = await beginZoteroItemsImport(input.environmentId, {
          root: input.root,
          operationId: randomUUID(),
          itemKeys,
        });
        if (isCurrentContext() && generation.current === request) setOperation(next);
        while (
          !cancelRequested.current &&
          next.state === "running" &&
          next.items.some((item) => item.state === "pending")
        ) {
          next = await advanceZoteroItemsImport(input.environmentId, {
            root: input.root,
            operationId: next.operationId,
          });
          if (!isCurrentContext() || generation.current !== request) return;
          setOperation(next);
        }
        if (isCurrentContext() && generation.current === request) {
          setOperation(next);
          setPreflight(null);
          setLibrary(null);
          await refreshOverview();
        }
      } catch (cause) {
        if (isCurrentContext() && generation.current === request) setError(message(cause));
      } finally {
        if (isCurrentContext() && generation.current === request) setBusy(false);
      }
    },
    [input.environmentId, input.root, isCurrentContext, refreshOverview],
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
        next = await advanceZoteroItemsImport(input.environmentId, {
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
      const cancelled = await cancelZoteroItemsImport(input.environmentId, {
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
    cancelling,
    error,
    overview,
    zoteroStatus,
    library,
    preflight,
    operation,
    checkZotero,
    searchZotero,
    previewImport,
    runImport,
    cancelImport,
    resumeImport,
    refreshOverview,
    reloadOverview,
    closeZoteroStatus: () => setZoteroStatus(null),
    closeLibrary: () => setLibrary(null),
    clearOperationSummary: () => setOperation(null),
    resetImport: () => setPreflight(null),
  } as const;
}
