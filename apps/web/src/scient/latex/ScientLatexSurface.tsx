import type { FilePostRender } from "~/scient/fileSurfaces/StaticTextFileSurface";
import { File, Virtualizer } from "@pierre/diffs/react";
import { useAtomValue } from "@effect/atom-react";
import {
  ArtifactAuthority,
  LogicalDocumentKey,
  type DocumentBindingChange,
} from "@scientfactory/document-artifacts";
import {
  type EnvironmentId,
  type ScientLatexBuildSnapshot,
  type ScientLatexDiagnostic,
  type ScientLatexManagedInstallState,
  type ScientLatexSyncUnavailableReason,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronRight, CircleAlert, LoaderCircle, RotateCw, TriangleAlert, X } from "lucide-react";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { projectFileCacheKey } from "~/components/files/fileContentRevision";
import { type DraftId } from "~/composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import type { LatexFilePresentationRequest, OpenFileOptions } from "~/rightPanelStore";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";
import { savedMarkdownRevision } from "~/scient/documentExport/markdownSavedRevision";
import { useScientSplit } from "~/scient/layout/useScientSplit";
import { onDocumentSaved } from "~/scient/markdownEditor/persistence/documentPublication";
import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { ResizeSeparator } from "~/scient/layout/ResizeSeparator";
import type {
  PdfForwardSyncTarget,
  PdfInverseSyncPoint,
  PdfSyncNavigation,
} from "~/scient/pdf/ScientPdfReader";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { WordFileExportDialog } from "~/scient/wordExport/WordFileExportDialog";

import { documentBindingChanges } from "./bindingChanges";
import { LatexToolchainSetupCard } from "./LatexToolchainSetupCard";
import { requestLatexForwardSync, requestLatexInverseSync } from "./client";
import { useLatexDocumentResolution } from "./useLatexDocumentResolution";
import {
  cancelLatexBuild,
  notifyLatexBindingChange,
  requestLatexRebuild,
  requestManagedLatexInstall,
  startWatchingLatexBuild,
  useLatexBuild,
  type LatexBuildTarget,
} from "./latexBuildStore";
import {
  DEFAULT_LATEX_SPLIT_FRACTION,
  LATEX_PREVIEW_MODE_LABELS,
  LATEX_PREVIEW_MODE_STORAGE_KEY,
  LATEX_PREVIEW_MODES,
  LATEX_SPLIT_KEYBOARD_STEP,
  LATEX_SPLIT_RATIO_STORAGE_KEY,
  LATEX_TOOLCHAIN_MISSING_HINT,
  MIN_LATEX_SPLIT_FRACTION,
  formatLatexDiagnosticLocation,
  latexCompiledFromPath,
  latexDiagnosticRows,
  latexStatusStripModel,
  normalizeLatexPreviewMode,
  normalizeLatexSplitFraction,
  type LatexViewerState,
  type ScientLatexPreviewMode,
} from "./scientLatexSurfaceModel";

import "./scient-latex.css";

type LatexPdfDescriptor = ScientLatexBuildSnapshot["descriptor"];

interface ScientLatexSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /** Root carried by navigation from an already established LaTeX document. */
  readonly latexRootRelativePath: string | null;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** The working source: the session's draft when there is one. */
  readonly contents: string;
  /** The revision last confirmed on disk. The draft may be ahead of it. */
  readonly revision: string;
  /**
   * The file's document session, which owns saving for every view of it. Null
   * when the file cannot be edited completely; the source is then read-only.
   */
  readonly persistence: MarkdownPersistenceLease | null;
  readonly resolvedTheme: "light" | "dark";
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly latexPresentationRequest: LatexFilePresentationRequest | null;
  readonly wordWrap: boolean;
  readonly onPostRender: FilePostRender;
  readonly onOpenFileSource: (
    relativePath: string,
    line?: number,
    options?: OpenFileOptions,
  ) => void;
  readonly onLatexPresentationRequestHandled: (
    relativePath: string,
    request: LatexFilePresentationRequest,
  ) => void;
}

const noSubscription = () => () => {};
const notPending = () => false;

const NO_DIAGNOSTICS: ReadonlyArray<ScientLatexDiagnostic> = [];
const EMPTY_BINDING_CHANGES_ATOM = Atom.make(
  AsyncResult.initial<DocumentBindingChange, never>(false),
).pipe(Atom.withLabel("scient-latex-binding-changes:empty"));

interface LatexSyncNotice {
  readonly label: string;
  readonly message: string;
}

const UNSAVED_SYNC_NOTICE: LatexSyncNotice = {
  label: "Unsaved changes",
  message: "Navigation between source and PDF is available once changes are saved and built.",
};

function syncUnavailableLabel(reason: ScientLatexSyncUnavailableReason): string {
  switch (reason) {
    case "revision-unavailable":
      return "PDF revision unavailable";
    case "index-missing":
      return "Navigation index missing";
    case "index-invalid":
      return "Navigation index damaged";
    case "navigator-unavailable":
      return "Navigation needs repair";
    case "navigator-failed":
      return "Navigation failed";
    case "query-timed-out":
      return "Navigation timed out";
    case "position-unmapped":
      return "No source mapping";
    case "invalid-source":
      return "Source mismatch";
  }
}
/**
 * Mirrors the file panel's private editor theming for the read-only half. The
 * editable half is that panel's own component, so it carries the panel's copy.
 */
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const LATEX_EDITOR_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;

const ScientPdfReader = lazy(() =>
  import("~/scient/pdf/ScientPdfReader").then((module) => ({
    default: module.ScientPdfReader,
  })),
);

function useLatexBindingChange(
  environmentId: EnvironmentId,
  snapshot: ScientLatexBuildSnapshot | null,
): DocumentBindingChange | null {
  const atom =
    snapshot === null
      ? EMPTY_BINDING_CHANGES_ATOM
      : documentBindingChanges({
          environmentId,
          input: {
            authority: ArtifactAuthority.make(environmentId),
            logicalDocumentKey: LogicalDocumentKey.make(snapshot.logicalDocumentKey),
          },
        });
  return Option.getOrNull(AsyncResult.value(useAtomValue(atom)));
}

function initialPreviewMode(): ScientLatexPreviewMode {
  try {
    return normalizeLatexPreviewMode(
      getLocalStorageItem(LATEX_PREVIEW_MODE_STORAGE_KEY, Schema.String),
    );
  } catch (error) {
    console.error(error);
    return normalizeLatexPreviewMode(null);
  }
}

function initialSplitFraction(): number {
  try {
    return normalizeLatexSplitFraction(
      getLocalStorageItem(LATEX_SPLIT_RATIO_STORAGE_KEY, Schema.Number),
    );
  } catch (error) {
    console.error(error);
    return DEFAULT_LATEX_SPLIT_FRACTION;
  }
}

function persist<T, E>(key: string, value: T, schema: Schema.Codec<T, E>): void {
  try {
    setLocalStorageItem(key, value, schema);
  } catch (error) {
    console.error(error);
  }
}

function LatexPendingViewer(props: { readonly label: string }) {
  return (
    <div className="scient-latex-placeholder">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <p>{props.label}</p>
    </div>
  );
}

function LatexDiagnosticsRow(props: {
  readonly diagnostic: ScientLatexDiagnostic;
  readonly workspaceRoot: string;
  readonly onNavigate: (relativePath: string, line?: number) => void;
}) {
  const location = formatLatexDiagnosticLocation(props.diagnostic, props.workspaceRoot);
  const navigable = props.diagnostic.file !== null;
  return (
    <li className="scient-latex-diagnostic">
      {props.diagnostic.severity === "error" ? (
        <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      )}
      {navigable ? (
        <button
          type="button"
          className="scient-latex-diagnostic-link"
          onClick={() =>
            props.onNavigate(props.diagnostic.file!, props.diagnostic.line ?? undefined)
          }
        >
          {location === null ? null : (
            <span className="scient-latex-diagnostic-location">{location}</span>
          )}
          <span className="scient-latex-diagnostic-message">{props.diagnostic.message}</span>
        </button>
      ) : (
        <span className="scient-latex-diagnostic-message">{props.diagnostic.message}</span>
      )}
    </li>
  );
}

/** A file too large to edit reads the same way it does in the file panel. */
function LatexReadOnlyHalf(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly onPostRender: FilePostRender;
}) {
  return (
    <Virtualizer
      className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
      config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
    >
      <File
        file={{
          name: props.relativePath,
          contents: props.contents,
          ...scientificSourceLanguageOverride(props.relativePath),
          cacheKey: projectFileCacheKey(props.cwd, props.relativePath, props.contents),
        }}
        options={{
          disableFileHeader: true,
          overflow: props.wordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(props.resolvedTheme),
          themeType: props.resolvedTheme,
          unsafeCSS: LATEX_EDITOR_UNSAFE_CSS,
          onPostRender: props.onPostRender,
        }}
        className="min-h-full"
      />
    </Virtualizer>
  );
}

/**
 * Only what the viewer half actually renders. Handing it the whole build entry
 * would put `requesting` and `error` — which change on every rebuild and every
 * lost poll — inside the memo's comparison, and the point of the memo is that
 * none of that reaches the PDF reader.
 */
interface LatexViewerPaneProps {
  readonly readerScope: string;
  readonly descriptor: LatexPdfDescriptor;
  readonly readerKey: string | null;
  readonly viewer: LatexViewerState;
  readonly toolchainMissing: boolean;
  readonly failureLine: string | null;
  readonly canInstallManaged: boolean;
  readonly managedInstall: ScientLatexManagedInstallState | null;
  readonly installRequesting: boolean;
  readonly onInstall: () => void;
  readonly syncNavigation?: PdfSyncNavigation;
}

/**
 * The viewer half behind its own memo boundary. Typing in the source half, a
 * divider drag, and a layout change all re-render the surface; none of them is
 * news to the PDF reader, and re-rendering it would cost the reader its page.
 */
const LatexViewerPane = memo(function LatexViewerPane({
  descriptor,
  readerScope,
  readerKey,
  viewer,
  toolchainMissing,
  failureLine,
  canInstallManaged,
  managedInstall,
  installRequesting,
  onInstall,
  syncNavigation,
}: LatexViewerPaneProps) {
  return (
    <div className="scient-latex-pane">
      {descriptor !== null && readerKey !== null ? (
        <Suspense fallback={<LatexPendingViewer label="Opening PDF…" />}>
          <ScientPdfReader
            key={readerKey}
            source={descriptor}
            readerScope={readerScope}
            {...(syncNavigation === undefined ? {} : { syncNavigation })}
          />
        </Suspense>
      ) : toolchainMissing ? (
        <LatexToolchainSetupCard
          canInstallManaged={canInstallManaged}
          managedInstall={managedInstall}
          installRequesting={installRequesting}
          toolchainMissing={toolchainMissing}
          onInstall={onInstall}
        />
      ) : viewer === "diagnostics" ? (
        <div className="scient-latex-placeholder">
          <CircleAlert className="size-5 text-destructive" aria-hidden="true" />
          <h2>This document did not build</h2>
          <p>{failureLine ?? "Check the build messages above."}</p>
        </div>
      ) : viewer === "building" ? (
        <LatexPendingViewer label="Building…" />
      ) : (
        <div className="scient-latex-placeholder">
          <p>Save this document or select Rebuild to compile a PDF.</p>
        </div>
      )}
    </div>
  );
});

interface SourceSyncPosition {
  readonly line: number;
  readonly column: number;
}

function sourcePositionFromPointerEvent(
  event: React.MouseEvent<HTMLElement>,
): SourceSyncPosition | null {
  for (const candidate of event.nativeEvent.composedPath()) {
    if (!(candidate instanceof HTMLElement)) continue;
    const raw = candidate.dataset.line;
    if (raw === undefined) continue;
    const line = Number(raw);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    return {
      line,
      // The inherited editor surface does not expose its internal cursor on
      // main. Zero is SyncTeX's explicit "unknown column" value; guessing a
      // visual DOM offset would be wrong for wrapped and bidirectional text.
      column: 0,
    };
  }
  return null;
}

export function ScientLatexSurface(props: ScientLatexSurfaceProps) {
  const [manualRootSelection, setManualRootSelection] = useState<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly sourceRelativePath: string;
    readonly carriedRootRelativePath: string | null;
    readonly selectedRootRelativePath: string;
  } | null>(null);
  const selectedRootRelativePath =
    manualRootSelection !== null &&
    manualRootSelection.environmentId === props.environmentId &&
    manualRootSelection.workspaceRoot === props.cwd &&
    manualRootSelection.sourceRelativePath === props.relativePath &&
    manualRootSelection.carriedRootRelativePath === props.latexRootRelativePath
      ? manualRootSelection.selectedRootRelativePath
      : (props.latexRootRelativePath ?? undefined);
  const resolution = useLatexDocumentResolution({
    environmentId: props.environmentId,
    workspaceRoot: props.cwd,
    sourceRelativePath: props.relativePath,
    sourceRevision: props.revision,
    ...(selectedRootRelativePath === undefined
      ? {}
      : { contextRootRelativePath: selectedRootRelativePath }),
  });
  const resolvedRootRelativePath =
    resolution.result?._tag === "resolved" ? resolution.result.rootRelativePath : null;
  const target = useMemo<LatexBuildTarget | null>(
    () =>
      resolvedRootRelativePath === null
        ? null
        : {
            environmentId: props.environmentId,
            cwd: props.cwd,
            relativePath: resolvedRootRelativePath,
          },
    [props.cwd, props.environmentId, resolvedRootRelativePath],
  );
  const build = useLatexBuild(target);
  const bindingChange = useLatexBindingChange(props.environmentId, build.snapshot);
  const status = useMemo(() => latexStatusStripModel(build, props.cwd), [build, props.cwd]);
  const [preferredMode, setPreferredMode] = useState(
    () => props.latexPresentationRequest?.mode ?? initialPreviewMode(),
  );
  const [splitFraction, setSplitFraction] = useState(initialSplitFraction);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [syncNotice, setSyncNotice] = useState<LatexSyncNotice | null>(null);
  const [wordExportOpen, setWordExportOpen] = useState(false);
  const { persistence } = props;
  // Unsaved, saving, or waiting on a conflict or a failed save.
  const sourcePending = useSyncExternalStore(
    persistence?.subscribe ?? noSubscription,
    persistence ? () => persistence.getSnapshot().pending : notPending,
  );
  const [forwardSyncTarget, setForwardSyncTarget] = useState<PdfForwardSyncTarget | null>(null);
  const [handledRevealRequestId, setHandledRevealRequestId] = useState<number | null>(null);
  const lastBindingChangeRef = useRef<DocumentBindingChange | null>(null);
  const syncRequestRef = useRef(0);
  const pdfPageRef = useRef<number | null>(null);

  useEffect(() => {
    const request = props.latexPresentationRequest;
    if (request === null) return;
    setPreferredMode(request.mode);
    setHandledRevealRequestId(props.revealRequestId);
    props.onLatexPresentationRequestHandled(props.relativePath, request);
  }, [
    props.latexPresentationRequest,
    props.onLatexPresentationRequestHandled,
    props.relativePath,
    props.revealRequestId,
  ]);

  useEffect(() => (target === null ? undefined : startWatchingLatexBuild(target)), [target]);
  useEffect(() => {
    lastBindingChangeRef.current = null;
  }, [target]);
  useEffect(() => {
    if (bindingChange === null || lastBindingChangeRef.current === bindingChange) return;
    lastBindingChangeRef.current = bindingChange;
    if (target !== null) notifyLatexBindingChange(target);
  }, [bindingChange, target]);

  const { onOpenFileSource, revealLine, revealRequestId } = props;
  // The PDF follows the file on disk, so it is rebuilt when a save lands while
  // this view is open. A save that lands with no view open is picked up by the
  // build store's own status checks.
  useEffect(() => {
    if (persistence === null || target === null) return;
    return onDocumentSaved(persistence, () => requestLatexRebuild(target));
  }, [persistence, target]);
  const handleInstallToolchain = useCallback(() => {
    if (target !== null) requestManagedLatexInstall(target);
  }, [target]);

  // A reveal asks for a line of source, so a document parked on the PDF shows
  // its source until the reader picks a layout again. The file panel's
  // rendered-markdown branch resolves the same conflict the same way.
  const revealPending = revealLine !== null && handledRevealRequestId !== revealRequestId;
  const mode = revealPending && preferredMode === "pdf" ? "split" : preferredMode;
  const selectMode = useCallback(
    (next: ScientLatexPreviewMode) => {
      setPreferredMode(next);
      setHandledRevealRequestId(revealRequestId);
      persist(LATEX_PREVIEW_MODE_STORAGE_KEY, next, Schema.String);
    },
    [revealRequestId],
  );

  const commitSplitFraction = useCallback((fraction: number) => {
    setSplitFraction(fraction);
    persist(LATEX_SPLIT_RATIO_STORAGE_KEY, fraction, Schema.Number);
  }, []);
  const { containerRef, primaryPaneRef, separatorHandlers } = useScientSplit({
    active: mode === "split",
    fraction: splitFraction,
    minimum: MIN_LATEX_SPLIT_FRACTION,
    fallback: DEFAULT_LATEX_SPLIT_FRACTION,
    keyboardStep: LATEX_SPLIT_KEYBOARD_STEP,
    onCommit: commitSplitFraction,
  });

  const diagnostics = build.snapshot?.diagnostics ?? NO_DIAGNOSTICS;
  const diagnosticRows = useMemo(() => latexDiagnosticRows(diagnostics), [diagnostics]);
  const descriptor = build.snapshot?.descriptor ?? null;
  const descriptorRevision = descriptor?._tag === "generated-pdf" ? descriptor.revisionId : null;
  useEffect(() => {
    syncRequestRef.current += 1;
    pdfPageRef.current = null;
    setForwardSyncTarget(null);
    setSyncNotice(null);
  }, [descriptorRevision]);

  // An answer computed for one draft is not an answer for the next.
  useEffect(() => {
    if (persistence === null) return;
    let editVersion = persistence.getSnapshot().editVersion;
    return persistence.subscribe(() => {
      const next = persistence.getSnapshot().editVersion;
      if (next === editVersion) return;
      editVersion = next;
      syncRequestRef.current += 1;
    });
  }, [persistence]);

  const handlePdfPageChange = useCallback((page: number) => {
    pdfPageRef.current = page;
  }, []);

  const handleForwardSync = useCallback(
    (position: SourceSyncPosition) => {
      const snapshot = build.snapshot;
      if (
        snapshot === null ||
        descriptor === null ||
        descriptor._tag !== "generated-pdf" ||
        snapshot.state !== "succeeded" ||
        descriptor.bindingStatus !== "current"
      ) {
        setSyncNotice({
          label: "Build required",
          message: "Source-to-PDF navigation is available after the current build succeeds.",
        });
        return;
      }
      // Positions are those of the compiled file, and a draft has moved on from it.
      if (persistence?.getSnapshot().pending) {
        setSyncNotice(UNSAVED_SYNC_NOTICE);
        return;
      }
      const issued = syncRequestRef.current + 1;
      syncRequestRef.current = issued;
      setSyncNotice(null);
      void requestLatexForwardSync(props.environmentId, {
        workspaceRoot: props.cwd,
        rootRelativePath: snapshot.rootRelativePath,
        artifactId: descriptor.artifactId,
        revisionId: descriptor.revisionId,
        sourceRelativePath: props.relativePath,
        line: position.line,
        column: position.column,
        ...(pdfPageRef.current === null ? {} : { pageHint: pdfPageRef.current }),
      })
        .then((result) => {
          if (syncRequestRef.current !== issued) return;
          if (result._tag === "unavailable") {
            setSyncNotice({ label: syncUnavailableLabel(result.reason), message: result.message });
            return;
          }
          setForwardSyncTarget({
            requestId: issued,
            page: result.page,
            x: result.x,
            y: result.y,
          });
        })
        .catch((error: unknown) => {
          if (syncRequestRef.current !== issued) return;
          setSyncNotice({
            label: "Navigation failed",
            message: error instanceof Error ? error.message : "SyncTeX navigation failed.",
          });
        });
    },
    [build.snapshot, descriptor, persistence, props.cwd, props.environmentId, props.relativePath],
  );

  const handleInverseSync = useCallback(
    (point: PdfInverseSyncPoint) => {
      const snapshot = build.snapshot;
      if (
        snapshot === null ||
        descriptor === null ||
        descriptor._tag !== "generated-pdf" ||
        snapshot.state !== "succeeded" ||
        descriptor.bindingStatus !== "current"
      ) {
        setSyncNotice({
          label: "Build required",
          message: "PDF-to-source navigation is available after the current build succeeds.",
        });
        return;
      }
      const issued = syncRequestRef.current + 1;
      syncRequestRef.current = issued;
      setSyncNotice(null);
      void requestLatexInverseSync(props.environmentId, {
        workspaceRoot: props.cwd,
        rootRelativePath: snapshot.rootRelativePath,
        artifactId: descriptor.artifactId,
        revisionId: descriptor.revisionId,
        page: point.page,
        x: point.x,
        y: point.y,
      })
        .then((result) => {
          if (syncRequestRef.current !== issued) return;
          if (result._tag === "unavailable") {
            setSyncNotice({ label: syncUnavailableLabel(result.reason), message: result.message });
            return;
          }
          // The line belongs to the compiled file; an unsaved draft of it has other lines.
          if (
            markdownPersistenceRegistry
              .getSnapshot()
              .some(
                (entry) =>
                  entry.pending &&
                  entry.environmentId === props.environmentId &&
                  entry.cwd === props.cwd &&
                  entry.relativePath === result.relativePath,
              )
          ) {
            setSyncNotice(UNSAVED_SYNC_NOTICE);
            return;
          }
          onOpenFileSource(result.relativePath, result.line, {
            latexRootRelativePath: snapshot.rootRelativePath,
          });
        })
        .catch((error: unknown) => {
          if (syncRequestRef.current !== issued) return;
          setSyncNotice({
            label: "Navigation failed",
            message: error instanceof Error ? error.message : "SyncTeX navigation failed.",
          });
        });
    },
    [build.snapshot, descriptor, onOpenFileSource, props.cwd, props.environmentId],
  );
  const syncNavigation = useMemo<PdfSyncNavigation | undefined>(
    () =>
      descriptor?._tag === "generated-pdf"
        ? {
            forwardTarget: forwardSyncTarget,
            ...(mode === "split" ? { onInverseSearch: handleInverseSync } : {}),
            onPageChange: handlePdfPageChange,
          }
        : undefined,
    [descriptor?._tag, forwardSyncTarget, handleInverseSync, handlePdfPageChange, mode],
  );
  // Keyed by artifact, never by revision: a rebuild of the same document swaps
  // the reader's asset URL, and the reader keeps page and zoom across that.
  const readerKey =
    descriptor === null
      ? null
      : descriptor._tag === "generated-pdf"
        ? descriptor.artifactId
        : descriptor.logicalDocumentKey;
  const compiledFrom = latexCompiledFromPath(build.snapshot?.rootRelativePath, props.relativePath);
  const showEditor = mode !== "pdf";
  const showViewer = mode !== "source";

  return (
    <div className="scient-latex-surface" dir="ltr">
      <div className="scient-latex-toolbar">
        <div className="scient-latex-modes" role="group" aria-label="LaTeX preview layout">
          {LATEX_PREVIEW_MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="scient-latex-mode-button"
              aria-pressed={mode === candidate}
              onClick={() => selectMode(candidate)}
            >
              {LATEX_PREVIEW_MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
        <div className="scient-latex-status">
          {resolution.pending || status.busy ? (
            <LoaderCircle
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          {target === null ? (
            <span className="scient-latex-status-label">
              {resolution.pending
                ? "Finding document"
                : resolution.result?._tag === "ambiguous" ||
                    (resolution.result?._tag === "unresolved" &&
                      resolution.result.candidates.length > 0)
                  ? "Choose the document to compile"
                  : (resolution.error ?? "No compiling document found")}
            </span>
          ) : status.toolchainMissing ? (
            <ScientTooltip content={LATEX_TOOLCHAIN_MISSING_HINT}>
              <span
                className={cn(
                  "scient-latex-status-label",
                  status.state === "failed" ? "text-destructive" : undefined,
                )}
              >
                {status.label}
              </span>
            </ScientTooltip>
          ) : (
            <span
              className={cn(
                "scient-latex-status-label",
                status.state === "failed" ? "text-destructive" : undefined,
              )}
            >
              {status.label}
            </span>
          )}
          {target === null &&
          (resolution.result?._tag === "ambiguous" || resolution.result?._tag === "unresolved") &&
          resolution.result.candidates.length > 0 ? (
            <select
              className="scient-latex-root-choice"
              aria-label="Choose LaTeX document to compile"
              value=""
              onChange={(event) => {
                if (event.target.value !== "") {
                  setManualRootSelection({
                    environmentId: props.environmentId,
                    workspaceRoot: props.cwd,
                    sourceRelativePath: props.relativePath,
                    carriedRootRelativePath: props.latexRootRelativePath,
                    selectedRootRelativePath: event.target.value,
                  });
                }
              }}
            >
              <option value="" disabled>
                Choose document…
              </option>
              {resolution.result.candidates.map((candidate) => (
                <option key={candidate.rootRelativePath} value={candidate.rootRelativePath}>
                  {candidate.rootRelativePath}
                </option>
              ))}
            </select>
          ) : null}
          {compiledFrom === null ? null : (
            <ScientTooltip
              content={`This file is part of ${compiledFrom}, which is what Scient compiles.`}
            >
              <span className="scient-latex-chip">Compiled from {compiledFrom}</span>
            </ScientTooltip>
          )}
          {status.errorCount > 0 ? (
            <span className="scient-latex-chip scient-latex-chip-error">
              {status.errorCount} {status.errorCount === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {status.warningCount > 0 ? (
            <span className="scient-latex-chip scient-latex-chip-warning">
              {status.warningCount} {status.warningCount === 1 ? "warning" : "warnings"}
            </span>
          ) : null}
          {status.stale ? (
            status.staleReason ? (
              <ScientTooltip content={status.staleReason}>
                <span className="scient-latex-chip">Stale</span>
              </ScientTooltip>
            ) : (
              <span className="scient-latex-chip">Stale</span>
            )
          ) : null}
          {syncNotice === null ? null : (
            <ScientTooltip content={syncNotice.message}>
              <span
                className="scient-latex-chip scient-latex-chip-error"
                role="status"
                aria-live="polite"
                aria-label={`${syncNotice.label}: ${syncNotice.message}`}
              >
                {syncNotice.label}
              </span>
            </ScientTooltip>
          )}
        </div>
        <div className="scient-latex-actions">
          <button
            type="button"
            className="scient-latex-action"
            disabled={target === null || sourcePending}
            onClick={() => setWordExportOpen(true)}
          >
            Export ▸ Word
          </button>
          {status.canCancel && target !== null ? (
            <button
              type="button"
              className="scient-latex-action"
              onClick={() => cancelLatexBuild(target)}
            >
              <X className="size-3.5" aria-hidden="true" />
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="scient-latex-action"
            disabled={target === null || !status.canRebuild}
            // By hand is the one rebuild that re-probes: a TeX installed while
            // this document sat here has no other way to be noticed.
            onClick={() => {
              if (target !== null) requestLatexRebuild(target, { reprobeToolchain: true });
            }}
          >
            <RotateCw className="size-3.5" aria-hidden="true" />
            Rebuild
          </button>
        </div>
      </div>

      {diagnostics.length > 0 ? (
        <div className="scient-latex-diagnostics">
          <button
            type="button"
            className="scient-latex-diagnostics-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((current) => !current)}
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0", diagnosticsOpen ? "rotate-90" : undefined)}
              aria-hidden="true"
            />
            <span className="scient-latex-diagnostics-summary">
              {status.firstDiagnosticLine ?? `${diagnostics.length} build messages`}
            </span>
            {diagnostics.length > 1 ? (
              <span className="scient-latex-diagnostics-count">{diagnostics.length}</span>
            ) : null}
          </button>
          {diagnosticsOpen ? (
            <ul className="scient-latex-diagnostics-list">
              {diagnosticRows.map((row) => (
                <LatexDiagnosticsRow
                  key={row.key}
                  diagnostic={row.diagnostic}
                  workspaceRoot={props.cwd}
                  onNavigate={(relativePath, line) =>
                    onOpenFileSource(
                      relativePath,
                      line,
                      build.snapshot === null
                        ? undefined
                        : { latexRootRelativePath: build.snapshot.rootRelativePath },
                    )
                  }
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="scient-latex-content" ref={containerRef}>
        {showEditor ? (
          <ScientTooltip content="In Split, double-click a source line to find it in the PDF">
            <div
              ref={primaryPaneRef}
              className={cn(
                "scient-latex-pane",
                mode === "split" ? "scient-latex-pane-sized" : null,
              )}
              onDoubleClickCapture={(event) => {
                if (mode !== "split") return;
                const position = sourcePositionFromPointerEvent(event);
                if (position !== null) handleForwardSync(position);
              }}
            >
              {persistence === null ? (
                <LatexReadOnlyHalf
                  cwd={props.cwd}
                  relativePath={props.relativePath}
                  contents={props.contents}
                  resolvedTheme={props.resolvedTheme}
                  wordWrap={props.wordWrap}
                  onPostRender={props.onPostRender}
                />
              ) : (
                <MarkdownSourceSurface
                  persistence={persistence}
                  environmentId={props.environmentId}
                  cwd={props.cwd}
                  relativePath={props.relativePath}
                  composerDraftTarget={props.composerDraftTarget}
                  resolvedTheme={props.resolvedTheme}
                  revealRequestId={props.revealRequestId}
                  wordWrap={props.wordWrap}
                  onPostRender={props.onPostRender}
                />
              )}
            </div>
          </ScientTooltip>
        ) : null}

        {showViewer ? (
          <div className="scient-latex-viewer-shell">
            {showEditor ? (
              <ResizeSeparator
                className="absolute inset-y-0 -start-1"
                tabIndex={0}
                aria-label="Resize LaTeX preview"
                aria-valuemin={Math.round(MIN_LATEX_SPLIT_FRACTION * 100)}
                aria-valuemax={Math.round((1 - MIN_LATEX_SPLIT_FRACTION) * 100)}
                aria-valuenow={Math.round(splitFraction * 100)}
                {...separatorHandlers}
              />
            ) : null}
            <LatexViewerPane
              descriptor={descriptor}
              readerScope={
                typeof props.composerDraftTarget === "string"
                  ? props.composerDraftTarget
                  : props.composerDraftTarget.threadId
              }
              readerKey={readerKey}
              viewer={status.viewer}
              toolchainMissing={status.toolchainMissing}
              failureLine={status.firstDiagnosticLine ?? build.snapshot?.failureSummary ?? null}
              canInstallManaged={build.canInstallManaged}
              managedInstall={build.managedInstall}
              installRequesting={build.installRequesting}
              onInstall={handleInstallToolchain}
              {...(syncNavigation === undefined ? {} : { syncNavigation })}
            />
          </div>
        ) : null}
      </div>
      {wordExportOpen && target !== null ? (
        <WordFileExportDialog
          environmentId={props.environmentId}
          cwd={props.cwd}
          relativePath={props.relativePath}
          rootRelativePath={target.relativePath}
          // Export reads the file on disk: flush first, and refuse while a
          // conflict or a failed save keeps the draft ahead of it.
          savedRevision={async () =>
            persistence === null ? props.revision : savedMarkdownRevision(persistence)
          }
          onClose={() => setWordExportOpen(false)}
        />
      ) : null}
    </div>
  );
}
