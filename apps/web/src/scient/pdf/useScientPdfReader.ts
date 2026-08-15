import { useCallback, useEffect, useRef, useState } from "react";

import {
  createPdfRuntime,
  FindState,
  startPdfDocumentLoad,
  type PDFOutline,
  type PdfPasswordChallenge,
  type ScientPdfRuntime,
} from "./pdfRuntime";
import { clampPdfPage, nextPdfRotation, normalizePdfZoom } from "./pdfReaderModel";
import { type PdfViewAreaLocation } from "./pdfReaderSessionStore";
import { createPdfReaderViewportSession } from "./pdfReaderViewportSession";

export type PdfReaderPhase = "loading" | "password" | "ready" | "error";
export type PdfFindPhase = "idle" | "pending" | "found" | "not-found";

export interface PdfFindCount {
  readonly current: number;
  readonly total: number;
}

export interface PdfReaderState {
  readonly error: string | null;
  readonly findCount: PdfFindCount;
  readonly findPhase: PdfFindPhase;
  readonly outline: PDFOutline;
  readonly page: number;
  readonly pageCount: number;
  readonly passwordReason: PdfPasswordChallenge["reason"] | null;
  readonly phase: PdfReaderPhase;
  readonly progress: number | null;
  readonly rotation: number;
  readonly scanned: boolean | null;
  readonly scale: number;
}

const INITIAL_STATE: PdfReaderState = {
  error: null,
  findCount: { current: 0, total: 0 },
  findPhase: "idle",
  outline: [],
  page: 1,
  pageCount: 0,
  passwordReason: null,
  phase: "loading",
  progress: null,
  rotation: 0,
  scanned: null,
  scale: 1,
};

function pdfErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "InvalidPDFException") return "This file is not a valid PDF.";
    if (error.name === "MissingPDFException") return "The PDF could not be found.";
    if (error.name === "UnexpectedResponseException") {
      return "The PDF could not be loaded from this environment.";
    }
  }
  return "The PDF could not be opened.";
}

function isChangedPdfSource(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "UnexpectedResponseException" &&
    "status" in error &&
    error.status === 409
  );
}

async function detectScannedDocument(
  runtime: ScientPdfRuntime,
  isCurrent: () => boolean,
): Promise<boolean | null> {
  const pagesToInspect = Math.min(runtime.document.numPages, 3);
  if (pagesToInspect === 0) return null;
  for (let pageNumber = 1; pageNumber <= pagesToInspect; pageNumber += 1) {
    const page = await runtime.document.getPage(pageNumber);
    const content = await page.getTextContent().finally(() => page.cleanup());
    if (!isCurrent()) return null;
    if (content.items.some((item) => "str" in item && item.str.trim().length > 0)) return false;
  }
  return true;
}

export function useScientPdfReader(input: {
  readonly documentKey: string;
  readonly onSourceInvalidated: () => void;
  readonly sourceUrl: string;
  readonly container: HTMLDivElement | null;
  readonly viewerElement: HTMLDivElement | null;
}) {
  const [state, setState] = useState<PdfReaderState>(INITIAL_STATE);
  const runtimeRef = useRef<ScientPdfRuntime | null>(null);
  const passwordRef = useRef<PdfPasswordChallenge["submit"] | null>(null);
  const activeSearchQueryRef = useRef("");
  const documentKeyRef = useRef(input.documentKey);
  if (documentKeyRef.current !== input.documentKey) {
    documentKeyRef.current = input.documentKey;
    activeSearchQueryRef.current = "";
  }

  useEffect(() => {
    if (!input.container || !input.viewerElement) return;
    const container = input.container;
    const viewerElement = input.viewerElement;
    let current = true;
    let searchWarmupHandle: number | null = null;
    let searchWarmupKind: "idle" | "timeout" | null = null;
    let pinchFrame: number | null = null;
    let restoreFrame: number | null = null;
    let pendingPinchFactor = 1;
    let pendingPinchOrigin: [number, number] = [0, 0];
    let onPinchWheel: ((event: WheelEvent) => void) | null = null;
    const viewportSession = createPdfReaderViewportSession({ documentKey: input.documentKey });
    setState(INITIAL_STATE);
    const loadingTask = startPdfDocumentLoad(input.sourceUrl, {
      onPassword: ({ reason, submit }) => {
        if (!current) return;
        passwordRef.current = submit;
        setState((previous) => ({
          ...previous,
          phase: "password",
          passwordReason: reason,
          error: null,
        }));
      },
      onProgress: (loaded, total) => {
        if (!current) return;
        setState((previous) => ({
          ...previous,
          progress: total && total > 0 ? Math.min(loaded / total, 1) : null,
        }));
      },
    });

    void loadingTask.promise
      .then(async (document) => {
        if (!current) return;
        const runtime = createPdfRuntime({
          container,
          viewerElement,
          document,
          loadingTask,
          sourceUrl: input.sourceUrl,
        });
        runtimeRef.current = runtime;

        const onPagesInit = () => {
          const restoredPage = viewportSession.restore(runtime.viewer, runtime.document.numPages);
          if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
          restoreFrame = requestAnimationFrame(() => {
            restoreFrame = null;
            if (!current) return;
            viewportSession.completeRestore();
            runtime.viewer.update();
          });
          setState((previous) => ({
            ...previous,
            phase: "ready",
            page: restoredPage,
            pageCount: runtime.document.numPages,
            progress: 1,
            rotation: runtime.viewer.pagesRotation,
            scale: runtime.viewer.currentScale,
          }));

          const activeQuery = activeSearchQueryRef.current;
          if (activeQuery.length > 0) {
            runtime.eventBus.dispatch("find", {
              source: runtime,
              type: "",
              query: activeQuery,
              phraseSearch: true,
              caseSensitive: false,
              entireWord: false,
              highlightAll: true,
              findPrevious: false,
              matchDiacritics: true,
            });
            setState((previous) => ({ ...previous, findPhase: "pending" }));
            return;
          }

          const warmSearch = () => {
            searchWarmupHandle = null;
            searchWarmupKind = null;
            if (!current || activeSearchQueryRef.current.length > 0) return;
            runtime.eventBus.dispatch("find", {
              source: runtime,
              type: "",
              query: "",
              phraseSearch: true,
              caseSensitive: false,
              entireWord: false,
              highlightAll: false,
              findPrevious: false,
              matchDiacritics: true,
            });
          };
          if (typeof window.requestIdleCallback === "function") {
            searchWarmupKind = "idle";
            searchWarmupHandle = window.requestIdleCallback(warmSearch, { timeout: 1_500 });
          } else {
            searchWarmupKind = "timeout";
            searchWarmupHandle = window.setTimeout(warmSearch, 750);
          }
        };
        const onPageChanging = ({ pageNumber }: { pageNumber: number }) => {
          setState((previous) => ({ ...previous, page: pageNumber }));
        };
        const onScaleChanging = ({ scale }: { scale: number }) => {
          setState((previous) => ({ ...previous, scale }));
        };
        const onRotationChanging = ({ pagesRotation }: { pagesRotation: number }) => {
          setState((previous) => ({ ...previous, rotation: pagesRotation }));
        };
        const onUpdateViewArea = ({ location }: { location?: PdfViewAreaLocation }) => {
          viewportSession.updateFromViewArea(location);
        };
        const onFindCount = ({
          matchesCount,
        }: {
          matchesCount?: { current?: number; total?: number };
        }) => {
          if (activeSearchQueryRef.current.length === 0) return;
          setState((previous) => ({
            ...previous,
            findCount: {
              current: matchesCount?.current ?? 0,
              total: matchesCount?.total ?? 0,
            },
          }));
        };
        const onFindState = ({
          matchesCount,
          rawQuery,
          state: findState,
        }: {
          matchesCount?: { current?: number; total?: number };
          rawQuery?: string;
          state?: number;
        }) => {
          if (!rawQuery || rawQuery !== activeSearchQueryRef.current) return;
          setState((previous) => ({
            ...previous,
            findCount: {
              current: matchesCount?.current ?? previous.findCount.current,
              total: matchesCount?.total ?? previous.findCount.total,
            },
            findPhase:
              findState === FindState.PENDING
                ? "pending"
                : findState === FindState.NOT_FOUND
                  ? "not-found"
                  : "found",
          }));
        };
        runtime.eventBus.on("pagesinit", onPagesInit);
        runtime.eventBus.on("pagechanging", onPageChanging);
        runtime.eventBus.on("scalechanging", onScaleChanging);
        runtime.eventBus.on("rotationchanging", onRotationChanging);
        runtime.eventBus.on("updateviewarea", onUpdateViewArea);
        runtime.eventBus.on("updatefindmatchescount", onFindCount);
        runtime.eventBus.on("updatefindcontrolstate", onFindState);

        onPinchWheel = (event: WheelEvent) => {
          if (!event.ctrlKey || runtime.viewer.currentScale <= 0) return;
          event.preventDefault();
          pendingPinchFactor *= Math.exp(Math.min(0.5, Math.max(-0.5, -event.deltaY * 0.01)));
          pendingPinchOrigin = [event.clientX, event.clientY];
          if (pinchFrame !== null) return;
          pinchFrame = requestAnimationFrame(() => {
            pinchFrame = null;
            const currentScale = runtime.viewer.currentScale;
            const targetScale = normalizePdfZoom(currentScale * pendingPinchFactor);
            pendingPinchFactor = 1;
            if (targetScale === currentScale) return;
            runtime.viewer.updateScale({
              scaleFactor: targetScale / currentScale,
              origin: pendingPinchOrigin,
              drawingDelay: 250,
            });
          });
        };
        container.addEventListener("wheel", onPinchWheel, { passive: false });

        const outlineResult = await runtime.document.getOutline().catch(() => null);
        const outline = (outlineResult ?? []) as PDFOutline;
        if (current) setState((previous) => ({ ...previous, outline }));
        const scanned = await detectScannedDocument(runtime, () => current).catch(() => null);
        if (current) setState((previous) => ({ ...previous, scanned }));
      })
      .catch((error: unknown) => {
        if (!current || (error instanceof Error && error.name === "AbortException")) return;
        if (isChangedPdfSource(error)) {
          input.onSourceInvalidated();
          return;
        }
        setState((previous) => ({
          ...previous,
          phase: "error",
          error: pdfErrorMessage(error),
          passwordReason: null,
        }));
      });

    return () => {
      current = false;
      passwordRef.current = null;
      if (searchWarmupHandle !== null) {
        if (searchWarmupKind === "idle") window.cancelIdleCallback(searchWarmupHandle);
        else window.clearTimeout(searchWarmupHandle);
      }
      if (pinchFrame !== null) cancelAnimationFrame(pinchFrame);
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      if (onPinchWheel) container.removeEventListener("wheel", onPinchWheel);
      const runtime = runtimeRef.current;
      if (runtime) {
        viewportSession.snapshot(runtime.viewer, runtime.document.numPages);
      }
      viewportSession.flush();
      runtimeRef.current = null;
      void (runtime ? runtime.destroy() : loadingTask.destroy());
    };
  }, [
    input.container,
    input.documentKey,
    input.onSourceInvalidated,
    input.sourceUrl,
    input.viewerElement,
  ]);

  const submitPassword = useCallback((password: string) => {
    const submit = passwordRef.current;
    if (!submit || password.length === 0) return false;
    passwordRef.current = null;
    setState((previous) => ({ ...previous, phase: "loading", passwordReason: null }));
    submit(password);
    return true;
  }, []);

  const goToPage = useCallback((page: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.viewer.currentPageNumber = clampPdfPage(page, runtime.document.numPages);
  }, []);

  const goToSyncPoint = useCallback((input: { page: number; x: number; y: number }) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const page = clampPdfPage(input.page, runtime.document.numPages);
    const pageView = runtime.viewer.getPageView(page - 1);
    const pageHeight = pageView?.viewport.rawDims.pageHeight;
    if (pageHeight === undefined) {
      runtime.viewer.currentPageNumber = page;
      return;
    }
    runtime.viewer.scrollPageIntoView({
      pageNumber: page,
      // SyncTeX measures from the top-left in 72-dpi big points; PDF
      // destinations measure from the bottom-left in the same unit.
      destArray: [null, { name: "XYZ" }, input.x, pageHeight - input.y, null],
      allowNegativeOffset: true,
      ignoreDestinationZoom: true,
    });
  }, []);

  const syncPointFromClient = useCallback(
    (input: { pageElement: HTMLElement; clientX: number; clientY: number }) => {
      const runtime = runtimeRef.current;
      if (!runtime) return null;
      const page = Number(input.pageElement.dataset.pageNumber);
      if (!Number.isSafeInteger(page) || page < 1 || page > runtime.document.numPages) return null;
      const pageView = runtime.viewer.getPageView(page - 1);
      if (!pageView) return null;
      const rect = input.pageElement.getBoundingClientRect();
      const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(
        input.clientX - rect.left,
        input.clientY - rect.top,
      );
      return {
        page,
        x: Math.max(0, pdfX),
        y: Math.max(0, pageView.viewport.rawDims.pageHeight - pdfY),
      };
    },
    [],
  );

  const setZoom = useCallback((scale: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.viewer.currentScale = normalizePdfZoom(scale);
  }, []);

  const setZoomMode = useCallback((mode: "page-width" | "page-fit" | "page-actual") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.viewer.currentScaleValue = mode;
  }, []);

  const rotate = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.viewer.pagesRotation = nextPdfRotation(runtime.viewer.pagesRotation);
  }, []);

  const dispatchFind = useCallback((query: string, type: "" | "again", findPrevious = false) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    activeSearchQueryRef.current = query;
    runtime.eventBus.dispatch("find", {
      source: runtime,
      type,
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: query.length > 0,
      findPrevious,
      matchDiacritics: true,
    });
    if (query.length === 0) {
      setState((previous) => ({
        ...previous,
        findCount: { current: 0, total: 0 },
        findPhase: "idle",
      }));
    } else {
      setState((previous) => ({ ...previous, findPhase: "pending" }));
    }
  }, []);

  const setSearchQuery = useCallback(
    (query: string) => dispatchFind(query, "", false),
    [dispatchFind],
  );

  const findAgain = useCallback(
    (findPrevious = false) => {
      const query = activeSearchQueryRef.current;
      if (query.length > 0) dispatchFind(query, "again", findPrevious);
    },
    [dispatchFind],
  );

  const closeSearch = useCallback(() => {
    activeSearchQueryRef.current = "";
    runtimeRef.current?.eventBus.dispatch("findbarclose", { source: runtimeRef.current });
    setState((previous) => ({
      ...previous,
      findCount: { current: 0, total: 0 },
      findPhase: "idle",
    }));
  }, []);

  const prepareSearch = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || activeSearchQueryRef.current.length > 0) return;
    runtime.eventBus.dispatch("find", {
      source: runtime,
      type: "",
      query: "",
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: false,
      findPrevious: false,
      matchDiacritics: true,
    });
  }, []);

  const goToDestination = useCallback((destination: string | Array<unknown>) => {
    void runtimeRef.current?.linkService.goToDestination(destination as string | Array<unknown>);
  }, []);

  return {
    state,
    runtimeRef,
    submitPassword,
    goToPage,
    goToSyncPoint,
    syncPointFromClient,
    setZoom,
    setZoomMode,
    rotate,
    setSearchQuery,
    findAgain,
    closeSearch,
    prepareSearch,
    goToDestination,
  };
}
