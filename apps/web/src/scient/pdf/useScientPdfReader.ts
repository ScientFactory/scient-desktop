import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  createPdfRuntime,
  FindState,
  startPdfDocumentLoad,
  type PDFOutline,
  type PdfPasswordChallenge,
  type ScientPdfRuntime,
} from "./pdfRuntime";
import { clampPdfPage, nextPdfRotation, normalizePdfZoom } from "./pdfReaderModel";
import {
  createPdfResponsiveZoomController,
  type PdfResponsiveZoomController,
} from "./pdfResponsiveZoom";
import { type PdfViewAreaLocation } from "./pdfReaderSessionStore";
import { createPdfReaderViewportSession } from "./pdfReaderViewportSession";
import {
  createPdfPresentationLayer,
  preparePdfPresentation,
  type PdfPresentationAnchor,
} from "./pdfPresentation";
import { readPdfDocumentTextItems } from "./pdfDocumentTextEvidence";

export type PdfReaderPhase = "loading" | "password" | "ready" | "error";
export type PdfFindPhase = "idle" | "pending" | "found" | "not-found";

export interface PdfFindCount {
  readonly current: number;
  readonly total: number;
}

export interface PdfReaderState {
  readonly updating?: boolean;
  readonly updateError?: string | null;
  readonly loadedSourceUrl?: string;
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

/**
 * The source identity which owns the currently painted PDF surface. A requested
 * replacement is deliberately absent here until its canvases and text layers
 * have passed the presentation fence.
 */
export interface RequestedPdfPresentation {
  readonly documentKey: string;
  readonly revisionId: string | null;
  readonly sourceUrl: string;
}

export interface PresentedPdfSource extends RequestedPdfPresentation {
  readonly container: HTMLDivElement;
}

export interface PresentedPdfTextEvidence {
  readonly revisionId: string | null;
  readonly items: readonly string[];
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

const ALWAYS_PUBLISH_PRESENTATION = (_candidate: RequestedPdfPresentation) => true;

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
    const content = await page.getTextContent();
    if (!isCurrent()) return null;
    if (content.items.some((item) => "str" in item && item.str.trim().length > 0)) return false;
  }
  return true;
}

export function useScientPdfReader(input: {
  /**
   * Rechecked at the presentation fence. A producer may temporarily hold a
   * replacement while its owning source is changing without disturbing the
   * PDF that is already painted.
   */
  readonly canPublishPresentation?: (candidate: RequestedPdfPresentation) => boolean;
  readonly documentKey: string;
  readonly onSourceInvalidated: () => void;
  readonly revisionId: string | null;
  readonly sourceUrl: string;
  readonly container: HTMLDivElement | null;
  readonly viewerElement: HTMLDivElement | null;
}) {
  const [state, setState] = useState<PdfReaderState>(INITIAL_STATE);
  const runtimeRef = useRef<ScientPdfRuntime | null>(null);
  const [presentation, setPresentation] = useState<PresentedPdfSource | null>(null);
  const presentationRef = useRef<
    (PresentedPdfSource & { readonly runtime: ScientPdfRuntime }) | null
  >(null);
  const documentTextItemsRef = useRef(
    new WeakMap<ScientPdfRuntime["document"], Promise<readonly string[] | null>>(),
  );
  const disposePresentedRef = useRef<(() => void) | null>(null);
  const anchorProviderRef = useRef<(() => PdfPresentationAnchor | null) | null>(null);
  const invalidateRef = useRef(input.onSourceInvalidated);
  invalidateRef.current = input.onSourceInvalidated;
  const canPublishPresentation = input.canPublishPresentation ?? ALWAYS_PUBLISH_PRESENTATION;
  const canPublishPresentationRef = useRef(canPublishPresentation);
  const requestedSourceRef = useRef({
    documentKey: input.documentKey,
    revisionId: input.revisionId,
    url: input.sourceUrl,
  });
  useLayoutEffect(() => {
    canPublishPresentationRef.current = canPublishPresentation;
    requestedSourceRef.current = {
      documentKey: input.documentKey,
      revisionId: input.revisionId,
      url: input.sourceUrl,
    };
  }, [canPublishPresentation, input.documentKey, input.revisionId, input.sourceUrl]);
  const responsiveZoomRef = useRef<PdfResponsiveZoomController | null>(null);
  const passwordRef = useRef<PdfPasswordChallenge["submit"] | null>(null);
  const activeSearchQueryRef = useRef("");
  const syncMarkerRef = useRef<HTMLElement | null>(null);
  const syncMarkerFrameRef = useRef<number | null>(null);
  const syncMarkerTimerRef = useRef<number | null>(null);
  const documentKeyRef = useRef(input.documentKey);
  if (documentKeyRef.current !== input.documentKey) {
    documentKeyRef.current = input.documentKey;
    activeSearchQueryRef.current = "";
  }

  const clearSyncMarker = useCallback(() => {
    if (syncMarkerFrameRef.current !== null) {
      cancelAnimationFrame(syncMarkerFrameRef.current);
      syncMarkerFrameRef.current = null;
    }
    if (syncMarkerTimerRef.current !== null) {
      window.clearTimeout(syncMarkerTimerRef.current);
      syncMarkerTimerRef.current = null;
    }
    syncMarkerRef.current?.remove();
    syncMarkerRef.current = null;
  }, []);

  useEffect(() => {
    clearSyncMarker();
    return clearSyncMarker;
  }, [clearSyncMarker, input.sourceUrl]);

  // Document lifetime is distinct from revision-request lifetime. In particular,
  // an asset callback change must not tear down a displayed PDF.
  useEffect(
    () => () => {
      disposePresentedRef.current?.();
      disposePresentedRef.current = null;
      presentationRef.current = null;
      runtimeRef.current = null;
      responsiveZoomRef.current = null;
    },
    [input.container, input.viewerElement, input.documentKey],
  );

  useEffect(() => {
    if (!input.container || !input.viewerElement) return;
    const requestedPresentation: RequestedPdfPresentation = {
      documentKey: input.documentKey,
      revisionId: input.revisionId,
      sourceUrl: input.sourceUrl,
    };
    const settleOnPresentedRevision = () => {
      if (presentationRef.current === null) return;
      setState((previous) =>
        previous.updating
          ? { ...previous, phase: "ready", updating: false, updateError: null }
          : previous,
      );
    };
    if (
      presentationRef.current?.documentKey === input.documentKey &&
      presentationRef.current.revisionId === input.revisionId &&
      presentationRef.current.sourceUrl === input.sourceUrl
    ) {
      settleOnPresentedRevision();
      return;
    }
    // A gate may freeze replacements, never the first readable PDF. Documents
    // without source evidence (legacy, unsupported, or truncated) still open
    // normally and simply remain read-only to their producer's interaction.
    if (presentationRef.current !== null && !canPublishPresentation(requestedPresentation)) {
      settleOnPresentedRevision();
      return;
    }
    const { container, viewerElement } = createPdfPresentationLayer(input.viewerElement);
    const abortController = new AbortController();
    let current = true;
    let requested = true;
    const isRequested = () =>
      requested &&
      requestedSourceRef.current.documentKey === input.documentKey &&
      requestedSourceRef.current.revisionId === input.revisionId &&
      requestedSourceRef.current.url === input.sourceUrl &&
      (presentationRef.current === null ||
        canPublishPresentationRef.current(requestedPresentation));
    let candidate: ScientPdfRuntime | null = null;
    let searchWarmupHandle: number | null = null;
    let searchWarmupKind: "idle" | "timeout" | null = null;
    let pinchFrame: number | null = null;
    let pendingPinchFactor = 1;
    let pendingPinchOrigin: [number, number] = [0, 0];
    let onPinchWheel: ((event: WheelEvent) => void) | null = null;
    const viewportSession = createPdfReaderViewportSession({ documentKey: input.documentKey });
    const responsiveZoom = createPdfResponsiveZoomController();
    if (runtimeRef.current)
      setState((previous) => ({ ...previous, updating: true, updateError: null }));
    else setState(INITIAL_STATE);
    const loadingTask = startPdfDocumentLoad(input.sourceUrl, {
      onPassword: ({ reason, submit }) => {
        if (!isRequested()) return;
        passwordRef.current = submit;
        setState((previous) => ({
          ...previous,
          phase: "password",
          passwordReason: reason,
          error: null,
        }));
      },
      onProgress: (loaded, total) => {
        if (!isRequested() || runtimeRef.current) return;
        setState((previous) => ({
          ...previous,
          progress: total && total > 0 ? Math.min(loaded / total, 1) : null,
        }));
      },
    });

    void loadingTask.promise
      .then(async (document) => {
        if (!isRequested()) return;
        const runtime = createPdfRuntime({
          container,
          viewerElement,
          document,
          loadingTask,
          onContainerResize: (viewer) => responsiveZoom.reconcile(viewer, container.clientWidth),
          sourceUrl: input.sourceUrl,
        });
        candidate = runtime;
        const displayed = () => current && runtimeRef.current === runtime;
        let preparedOutline: PDFOutline = [];
        let preparedScanned: boolean | null = null;

        const onPagesInit = () => {
          const restoredPage = viewportSession.restore(runtime.viewer, runtime.document.numPages);
          responsiveZoom.capturePreference(runtime.viewer);
          const publish = () => {
            // A newer React commit can precede passive-effect cancellation.
            // Check committed source identity as well as the request lifetime.
            if (!isRequested()) return;
            const disposeOld = disposePresentedRef.current;
            const previousZoom = responsiveZoomRef.current?.persistedScaleValue();
            if (previousZoom)
              responsiveZoom.capturePreference({
                currentScale: runtime.viewer.currentScale,
                currentScaleValue: previousZoom,
              });
            const nextPresentation = {
              container,
              documentKey: input.documentKey,
              revisionId: input.revisionId,
              runtime,
              sourceUrl: input.sourceUrl,
            } satisfies PresentedPdfSource & { readonly runtime: ScientPdfRuntime };
            runtimeRef.current = runtime;
            responsiveZoomRef.current = responsiveZoom;
            presentationRef.current = nextPresentation;
            disposePresentedRef.current = dispose;
            container.classList.remove("scient-pdf-staging");
            container.removeAttribute("aria-hidden");
            container.inert = false;
            viewportSession.completeRestore();
            // One synchronous publication: interaction host, viewport and painted
            // surface become current together, before the browser's next paint.
            flushSync(() => {
              setPresentation(nextPresentation);
              setState((previous) => ({
                ...previous,
                phase: "ready",
                updating: false,
                updateError: null,
                loadedSourceUrl: input.sourceUrl,
                page: runtime.viewer.currentPageNumber || restoredPage,
                pageCount: runtime.document.numPages,
                progress: 1,
                rotation: runtime.viewer.pagesRotation,
                scale: runtime.viewer.currentScale,
                outline: preparedOutline,
                scanned: preparedScanned,
              }));
            });
            disposeOld?.();

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
          void preparePdfPresentation({
            runtime,
            container,
            current: () => presentationRef.current,
            captureAnchor: () => anchorProviderRef.current?.() ?? null,
            signal: abortController.signal,
          })
            .then(publish)
            .catch(fail);
        };
        const onPageChanging = ({ pageNumber }: { pageNumber: number }) => {
          if (!displayed()) return;
          setState((previous) => ({ ...previous, page: pageNumber }));
          runtime.refreshForContainerSize();
        };
        const onScaleChanging = ({
          scale,
          presetValue,
        }: {
          scale: number;
          presetValue?: string;
        }) => {
          if (!displayed()) return;
          if (responsiveZoom.observeScaleChange(runtime.viewer, scale, presetValue)) {
            runtime.cancelContainerSizeRefresh();
          }
          setState((previous) => ({ ...previous, scale }));
        };
        const onRotationChanging = ({ pagesRotation }: { pagesRotation: number }) => {
          if (!displayed()) return;
          setState((previous) => ({ ...previous, rotation: pagesRotation }));
          runtime.refreshForContainerSize();
        };
        const onUpdateViewArea = ({ location }: { location?: PdfViewAreaLocation }) => {
          if (!displayed()) return;
          viewportSession.updateFromViewArea(location, responsiveZoom.persistedScaleValue());
        };
        const onFindCount = ({
          matchesCount,
        }: {
          matchesCount?: { current?: number; total?: number };
        }) => {
          if (!displayed()) return;
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
          if (!displayed()) return;
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
          if (!displayed()) return;
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
            runtime.cancelContainerSizeRefresh();
            responsiveZoom.rememberScale(targetScale);
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
        preparedOutline = outline;
        if (displayed()) setState((previous) => ({ ...previous, outline }));
        const scanned = await detectScannedDocument(runtime, () => current).catch(() => null);
        preparedScanned = scanned;
        if (displayed()) setState((previous) => ({ ...previous, scanned }));
      })
      .catch(fail);

    function fail(error: unknown) {
      if (
        !isRequested() ||
        (error instanceof Error && (error.name === "AbortException" || error.name === "AbortError"))
      )
        return;
      if (isChangedPdfSource(error)) {
        invalidateRef.current();
        dispose();
        return;
      }
      setState((previous) => ({
        ...previous,
        phase: runtimeRef.current ? "ready" : "error",
        updating: false,
        updateError: runtimeRef.current ? pdfErrorMessage(error) : null,
        error: runtimeRef.current ? null : pdfErrorMessage(error),
        passwordReason: null,
      }));
      dispose();
    }

    function dispose() {
      if (!current) return;
      current = false;
      abortController.abort();
      passwordRef.current = null;
      if (searchWarmupHandle !== null) {
        if (searchWarmupKind === "idle") window.cancelIdleCallback(searchWarmupHandle);
        else window.clearTimeout(searchWarmupHandle);
      }
      if (pinchFrame !== null) cancelAnimationFrame(pinchFrame);
      if (onPinchWheel) container.removeEventListener("wheel", onPinchWheel);
      const runtime = candidate;
      if (runtime && runtimeRef.current === runtime) {
        viewportSession.snapshot(
          {
            currentPageNumber: runtime.viewer.currentPageNumber,
            currentScale: runtime.viewer.currentScale,
            currentScaleValue: responsiveZoom.persistedScaleValue(),
            pagesRotation: runtime.viewer.pagesRotation,
          },
          runtime.document.numPages,
        );
      }
      viewportSession.flush();
      container.remove();
      void (runtime ? runtime.destroy() : loadingTask.destroy()).catch(() => undefined);
    }
    return () => {
      requested = false;
      // Cancel only an unpublished candidate. The displayed presentation lives
      // until a successor is painted or the document itself is unmounted.
      if (candidate === null || runtimeRef.current !== candidate) dispose();
    };
  }, [
    canPublishPresentation,
    input.container,
    input.documentKey,
    input.revisionId,
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

  const goToSyncPoint = useCallback(
    (target: { page: number; x: number; y: number }) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      clearSyncMarker();
      const page = clampPdfPage(target.page, runtime.document.numPages);
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
        destArray: [null, { name: "XYZ" }, target.x, pageHeight - target.y, null],
        allowNegativeOffset: true,
        ignoreDestinationZoom: true,
      });
      syncMarkerFrameRef.current = requestAnimationFrame(() => {
        syncMarkerFrameRef.current = null;
        const pageElement = presentationRef.current?.container.querySelector<HTMLElement>(
          `.page[data-page-number="${page}"]`,
        );
        if (pageElement === undefined || pageElement === null) return;
        const [rawLeft, rawTop] = pageView.viewport.convertToViewportPoint(
          target.x,
          pageHeight - target.y,
        );
        const marker = document.createElement("span");
        marker.className = "scient-pdf-sync-marker";
        marker.setAttribute("aria-hidden", "true");
        marker.style.left = `${Math.max(0, Math.min(pageElement.clientWidth, rawLeft))}px`;
        marker.style.top = `${Math.max(0, Math.min(pageElement.clientHeight, rawTop))}px`;
        pageElement.append(marker);
        syncMarkerRef.current = marker;
        syncMarkerTimerRef.current = window.setTimeout(() => {
          syncMarkerTimerRef.current = null;
          marker.remove();
          if (syncMarkerRef.current === marker) syncMarkerRef.current = null;
        }, 1_600);
      });
    },
    [clearSyncMarker, input.viewerElement],
  );

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

  const readDocumentTextItems = useCallback(async (): Promise<PresentedPdfTextEvidence | null> => {
    const presented = presentationRef.current;
    if (presented === null) return null;
    let pending = documentTextItemsRef.current.get(presented.runtime.document);
    if (pending === undefined) {
      pending = readPdfDocumentTextItems(presented.runtime.document).catch(() => null);
      documentTextItemsRef.current.set(presented.runtime.document, pending);
    }
    const items = await pending;
    // A text corpus belongs to the presentation that supplied its immutable
    // PDFDocumentProxy. Never return an old corpus after an atomic page swap.
    if (items === null || presentationRef.current !== presented) return null;
    return { revisionId: presented.revisionId, items };
  }, []);

  const setZoom = useCallback((scale: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.cancelContainerSizeRefresh();
    const normalized = responsiveZoomRef.current?.rememberScale(scale) ?? normalizePdfZoom(scale);
    runtime.viewer.currentScale = normalized;
  }, []);

  const setZoomMode = useCallback((mode: "page-width" | "page-fit" | "page-actual") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.cancelContainerSizeRefresh();
    responsiveZoomRef.current?.rememberMode(mode);
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
    presentation,
    registerAnchorProvider: useCallback((provider: (() => PdfPresentationAnchor | null) | null) => {
      anchorProviderRef.current = provider;
    }, []),
    state,
    runtimeRef,
    submitPassword,
    goToPage,
    goToSyncPoint,
    syncPointFromClient,
    readDocumentTextItems,
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
