import type {
  PdfSourceActions,
  PdfSourceDescriptor,
  PdfSourceResolution,
  PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { LegendList } from "@legendapp/list/react";
import { EnvironmentId } from "@t3tools/contracts";
import { Download, FileText, ListTree, LoaderCircle, RotateCw, FolderSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { toastManager } from "~/components/ui/toast";
import { ensureLocalApi } from "~/localApi";
import { DocumentReaderControls } from "../writing/DocumentReaderControls";
import { attachShortcutHost } from "../keyboard/host";
import { useHostedReaderShortcuts } from "../writing/readerBarHost";
import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";

import { PdfOutline } from "./PdfOutline";
import { useRetainedPdfSource } from "./useRetainedPdfSource";
import { announcePdfSaveCopyResult } from "./pdfSaveCopyNotification";
import { observePdfCopy } from "./pdfCopyAnalytics";
import { PdfThumbnail } from "./PdfThumbnail";
import { webPdfSourceActions, webPdfSourceResolver } from "./pdfSource";
import { parseSafePdfExternalUrl, stepPdfZoom, type PdfSidebarMode } from "./pdfReaderModel";
import { pdfReaderSessionDocumentKey, pdfReaderSessionStore } from "./pdfReaderSessionStore";
import { usePresentedPdfSourceBundle } from "./usePresentedPdfSourceBundle";
import { useScientPdfReader } from "./useScientPdfReader";

import "pdfjs-dist/legacy/web/pdf_viewer.css";
import "./scientPdfReader.css";

const PDF_SOURCE_SYNC_HINT_DELAY_MS = 300;
const PDF_SOURCE_SYNC_HINT_VISIBLE_MS = 4_000;

let pdfSourceSyncHintLearnedThisSession = false;

export interface PdfForwardSyncTarget {
  readonly requestId: number;
  readonly page: number;
  readonly x: number;
  readonly y: number;
}

export interface PdfInverseSyncPoint {
  readonly page: number;
  readonly x: number;
  readonly y: number;
}

export interface PdfSyncNavigation {
  readonly forwardTarget: PdfForwardSyncTarget | null;
  readonly onInverseSearch?: (point: PdfInverseSyncPoint) => void;
  readonly onPageChange: (page: number) => void;
}

function PdfPasswordPrompt(props: {
  readonly incorrect: boolean;
  readonly onSubmit: (password: string) => boolean;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="scient-pdf-state-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.onSubmit(password)) setPassword("");
      }}
    >
      <FileText className="size-6 text-muted-foreground" aria-hidden="true" />
      <h2>Password protected PDF</h2>
      <p>
        {props.incorrect
          ? "That password is incorrect. Try again."
          : "Enter the password to open this PDF."}
      </p>
      <div className="flex w-full max-w-72 gap-2">
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="scient-pdf-password-input"
          aria-label="PDF password"
        />
        <button type="submit" className="scient-pdf-primary-button" disabled={!password}>
          Open
        </button>
      </div>
    </form>
  );
}

export function ScientPdfReader(props: {
  readonly readerScope?: string | undefined;
  /** LaTeX reports build freshness in its own header. */
  readonly showStaleNotice?: boolean;
  readonly actions?: PdfSourceActions;
  readonly refreshKey?: number;
  readonly resolver?: PdfSourceResolver;
  readonly source: PdfSourceDescriptor;
  readonly syncNavigation?: PdfSyncNavigation;
}) {
  const resolver = props.resolver ?? webPdfSourceResolver;
  const asset = resolver.useResolve(props.source);
  const legacyDocumentKey = pdfReaderSessionDocumentKey(props.source);
  const documentKey = pdfReaderSessionDocumentKey(props.source, props.readerScope);
  const displayed = useRetainedPdfSource(documentKey, props.source, asset);
  // Remounts the loaded reader so a failed document download is fetched again
  // even when the renewed authorization yields the same URL.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const refreshAsset = asset.refresh;
  const retryLoad = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
    refreshAsset();
  }, [refreshAsset]);
  const previousRefreshKey = useRef(props.refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    asset.refresh();
  }, [asset.refresh, props.refreshKey]);
  if (asset._tag === "Failure" && displayed === null) {
    return (
      <div className="scient-pdf-reader">
        <div className="scient-pdf-state-card" role="alert">
          <FileText className="size-6 text-muted-foreground/70" aria-hidden="true" />
          <h2>Couldn't open this PDF</h2>
          <p>Scient could not create an authorized preview for this file.</p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={asset.waiting === true}
            aria-busy={asset.waiting === true}
            onClick={asset.refresh}
          >
            <RefreshIcon size="xs" refreshing={asset.waiting === true} />
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (displayed === null) {
    return (
      <div className="scient-pdf-reader">
        <div className="scient-pdf-state-card">
          <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <p>Preparing PDF…</p>
        </div>
      </div>
    );
  }
  return (
    <LoadedScientPdfReader
      key={`${documentKey}\0${loadAttempt}`}
      documentKey={documentKey}
      legacyDocumentKey={legacyDocumentKey}
      source={displayed.source}
      sourceAsset={displayed.asset}
      interactionReady={asset._tag === "Success"}
      sourceNotice={
        asset._tag === "Failure"
          ? "Unable to load the updated PDF. Showing the previous revision."
          : asset._tag === "Loading"
            ? "Loading the updated PDF…"
            : props.showStaleNotice !== false &&
                props.source._tag === "generated-pdf" &&
                props.source.bindingStatus === "stale"
              ? "PDF is out of date. Showing the previous revision."
              : null
      }
      refreshSource={asset.refresh}
      onRetryLoad={retryLoad}
      actions={props.actions ?? webPdfSourceActions}
      {...(props.syncNavigation === undefined ? {} : { syncNavigation: props.syncNavigation })}
    />
  );
}

function LoadedScientPdfReader(props: {
  readonly sourceNotice: string | null;
  readonly interactionReady: boolean;
  readonly actions: PdfSourceActions;
  readonly documentKey: string;
  readonly legacyDocumentKey: string;
  readonly source: PdfSourceDescriptor;
  readonly sourceAsset: Extract<PdfSourceResolution, { readonly _tag: "Success" }>;
  readonly refreshSource: () => void;
  /** Fetches the document again after a failed load. */
  readonly onRetryLoad: () => void;
  readonly syncNavigation?: PdfSyncNavigation;
}) {
  const requestedRevisionId =
    props.source._tag === "generated-pdf" ? props.source.revisionId : null;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);
  const [sidebar, setSidebarState] = useState<PdfSidebarMode>(() => {
    // Adopt the old document-wide position once, then keep this view independent.
    pdfReaderSessionStore.seed(
      props.documentKey,
      pdfReaderSessionStore.get(props.legacyDocumentKey),
    );
    return pdfReaderSessionStore.get(props.documentKey).sidebar;
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(0);
  const [savingCopy, setSavingCopy] = useState(false);
  const saveCopyPendingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (command: string) =>
    commandKeys(command)
      .map((keys) => labelKeys(keys))
      .join(" / ");
  const keyboardAction = useRef<(command: string) => boolean>(() => false);
  keyboardAction.current = (command) => {
    if (command === "pdf.find") {
      setSearchOpen(true);
      setSearchFocus((request) => request + 1);
    } else if (state.phase !== "ready") return false;
    else if (command === "pdf.zoomIn") reader.setZoom(stepPdfZoom(state.scale, "in"));
    else if (command === "pdf.zoomOut") reader.setZoom(stepPdfZoom(state.scale, "out"));
    else if (command === "pdf.actualSize") reader.setZoomMode("page-actual");
    else return false;
    return true;
  };
  useEffect(() => {
    const root = rootRef.current;
    return root
      ? attachShortcutHost(root, "pdf", {
          execute: (command) => keyboardAction.current(command),
          accepts: (event, command) =>
            command === "pdf.find" ||
            !(
              event.target instanceof Element &&
              event.target.closest("input,textarea,[contenteditable='true']")
            ),
        })
      : undefined;
  }, []);
  useHostedReaderShortcuts(keyboardAction);
  const sourceSyncHintShowTimerRef = useRef<number | null>(null);
  const sourceSyncHintHideTimerRef = useRef<number | null>(null);
  const [sourceSyncHintVisible, setSourceSyncHintVisible] = useState(false);
  const reader = useScientPdfReader({
    documentKey: props.documentKey,
    onSourceInvalidated: props.refreshSource,
    revisionId: requestedRevisionId,
    sourceUrl: props.sourceAsset.url,
    container,
    viewerElement,
  });
  const { state } = reader;
  const presentedSource = usePresentedPdfSourceBundle({
    documentKey: props.documentKey,
    source: props.source,
    asset: props.sourceAsset,
    presentation: reader.presentation,
  });
  const currentPresentation =
    props.interactionReady &&
    state.phase === "ready" &&
    reader.presentation?.revisionId === requestedRevisionId &&
    reader.presentation.sourceUrl === props.sourceAsset.url;
  const thumbnailPages = useMemo(
    () => Array.from({ length: state.pageCount }, (_, index) => index + 1),
    [state.pageCount],
  );

  const setSidebar = useCallback(
    (next: PdfSidebarMode) => {
      setSidebarState(next);
      pdfReaderSessionStore.updateSidebar(props.documentKey, next);
    },
    [props.documentKey],
  );

  const onSyncPageChange = props.syncNavigation?.onPageChange;
  useEffect(() => {
    if (state.phase === "ready") onSyncPageChange?.(state.page);
  }, [onSyncPageChange, state.page, state.phase]);
  useEffect(() => {
    if (!searchOpen) return;
    reader.prepareSearch();
  }, [reader.prepareSearch, searchOpen]);
  useEffect(() => {
    const target = props.syncNavigation?.forwardTarget;
    if (target === null || target === undefined || !currentPresentation) return;
    reader.goToSyncPoint(target);
  }, [props.syncNavigation?.forwardTarget, reader.goToSyncPoint, currentPresentation]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    reader.closeSearch();
  }, [reader.closeSearch]);

  const saveCopy = useCallback(async () => {
    if (saveCopyPendingRef.current || presentedSource === null) return;
    const bundle = presentedSource;
    saveCopyPendingRef.current = true;
    setSavingCopy(true);
    try {
      const result = await observePdfCopy(EnvironmentId.make(bundle.source.authority), () =>
        props.actions.saveCopy(bundle.source, bundle.resolved),
      );
      const presentation = announcePdfSaveCopyResult(result);
      if (presentation.refreshSource) bundle.resolved.refresh();
    } catch {
      toastManager.add({
        type: "error",
        title: "The PDF could not be saved",
        description: "Try again or choose another location.",
      });
    } finally {
      saveCopyPendingRef.current = false;
      setSavingCopy(false);
    }
  }, [presentedSource, props.actions]);

  const clearSourceSyncHintTimers = useCallback(() => {
    if (sourceSyncHintShowTimerRef.current !== null) {
      window.clearTimeout(sourceSyncHintShowTimerRef.current);
      sourceSyncHintShowTimerRef.current = null;
    }
    if (sourceSyncHintHideTimerRef.current !== null) {
      window.clearTimeout(sourceSyncHintHideTimerRef.current);
      sourceSyncHintHideTimerRef.current = null;
    }
  }, []);

  const dismissSourceSyncHint = useCallback(() => {
    clearSourceSyncHintTimers();
    setSourceSyncHintVisible(false);
  }, [clearSourceSyncHintTimers]);

  const showSourceSyncHint = useCallback(() => {
    if (sourceSyncHintHideTimerRef.current !== null) {
      window.clearTimeout(sourceSyncHintHideTimerRef.current);
    }
    setSourceSyncHintVisible(true);
    sourceSyncHintHideTimerRef.current = window.setTimeout(() => {
      sourceSyncHintHideTimerRef.current = null;
      setSourceSyncHintVisible(false);
    }, PDF_SOURCE_SYNC_HINT_VISIBLE_MS);
  }, []);

  useEffect(() => clearSourceSyncHintTimers, [clearSourceSyncHintTimers]);

  const scheduleSourceSyncHint = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (
        props.syncNavigation?.onInverseSearch === undefined ||
        !currentPresentation ||
        pdfSourceSyncHintLearnedThisSession ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("a, button, input, select, textarea, [contenteditable='true']")) return;
      if (target.closest(".page[data-page-number]") === null) return;
      if (window.getSelection()?.isCollapsed === false) return;

      if (sourceSyncHintVisible) {
        showSourceSyncHint();
        return;
      }
      if (sourceSyncHintShowTimerRef.current !== null) return;

      sourceSyncHintShowTimerRef.current = window.setTimeout(() => {
        sourceSyncHintShowTimerRef.current = null;
        if (pdfSourceSyncHintLearnedThisSession || window.getSelection()?.isCollapsed === false) {
          return;
        }
        showSourceSyncHint();
      }, PDF_SOURCE_SYNC_HINT_DELAY_MS);
    },
    [
      props.syncNavigation?.onInverseSearch,
      showSourceSyncHint,
      sourceSyncHintVisible,
      currentPresentation,
    ],
  );

  const onReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Escape") return;
    if (sourceSyncHintVisible || sourceSyncHintShowTimerRef.current !== null) {
      event.preventDefault();
      event.stopPropagation();
      dismissSourceSyncHint();
    } else if (searchOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }
  };

  const canRevealSource =
    props.source.capabilities.canRevealSource && props.actions.revealSource !== undefined;
  const canSaveCopy = presentedSource?.source.capabilities.canSaveCopy === true;
  const hasSourceActions = canSaveCopy || canRevealSource;

  return (
    <div
      ref={rootRef}
      className="scient-pdf-reader"
      aria-label={`PDF reader: ${props.source.fileName}`}
      onKeyDown={onReaderKeyDown}
    >
      <DocumentReaderControls
        label="PDF"
        ready={state.phase === "ready"}
        page={state.page}
        pageCount={state.pageCount}
        scale={state.scale}
        sidebarOpen={sidebar !== "closed"}
        searchOpen={searchOpen}
        onPage={reader.goToPage}
        onZoom={reader.setZoom}
        onActualSize={() => reader.setZoomMode("page-actual")}
        onFitWidth={() => reader.setZoomMode("page-width")}
        onToggleSidebar={() => setSidebar(sidebar === "closed" ? "thumbnails" : "closed")}
        onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        onShowSearch={() => {
          setSearchOpen(true);
          setSearchFocus((request) => request + 1);
        }}
        search={{
          query: searchQuery,
          current: state.findCount.current,
          total: state.findCount.total,
          notFound: state.findPhase === "not-found",
          focusRequest: searchFocus,
          onFocus: () => setSearchOpen(true),
          onQuery: (value) => {
            setSearchOpen(true);
            setSearchQuery(value);
            reader.setSearchQuery(value);
          },
          onNavigate: reader.findAgain,
          onClear: closeSearch,
        }}
        shortcutLabel={shortcutLabel}
        moreActions={
          <>
            <DropdownMenuItem
              closeOnClick={false}
              disabled={state.phase !== "ready"}
              onClick={reader.rotate}
            >
              <RotateCw /> Rotate clockwise
            </DropdownMenuItem>
            {hasSourceActions ? <DropdownMenuSeparator /> : null}
            {canSaveCopy ? (
              <DropdownMenuItem disabled={savingCopy} onClick={() => void saveCopy()}>
                {savingCopy ? <LoaderCircle className="animate-spin" /> : <Download />}
                {savingCopy ? "Saving copy…" : "Save a copy"}
              </DropdownMenuItem>
            ) : null}
            {canRevealSource ? (
              <DropdownMenuItem
                onClick={() =>
                  props.actions.revealSource?.(props.source, {
                    url: props.sourceAsset.url,
                    expiresAt: props.sourceAsset.expiresAt,
                    refresh: props.refreshSource,
                  })
                }
              >
                <FolderSearch /> Reveal source
              </DropdownMenuItem>
            ) : null}
          </>
        }
      />
      {state.scanned === true && state.phase === "ready" ? (
        <div className="scient-pdf-notice">
          No selectable text was detected on the opening pages. Search and copying may be limited.
        </div>
      ) : null}
      <div className="scient-pdf-body">
        {sidebar !== "closed" && state.phase === "ready" && reader.runtimeRef.current ? (
          <aside className="scient-pdf-sidebar" aria-label="PDF navigation">
            <div className="scient-pdf-sidebar-tabs">
              <button
                type="button"
                data-active={sidebar === "thumbnails" || undefined}
                onClick={() => setSidebar("thumbnails")}
              >
                <FileText /> Pages
              </button>
              <button
                type="button"
                data-active={sidebar === "outline" || undefined}
                onClick={() => setSidebar("outline")}
              >
                <ListTree /> Outline
              </button>
            </div>
            <div className="scient-pdf-sidebar-content">
              {sidebar === "thumbnails" ? (
                <LegendList<number>
                  data={thumbnailPages}
                  keyExtractor={(pageNumber) => String(pageNumber)}
                  estimatedItemSize={205}
                  drawDistance={410}
                  className="scient-pdf-thumbnails"
                  renderItem={({ item: pageNumber }) => (
                    <PdfThumbnail
                      pageNumber={pageNumber}
                      active={state.page === pageNumber}
                      runtime={reader.runtimeRef.current!}
                      onSelect={reader.goToPage}
                    />
                  )}
                />
              ) : (
                <PdfOutline
                  items={state.outline}
                  onDestination={reader.goToDestination}
                  onExternalUrl={(rawUrl) => {
                    const url = parseSafePdfExternalUrl(rawUrl);
                    if (url)
                      void ensureLocalApi()
                        .shell.openExternal(url)
                        .catch(() => undefined);
                  }}
                />
              )}
            </div>
          </aside>
        ) : null}
        <div className="scient-pdf-content">
          <div
            ref={setContainer}
            className="scient-pdf-presentation-mount"
            tabIndex={0}
            onClick={scheduleSourceSyncHint}
            onDoubleClick={(event) => {
              dismissSourceSyncHint();
              if (!currentPresentation) return;
              const onInverseSearch = props.syncNavigation?.onInverseSearch;
              if (onInverseSearch === undefined) return;
              // An editable page uses the ordinary click gesture. Keep inverse
              // search available in Split without making a direct edit also navigate.
              const target = event.target;
              if (!(target instanceof Element)) return;
              const pageElement = target.closest<HTMLElement>(".page[data-page-number]");
              if (pageElement === null) return;
              const point = reader.syncPointFromClient({
                pageElement,
                clientX: event.clientX,
                clientY: event.clientY,
              });
              if (point !== null) {
                pdfSourceSyncHintLearnedThisSession = true;
                onInverseSearch(point);
              }
            }}
            onScrollCapture={dismissSourceSyncHint}
          >
            <div ref={setViewerElement} className="scient-pdf-presentation-layers" />
          </div>
          {props.sourceNotice || state.updateError ? (
            <div className="scient-pdf-update-notice" role="status">
              {state.updateError ?? props.sourceNotice}
            </div>
          ) : null}
          {sourceSyncHintVisible ? (
            <div className="scient-pdf-source-sync-hint" role="status">
              Double-click a PDF word to show its matching source line
            </div>
          ) : null}
          {state.phase === "loading" ? (
            <div className="scient-pdf-state-overlay">
              <div className="scient-pdf-state-card">
                <LoaderCircle
                  className="size-6 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
                <p>Loading PDF…</p>
                {state.progress !== null && state.progress < 1 ? (
                  <div
                    className="scient-pdf-progress"
                    role="progressbar"
                    aria-valuenow={Math.round(state.progress * 100)}
                  >
                    <span style={{ width: `${Math.round(state.progress * 100)}%` }} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : state.phase === "password" ? (
            <div className="scient-pdf-state-overlay">
              <PdfPasswordPrompt
                incorrect={state.passwordReason === "incorrect"}
                onSubmit={reader.submitPassword}
              />
            </div>
          ) : state.phase === "error" ? (
            <div className="scient-pdf-state-overlay">
              <div className="scient-pdf-state-card" role="alert">
                <FileText className="size-6 text-muted-foreground/70" aria-hidden="true" />
                <h2>Couldn't open this PDF</h2>
                <p>{state.error}</p>
                <Button type="button" size="xs" variant="outline" onClick={props.onRetryLoad}>
                  <RefreshIcon size="xs" />
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
