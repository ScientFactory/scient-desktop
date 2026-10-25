import type {
  PdfSourceActions,
  PdfSourceDescriptor,
  PdfSourceResolution,
  PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { LegendList } from "@legendapp/list/react";
import { EnvironmentId, type ContextMenuItem, type ScopedThreadRef } from "@t3tools/contracts";
import { Download, FileText, ListTree, LoaderCircle, FolderSearch, X } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { toastManager } from "~/components/ui/toast";
import { installPdfRetainedSelection } from "./pdfRetainedSelection";
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
import { PdfQuoteLayer } from "./anchors/PdfQuoteLayer";
import { usePdfRevealClaim, usePdfRevealRequest } from "./anchors/pdfRevealRequests";
import { pdfEditSession } from "./pdfEditSession";
import { PdfPageInsertion } from "./PdfPageInsertion";
import { PdfMovePagesPopover } from "./PdfMovePagesPopover";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { savePdfEdits } from "./savePdfEdits";
import { saveEditedPdfCopy } from "./saveEditedPdfCopy";
import { pdfEditedCopyKey, rememberPdfEditedCopy, usePdfEditedCopy } from "./pdfEditedCopyStore";

import "pdfjs-dist/legacy/web/pdf_viewer.css";
import "./scientPdfReader.css";

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
  readonly onInverseSearch?: (point: PdfInverseSyncPoint, selectedText?: string) => void;
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
  /** The conversation "Ask in chat" quotes into; absent means no Ask in chat. */
  readonly citeThread?: ScopedThreadRef | undefined;
}) {
  const resolver = props.resolver ?? webPdfSourceResolver;
  const legacyDocumentKey = pdfReaderSessionDocumentKey(props.source);
  const documentKey = pdfReaderSessionDocumentKey(props.source, props.readerScope);
  // Remembered per original revision, so a rebuild shows the new build.
  const copyKey = pdfEditedCopyKey(documentKey, props.source);
  const savedCopy = usePdfEditedCopy(copyKey);
  const originalReveal = usePdfRevealRequest(legacyDocumentKey);
  const forceOriginal = savedCopy !== null && originalReveal !== null;
  const showingCopy = savedCopy !== null && !savedCopy.showOriginal && !forceOriginal;
  const source = showingCopy ? savedCopy.source : props.source;
  const revealDocumentKey = pdfReaderSessionDocumentKey(source);
  const revealOwner = usePdfRevealClaim(revealDocumentKey);
  useEffect(() => {
    if (forceOriginal && savedCopy && !savedCopy.showOriginal)
      rememberPdfEditedCopy(copyKey, { ...savedCopy, showOriginal: true });
  }, [copyKey, forceOriginal, savedCopy]);
  const asset = resolver.useResolve(source);
  const displayed = useRetainedPdfSource(documentKey, source, asset);
  const editSessionKey = showingCopy
    ? savedCopy.sessionKey
    : savedCopy
      ? JSON.stringify([
          documentKey,
          "original",
          props.source._tag === "generated-pdf" ? props.source.revisionId : null,
          savedCopy.source._tag === "generated-pdf"
            ? savedCopy.source.revisionId
            : savedCopy.source.logicalDocumentKey,
        ])
      : source._tag === "generated-pdf"
        ? JSON.stringify([documentKey, source.revisionId])
        : documentKey;
  const editSession = pdfEditSession(editSessionKey);
  const edit = useSyncExternalStore(editSession.subscribe, editSession.getSnapshot);
  // Only the candidate request changes on retry; the painted reader stays mounted.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const refreshAsset = asset.refresh;
  const retryLoad = () => {
    refreshAsset();
    setLoadAttempt((attempt) => attempt + 1);
  };
  const previousRefreshKey = useRef(props.refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    refreshAsset();
  }, [refreshAsset, props.refreshKey]);
  const authorizationPending = asset._tag === "Loading" || asset.waiting === true;
  const candidateReady = asset._tag === "Success" && !authorizationPending;
  if (asset._tag === "Failure" && displayed === null && !edit.url) {
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
            onClick={retryLoad}
          >
            <RefreshIcon size="xs" refreshing={asset.waiting === true} />
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (displayed === null && !edit.url) {
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
      key={documentKey}
      documentKey={documentKey}
      editSessionKey={editSessionKey}
      revealDocumentKey={revealDocumentKey}
      legacyDocumentKey={legacyDocumentKey}
      source={displayed?.source ?? source}
      copyView={savedCopy ? (showingCopy ? "edited" : "original") : null}
      onSwitchCopy={() => {
        if (!savedCopy) return;
        void editSession.reset().then(() => {
          rememberPdfEditedCopy(copyKey, {
            ...savedCopy,
            showOriginal: !savedCopy.showOriginal,
          });
        });
      }}
      onSavedCopy={(savedSource) => {
        const durable = rememberPdfEditedCopy(copyKey, {
          source: savedSource,
          sessionKey: editSessionKey,
          showOriginal: false,
        });
        if (!durable)
          toastManager.add({
            type: "error",
            title: "Keep a local copy",
            description:
              "The PDF was saved, but its location could not be remembered. Use Save copy before closing Scient.",
          });
      }}
      sourceAsset={
        edit.url
          ? {
              _tag: "Success",
              url: edit.url,
              expiresAt: Number.POSITIVE_INFINITY,
              refresh: asset.refresh,
            }
          : displayed!.asset
      }
      loadAttempt={loadAttempt}
      interactionReady={!!edit.url || candidateReady}
      authorizationPending={!edit.url && authorizationPending}
      authorizationFailed={!edit.url && asset._tag === "Failure"}
      sourceNotice={
        edit.url
          ? null
          : authorizationPending
            ? "Loading the updated PDF…"
            : asset._tag === "Failure"
              ? "Unable to load the updated PDF. Showing the previous revision."
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
      citeThread={props.citeThread}
      revealOwner={revealOwner}
    />
  );
}

function LoadedScientPdfReader(props: {
  readonly sourceNotice: string | null;
  readonly interactionReady: boolean;
  readonly loadAttempt: number;
  readonly authorizationPending: boolean;
  readonly authorizationFailed: boolean;
  readonly actions: PdfSourceActions;
  readonly documentKey: string;
  readonly editSessionKey: string;
  readonly revealDocumentKey: string;
  readonly legacyDocumentKey: string;
  readonly source: PdfSourceDescriptor;
  readonly copyView: "original" | "edited" | null;
  readonly onSwitchCopy: () => void;
  readonly onSavedCopy: (source: PdfSourceDescriptor) => void;
  readonly sourceAsset: Extract<PdfSourceResolution, { readonly _tag: "Success" }>;
  readonly refreshSource: () => void;
  /** Fetches the document again after a failed load. */
  readonly onRetryLoad: () => void;
  readonly syncNavigation?: PdfSyncNavigation;
  readonly citeThread?: ScopedThreadRef | undefined;
  readonly revealOwner: object;
}) {
  const editSession = pdfEditSession(props.editSessionKey);
  const edit = useSyncExternalStore(editSession.subscribe, editSession.getSnapshot);
  const isEditedDocument = props.copyView === "edited" || edit.url !== null;
  const requestedRevisionId =
    props.source._tag === "generated-pdf" ? props.source.revisionId : null;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  // Each document gets a fresh selection keeper on the same container.
  const installRetainedSelection = useEffectEvent((..._changes: readonly unknown[]) =>
    container ? installPdfRetainedSelection(container) : undefined,
  );
  useEffect(
    () => installRetainedSelection(container, props.documentKey),
    [container, props.documentKey],
  );
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
  const reader = useScientPdfReader({
    documentKey: props.documentKey,
    onSourceInvalidated: props.refreshSource,
    revisionId: requestedRevisionId,
    sourceUrl: props.sourceAsset.url,
    candidateReady: props.interactionReady,
    loadAttempt: props.loadAttempt,
    container,
    viewerElement,
  });
  const { state, goToPage: goToReaderPage } = reader;
  const canEditPages = props.source._tag !== "attachment-pdf";
  const [editingPresentation, setEditingPresentation] = useState<typeof reader.presentation>(null);
  const staleEditingCache =
    edit.active &&
    !edit.url &&
    reader.presentationCurrent &&
    editingPresentation !== reader.presentation;
  useEffect(() => {
    if (staleEditingCache) void editSession.reset();
  }, [staleEditingCache, editSession]);
  const copiedNotice = useRef<string | null>(null);
  const [moveRequest, setMoveRequest] = useState<{
    sessionKey: string;
    anchor: HTMLElement;
    pages: readonly string[];
    point: { x: number; y: number };
  } | null>(null);
  // The pages being dragged, faded in the sidebar while the drag lasts.
  const [draggedPages, setDraggedPages] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (!edit.copiedPath || copiedNotice.current === edit.copiedPath) return;
    copiedNotice.current = edit.copiedPath;
    toastManager.add({
      type: "success",
      title: "Edited PDF saved separately",
      description: "Use Save copy to export the edited document.",
    });
  }, [edit.copiedPath]);
  const ensureEdits = async () => {
    const runtime = reader.runtimeRef.current;
    if (!canEditPages || staleEditingCache || !runtime || !reader.presentationCurrent) return false;
    const snapshot = editSession.getSnapshot();
    if (snapshot.active) {
      if (snapshot.url || editingPresentation === reader.presentation) return true;
      return false;
    }
    let source: PdfSourceDescriptor = props.source;
    let copied = props.copyView === "edited";
    editSession.configure(async (bytes, expectedRevision, operationId) => {
      const result = await savePdfEdits({ source, bytes, expectedRevision, operationId });
      source = result.source;
      copied = copied || result.createdCopy || result.source._tag === "generated-pdf";
      if (copied) props.onSavedCopy(source);
      return result;
    });
    setEditingPresentation(reader.presentation);
    await editSession.start(() => runtime.document.getData(), state.page);
    return editSession.getSnapshot().active;
  };
  const togglePage = (page: number, shiftKey: boolean) => {
    editSession.prepareSelection(state.pageCount);
    editSession.toggle(page, shiftKey);
  };
  const showPageContext = async (
    page: number,
    position: { x: number; y: number },
    anchor: HTMLElement,
  ) => {
    if (
      !canEditPages ||
      staleEditingCache ||
      editSession.getSnapshot().busy ||
      !reader.presentationCurrent
    )
      return;
    const contextRuntime = reader.runtimeRef.current;
    editSession.prepareSelection(state.pageCount);
    const frame = editSession.getSnapshot().frame;
    const pageId = frame.pages[page - 1]?.id;
    if (!pageId) return;
    const target = frame.selection.includes(pageId) ? undefined : [pageId];
    // A tagged PDF's structure tree must keep every original page exactly once.
    const keepsPages = editSession.getSnapshot().tagged;
    const moving = target ?? frame.selection;
    // Several checked pages: say how many each action affects.
    const pages = moving.length > 1 ? ` ${moving.length} pages` : "";
    const items: readonly ContextMenuItem<
      "rotate" | "left" | "right" | "move" | "duplicate" | "delete"
    >[] = [
      {
        id: "rotate",
        label: `Rotate${pages}`,
        children: [
          { id: "left", label: "Left 90°" },
          { id: "right", label: "Right 90°" },
        ],
      },
      { id: "move", label: `Move${pages}`, disabled: moving.length === frame.pages.length },
      { id: "duplicate", label: `Duplicate${pages}`, disabled: keepsPages },
      {
        id: "delete",
        label: `Delete${pages}`,
        destructive: true,
        separatorBefore: true,
        disabled: keepsPages || (target ?? frame.selection).length === frame.pages.length,
      },
    ];
    const action = await ensureLocalApi().contextMenu.show(items, position);
    if (!action || contextRuntime !== reader.runtimeRef.current || !(await ensureEdits())) return;
    if (action === "left") await editSession.rotate(-90, target);
    else if (action === "right") await editSession.rotate(90, target);
    else if (action === "move" && anchor.isConnected)
      setMoveRequest({
        sessionKey: props.editSessionKey,
        anchor,
        pages: [...moving],
        point: position,
      });
    else if (action === "duplicate") await editSession.duplicate(target);
    else if (action === "delete") await editSession.delete(target);
  };
  const handleKeyboardAction = (command: string) => {
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
  useLayoutEffect(() => {
    keyboardAction.current = handleKeyboardAction;
  });
  const presentedSource = usePresentedPdfSourceBundle({
    documentKey: props.documentKey,
    source: props.source,
    asset: props.sourceAsset,
    presentation: reader.presentation,
  });
  const currentPresentation =
    props.interactionReady &&
    !staleEditingCache &&
    state.phase === "ready" &&
    reader.presentationCurrent &&
    reader.presentation?.revisionId === requestedRevisionId &&
    reader.presentation.sourceUrl === props.sourceAsset.url;
  const thumbnailPages = Array.from({ length: state.pageCount }, (_, index) => index + 1);
  useEffect(() => {
    if (
      canEditPages &&
      state.phase === "ready" &&
      !edit.active &&
      edit.frame.pages.length !== state.pageCount
    )
      editSession.prepareSelection(state.pageCount);
  }, [
    canEditPages,
    editSession,
    state.phase,
    state.pageCount,
    edit.active,
    edit.frame.pages.length,
  ]);
  const restoredEditUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!currentPresentation) return;
    if (edit.url && restoredEditUrl.current !== edit.url) {
      restoredEditUrl.current = edit.url;
      goToReaderPage(edit.restorePage);
      rootRef.current
        ?.querySelector<HTMLElement>(".scient-pdf-sidebar")
        ?.focus({ preventScroll: true });
    } else editSession.focus(state.page);
  }, [currentPresentation, edit.url, edit.restorePage, editSession, state.page, goToReaderPage]);

  const setSidebar = (next: PdfSidebarMode) => {
    setSidebarState(next);
    pdfReaderSessionStore.updateSidebar(props.documentKey, next);
  };

  const onSyncPageChange = props.syncNavigation?.onPageChange;
  useEffect(() => {
    if (state.phase === "ready" && !isEditedDocument) onSyncPageChange?.(state.page);
  }, [isEditedDocument, onSyncPageChange, state.page, state.phase]);
  const { prepareSearch, goToSyncPoint } = reader;
  useEffect(() => {
    if (!searchOpen) return;
    prepareSearch();
  }, [prepareSearch, searchOpen]);
  useEffect(() => {
    const target = props.syncNavigation?.forwardTarget;
    if (isEditedDocument || target === null || target === undefined || !currentPresentation) return;
    goToSyncPoint(target);
  }, [isEditedDocument, props.syncNavigation?.forwardTarget, goToSyncPoint, currentPresentation]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    reader.closeSearch();
  };

  const saveCopy = () =>
    createReaderSaveCopy({
      presentedSource,
      props,
      saveCopyPendingRef,
      setSavingCopy,
      editedCopy:
        edit.url && edit.bytes ? { bytes: edit.bytes, fileName: props.source.fileName } : null,
    })();

  const onReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      canEditPages &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing &&
      (event.ctrlKey || event.metaKey)
    ) {
      const target = event.target instanceof Element ? event.target : null;
      const field = target?.closest(
        "input:not([type='checkbox']),textarea,select,[contenteditable='true']",
      );
      const key = event.key.toLowerCase();
      if (!field && key === "a" && target?.closest(".scient-pdf-sidebar")) {
        event.preventDefault();
        event.stopPropagation();
        editSession.prepareSelection(state.pageCount);
        editSession.selectPages(thumbnailPages);
        return;
      }
      if (!field && edit.active && (key === "z" || key === "y")) {
        event.preventDefault();
        event.stopPropagation();
        if (key === "y" || event.shiftKey) void editSession.redo();
        else void editSession.undo();
        return;
      }
    }
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Escape") return;
    if (searchOpen) {
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
      {moveRequest?.sessionKey === props.editSessionKey ? (
        <PdfMovePagesPopover
          session={editSession}
          anchor={moveRequest.anchor}
          pages={moveRequest.pages}
          point={moveRequest.point}
          onClose={() => setMoveRequest(null)}
        />
      ) : null}
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
            {hasSourceActions ? <DropdownMenuSeparator /> : null}
            {canSaveCopy ? (
              <DropdownMenuItem
                disabled={savingCopy || edit.busy || (!!edit.url && !currentPresentation)}
                onClick={() => void saveCopy()}
              >
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
      {props.copyView ? (
        <div className="scient-pdf-copy-notice">
          <span>{props.copyView === "edited" ? "Edited copy" : "Original PDF"}</span>
          <Button variant="ghost" size="xs" disabled={edit.busy} onClick={props.onSwitchCopy}>
            {props.copyView === "edited" ? "Show original" : "Open edited copy"}
          </Button>
        </div>
      ) : null}
      {edit.error ? (
        <div className="scient-pdf-notice" role="alert">
          {edit.error}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void editSession.reset().then(props.onRetryLoad);
            }}
          >
            Reload PDF
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss PDF editing error"
            onClick={editSession.dismissError}
          >
            <X />
          </Button>
        </div>
      ) : null}
      {state.scanned === true && state.phase === "ready" ? (
        <div className="scient-pdf-notice">
          No selectable text was detected on the opening pages. Search and copying may be limited.
        </div>
      ) : null}
      <div className="scient-pdf-body">
        {sidebar !== "closed" && state.phase === "ready" && reader.runtimeRef.current ? (
          <aside className="scient-pdf-sidebar" aria-label="PDF navigation" tabIndex={0}>
            <div className="scient-pdf-sidebar-tabs">
              {canEditPages ? (
                <input
                  type="checkbox"
                  className="scient-pdf-select-all"
                  aria-label="Select all pages"
                  disabled={edit.busy || !currentPresentation}
                  checked={
                    edit.frame.pages.length > 0 &&
                    edit.frame.selection.length === edit.frame.pages.length
                  }
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        edit.frame.selection.length > 0 &&
                        edit.frame.selection.length < edit.frame.pages.length;
                  }}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    editSession.prepareSelection(state.pageCount);
                    editSession.selectPages(checked ? thumbnailPages : []);
                  }}
                />
              ) : null}
              {/* Icons with tooltips, like the toolbar, so the narrow sidebar stays calm. */}
              <ScientTooltip content="Pages">
                <button
                  type="button"
                  aria-label="Pages"
                  aria-pressed={sidebar === "thumbnails"}
                  data-active={sidebar === "thumbnails" || undefined}
                  onClick={() => setSidebar("thumbnails")}
                >
                  <FileText />
                </button>
              </ScientTooltip>
              <ScientTooltip content="Outline">
                <button
                  type="button"
                  aria-label="Outline"
                  aria-pressed={sidebar === "outline"}
                  data-active={sidebar === "outline" || undefined}
                  onClick={() => setSidebar("outline")}
                >
                  <ListTree />
                </button>
              </ScientTooltip>
            </div>
            <div className="scient-pdf-sidebar-content">
              {sidebar === "thumbnails" ? (
                <LegendList<number>
                  data={thumbnailPages}
                  extraData={{
                    frame: edit.frame,
                    busy: edit.busy,
                    currentPresentation,
                    runtime: reader.runtimeRef.current,
                    activePage: state.page,
                    draggedPages,
                  }}
                  ListFooterComponent={
                    canEditPages ? (
                      <PdfPageInsertion
                        boundary={state.pageCount}
                        last
                        session={editSession}
                        disabled={edit.busy || !currentPresentation}
                        ensureReady={ensureEdits}
                      />
                    ) : null
                  }
                  keyExtractor={(pageNumber) => String(pageNumber)}
                  estimatedItemSize={205}
                  drawDistance={410}
                  className="scient-pdf-thumbnails"
                  renderItem={({ item: pageNumber }) => (
                    <PdfThumbnail
                      pageNumber={pageNumber}
                      active={state.page === pageNumber}
                      runtime={reader.runtimeRef.current!}
                      editable={canEditPages}
                      selected={edit.frame.selection.includes(
                        edit.frame.pages[pageNumber - 1]?.id ?? "",
                      )}
                      disabled={edit.busy || !currentPresentation}
                      dragScope={props.documentKey}
                      dragPages={
                        edit.frame.selection.includes(edit.frame.pages[pageNumber - 1]?.id ?? "")
                          ? edit.frame.selection
                          : [edit.frame.pages[pageNumber - 1]?.id ?? `page-${pageNumber}`]
                      }
                      dragged={
                        draggedPages?.includes(edit.frame.pages[pageNumber - 1]?.id ?? "") ?? false
                      }
                      onDragState={setDraggedPages}
                      onSelect={reader.goToPage}
                      onToggle={(page, shift) => {
                        void togglePage(page, shift);
                      }}
                      onContext={(page, position, anchor) => {
                        void showPageContext(page, position, anchor);
                      }}
                      onMove={(boundary, pages) => {
                        void ensureEdits().then((ready) => {
                          if (!ready) return;
                          const valid = new Set(
                            editSession.getSnapshot().frame.pages.map((page) => page.id),
                          );
                          if (pages.every((id) => valid.has(id)))
                            void editSession.move(boundary, pages);
                        });
                      }}
                    >
                      {canEditPages ? (
                        <PdfPageInsertion
                          boundary={pageNumber - 1}
                          session={editSession}
                          disabled={edit.busy || !currentPresentation}
                          ensureReady={ensureEdits}
                        />
                      ) : null}
                    </PdfThumbnail>
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
            onDoubleClick={(event) => {
              if (isEditedDocument || !currentPresentation) return;
              const onInverseSearch = props.syncNavigation?.onInverseSearch;
              if (onInverseSearch === undefined) return;
              // An editable page uses the ordinary click gesture. Keep inverse
              // search available in Split without making a direct edit also navigate.
              const target = event.target;
              if (!(target instanceof Element)) return;
              if (target.closest("a,button,input,select,textarea,[contenteditable='true']")) return;
              const pageElement = target.closest<HTMLElement>(".page[data-page-number]");
              if (pageElement === null) return;
              const point = reader.syncPointFromClient({
                pageElement,
                clientX: event.clientX,
                clientY: event.clientY,
              });
              if (point !== null) {
                // Preserve ordinary PDF selection before reading its word.
                queueMicrotask(() =>
                  onInverseSearch(point, pageElement.ownerDocument.getSelection()?.toString()),
                );
              }
            }}
          >
            <div ref={setViewerElement} className="scient-pdf-presentation-layers" />
          </div>
          <PdfQuoteLayer
            container={container}
            runtimeRef={reader.runtimeRef}
            presentedSource={edit.savedSource ?? presentedSource?.source ?? null}
            revealKey={props.revealDocumentKey}
            ready={currentPresentation && !edit.busy}
            citeThread={props.citeThread}
            revealOwner={props.revealOwner}
          />
          {props.sourceNotice || state.updateError ? (
            <div className="scient-pdf-update-notice" role="status">
              <span>{state.updateError ?? props.sourceNotice}</span>
              {props.authorizationFailed || state.updateError ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.authorizationPending}
                  aria-busy={props.authorizationPending}
                  onClick={props.onRetryLoad}
                >
                  <RefreshIcon size="xs" refreshing={props.authorizationPending} />
                  Try again
                </Button>
              ) : null}
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
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.authorizationPending}
                  aria-busy={props.authorizationPending}
                  onClick={props.onRetryLoad}
                >
                  <RefreshIcon size="xs" refreshing={props.authorizationPending} />
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

function createReaderSaveCopy({
  presentedSource,
  props,
  saveCopyPendingRef,
  setSavingCopy,
  editedCopy,
}: {
  presentedSource: ReturnType<typeof usePresentedPdfSourceBundle>;
  props: { readonly actions: PdfSourceActions };
  saveCopyPendingRef: RefObject<boolean>;
  setSavingCopy: Dispatch<SetStateAction<boolean>>;
  editedCopy: { readonly bytes: Uint8Array; readonly fileName: string } | null;
}) {
  return async () => {
    if (saveCopyPendingRef.current || (presentedSource === null && editedCopy === null)) return;
    const bundle = presentedSource;
    saveCopyPendingRef.current = true;
    setSavingCopy(true);
    try {
      if (editedCopy) {
        announcePdfSaveCopyResult(await saveEditedPdfCopy(editedCopy.bytes, editedCopy.fileName));
      } else if (bundle) {
        const result = await observePdfCopy(EnvironmentId.make(bundle.source.authority), () =>
          props.actions.saveCopy(bundle.source, bundle.resolved),
        );
        const presentation = announcePdfSaveCopyResult(result);
        if (presentation.refreshSource) bundle.resolved.refresh();
      }
    } catch {
      toastManager.add(
        editedCopy
          ? { type: "error", title: "The PDF copy could not be saved" }
          : {
              type: "error",
              title: "The PDF could not be saved",
              description: "Try again or choose another location.",
            },
      );
    } finally {
      saveCopyPendingRef.current = false;
      setSavingCopy(false);
    }
  };
}
