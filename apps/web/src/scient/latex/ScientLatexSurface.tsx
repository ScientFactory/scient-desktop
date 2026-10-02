import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
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
import { CircleAlert, Ellipsis, LoaderCircle, RotateCw, TriangleAlert, X } from "lucide-react";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { isLatexPreviewFile } from "~/components/files/filePreviewMode";
import { projectFileCacheKey } from "~/components/files/fileContentRevision";
import { type DraftId } from "~/composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import type { LatexFilePresentationRequest, OpenFileOptions } from "~/rightPanelStore";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";
import { registerShortcutClaim } from "~/scient/keyboard/ownership";
import { useScientSplit } from "~/scient/layout/useScientSplit";
import { documentWasSaved } from "~/scient/markdownEditor/persistence/documentPublication";
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
import { usePdfSaveCopy } from "~/scient/pdf/usePdfSaveCopy";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { WordFileExportDialog } from "~/scient/wordExport/WordFileExportDialog";

import { documentBindingChanges } from "./bindingChanges";
import { DockCommandItem } from "../markdownEditor/ui/dockChrome";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "~/components/ui/menu";
import { ReaderButton } from "../writing/DocumentReaderControls";
import { DocumentExportMenuItems } from "../documentExport/DocumentExportMenuItems";
import { ReaderBarHostContext, type ReaderBarHost } from "../writing/readerBarHost";
const LatexProjectVisualEditor = lazy(() =>
  import("./LatexProjectVisualEditor").then((module) => ({
    default: module.LatexProjectVisualEditor,
  })),
);
import { LatexToolchainSetupCard } from "./LatexToolchainSetupCard";
import { readLatexBuildStatus, requestLatexForwardSync, requestLatexInverseSync } from "./client";
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
  LATEX_SPLIT_PREVIEW_STORAGE_KEY,
  LATEX_SPLIT_PREVIEWS,
  LATEX_SPLIT_KEYBOARD_STEP,
  LATEX_SPLIT_RATIO_STORAGE_KEY,
  LATEX_TOOLCHAIN_MISSING_HINT,
  MIN_LATEX_SPLIT_FRACTION,
  formatLatexDiagnosticLocation,
  latexCompiledFromPath,
  latexDiagnosticRows,
  latexStatusStripModel,
  normalizeLatexPreviewMode,
  normalizeLatexSplitPreview,
  normalizeLatexSplitFraction,
  type LatexViewerState,
  type ScientLatexPreviewMode,
  type ScientLatexSplitPreview,
} from "./scientLatexSurfaceModel";
import { useLatexSourceRecovery } from "./useLatexSourceRecovery";
import { LatexVisualRecoveryBar } from "./LatexVisualRecovery";
import { useLatexSourceIdentity } from "./visualPdfPublication";
import { prepareLatexDocument } from "./prepareLatexDocument";
import { latexDocumentInputs } from "./latexDocumentInputs";
import { useLatexAutoBuild } from "./useLatexAutoBuild";

import "./scient-latex.css";

type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;
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
  /** Only part of the file was read: it is shown, never edited or assembled. */
  readonly truncated: boolean;
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
const ignoreVisualEditing = () => {};
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

function initialSplitPreview(): ScientLatexSplitPreview {
  try {
    const stored = getLocalStorageItem(LATEX_SPLIT_PREVIEW_STORAGE_KEY, Schema.String);
    if (stored !== null) return normalizeLatexSplitPreview(stored);
    const previousView = getLocalStorageItem(LATEX_PREVIEW_MODE_STORAGE_KEY, Schema.String);
    return previousView === "visual" ? "visual" : "pdf";
  } catch (error) {
    console.error(error);
    return "pdf";
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
            showStaleNotice={false}
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
          <p>Choose Rebuild PDF to create the typeset document with your local TeX installation.</p>
        </div>
      )}
    </div>
  );
});

interface SourceSyncPosition {
  readonly line: number;
  readonly column: number;
}

function sourcePositionFromPointerEvent(event: MouseEvent<HTMLElement>): SourceSyncPosition | null {
  for (const candidate of event.nativeEvent.composedPath()) {
    if (!(candidate instanceof HTMLElement)) continue;
    const raw = candidate.dataset.line;
    if (raw === undefined) continue;
    const line = Number(raw);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    return { line, column: 0 };
  }
  return null;
}

export function ScientLatexSurface(props: ScientLatexSurfaceProps) {
  const savePdfCopy = usePdfSaveCopy(props.environmentId);
  const [exportingPdf, setExportingPdf] = useState(false);
  const visualDraftKey = `${props.environmentId}\0${props.cwd}\0${props.relativePath}`;
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
  const [splitPreview, setSplitPreview] = useState(initialSplitPreview);
  const [splitFraction, setSplitFraction] = useState(initialSplitFraction);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [hasLocalVisualDraft, setHasLocalVisualDraft] = useState(false);
  const finishVisualEditingRef = useRef<(() => boolean) | null>(null);
  const localVisualDraftRef = useRef(false);
  const [lastEditAt, setLastEditAt] = useState(0);
  const [visualProjectState, setVisualProjectState] = useState<{
    pending: boolean;
    error: string | null;
  }>({ pending: false, error: null });
  const [syncNotice, setSyncNotice] = useState<LatexSyncNotice | null>(null);
  const [wordExportOpen, setWordExportOpen] = useState(false);
  // The reader controls (sidebar, page, zoom, search) join this header row in PDF and Visual.
  const [readerSlot, setReaderSlot] = useState<HTMLElement | null>(null);
  const [hostedReaders, setHostedReaders] = useState(0);
  const onReaderHosted = useCallback(
    (hosted: boolean) => setHostedReaders((count) => count + (hosted ? 1 : -1)),
    [],
  );
  const { persistence } = props;
  const sourceRecovery = useLatexSourceRecovery(persistence, visualDraftKey, preferredMode);
  // Unsaved, saving, or waiting on a conflict or a failed save.
  const sourcePending = useSyncExternalStore(
    persistence?.subscribe ?? noSubscription,
    persistence ? () => persistence.getSnapshot().pending : notPending,
  );
  // A conflict or a failed save: the session's notice is asking for a decision.
  const sourceNeedsAttention = useSyncExternalStore(
    persistence?.subscribe ?? noSubscription,
    persistence
      ? () => {
          const snapshot = persistence.getSnapshot();
          return snapshot.conflict !== null || snapshot.error !== null;
        }
      : notPending,
  );
  const [forwardSyncTarget, setForwardSyncTarget] = useState<PdfForwardSyncTarget | null>(null);
  const [handledRevealRequestId, setHandledRevealRequestId] = useState<number | null>(null);
  const [finishedVisualRevealRequestId, setFinishedVisualRevealRequestId] = useState<number | null>(
    null,
  );
  const lastBindingChangeRef = useRef<DocumentBindingChange | null>(null);
  const syncRequestRef = useRef(0);
  const pdfPageRef = useRef<number | null>(null);

  useEffect(() => {
    const request = props.latexPresentationRequest;
    if (request === null) return;
    finishVisualEditingRef.current?.();
    setPreferredMode(request.mode);
    if (request.mode === "visual") {
      setSplitPreview("visual");
      persist(LATEX_SPLIT_PREVIEW_STORAGE_KEY, "visual", Schema.String);
    }
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
  useEffect(() => {
    if (persistence === null) return;
    let previous = persistence.getSnapshot();
    return persistence.subscribe(() => {
      const next = persistence.getSnapshot();
      const before = previous;
      previous = next;
      if (next.editVersion !== before.editVersion) setLastEditAt(Date.now());
      if (documentWasSaved(before, next) && target !== null) notifyLatexBindingChange(target);
    });
  }, [persistence, target]);
  const handleInstallToolchain = useCallback(() => {
    if (target !== null) requestManagedLatexInstall(target);
  }, [target]);
  // Visual and Source edit one working source, the session's. An edit made on
  // any other text is refused.
  const handleVisualEdit = useCallback(
    (expected: string, next: string) => {
      if (persistence === null) return false;
      const snapshot = persistence.getSnapshot();
      if (snapshot.draftSource !== expected) return false;
      if (expected === next) return true;
      if (sourceRecovery.blocked) return false;
      return persistence.change(next, snapshot.editVersion);
    },
    [persistence, sourceRecovery.blocked],
  );

  // A reveal asks for a line of source, so a document parked on the PDF shows
  // its source until the reader picks a layout again. The file panel's
  // rendered-markdown branch resolves the same conflict the same way.
  const revealRequested = revealLine !== null && handledRevealRequestId !== revealRequestId;
  const visualRevealNeedsFinish =
    revealRequested &&
    preferredMode === "visual" &&
    finishedVisualRevealRequestId !== revealRequestId;
  // A reveal changes the rendered layout to Split. Keep Visual mounted for one
  // transaction boundary so its layout effect can checkpoint the live
  // textarea before React removes the interaction layer. This runs before
  // paint, so the intermediate render is not visible to the user.
  useLayoutEffect(() => {
    if (!visualRevealNeedsFinish) return;
    finishVisualEditingRef.current?.();
    setFinishedVisualRevealRequestId(revealRequestId);
  }, [revealRequestId, visualRevealNeedsFinish]);
  const revealPending = revealRequested && !visualRevealNeedsFinish;
  const mode =
    revealPending && (preferredMode === "pdf" || preferredMode === "visual")
      ? "split"
      : preferredMode;
  const sourceIdentity = useLatexSourceIdentity(
    props.contents,
    !sourcePending && build.snapshot?.state === "succeeded",
  );
  const compiledRevision = build.snapshot?.visualSourceRevisions?.[props.relativePath];
  const pdfMatchesBuffer =
    sourceIdentity !== null &&
    sourceIdentity.revision === compiledRevision &&
    build.snapshot?.state === "succeeded";
  const selectMode = useCallback(
    (next: ScientLatexPreviewMode) => {
      finishVisualEditingRef.current?.();
      setPreferredMode(next);
      setHandledRevealRequestId(revealRequestId);
      persist(LATEX_PREVIEW_MODE_STORAGE_KEY, next, Schema.String);
      if (next === "pdf" || next === "visual") {
        setSplitPreview(next);
        persist(LATEX_SPLIT_PREVIEW_STORAGE_KEY, next, Schema.String);
      }
    },
    [revealRequestId],
  );

  const selectSplitPreview = useCallback((next: ScientLatexSplitPreview) => {
    finishVisualEditingRef.current?.();
    setSplitPreview(next);
    persist(LATEX_SPLIT_PREVIEW_STORAGE_KEY, next, Schema.String);
  }, []);

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
            ...(mode === "pdf" || (mode === "split" && splitPreview === "pdf")
              ? { onInverseSearch: handleInverseSync }
              : {}),
            onPageChange: handlePdfPageChange,
          }
        : undefined,
    [
      descriptor?._tag,
      forwardSyncTarget,
      handleInverseSync,
      handlePdfPageChange,
      mode,
      splitPreview,
    ],
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
  const showEditor = mode === "source" || mode === "split";
  const activePreview = mode === "split" ? splitPreview : mode === "source" ? null : mode;
  const showVisual = activePreview === "visual";
  const showRightPane = activePreview !== null;
  // Keep Visual's save sessions alive when hidden; only the chosen preview is visible.
  const [visualOpened, setVisualOpened] = useState(showVisual);
  if (showVisual && !visualOpened) setVisualOpened(true);

  const registerFinishVisualEditing = useCallback((finish: (() => boolean) | null) => {
    finishVisualEditingRef.current = finish;
  }, []);
  const reportLocalVisualDraft = useCallback((pending: boolean) => {
    localVisualDraftRef.current = pending;
    setHasLocalVisualDraft(pending);
  }, []);
  useLayoutEffect(
    () =>
      latexDocumentInputs.register({
        target: {
          environmentId: props.environmentId,
          cwd: props.cwd,
          relativePath: props.relativePath,
        },
        root: target?.relativePath ?? props.relativePath,
        finish: () => finishVisualEditingRef.current?.() ?? !localVisualDraftRef.current,
        pending: () => localVisualDraftRef.current,
      }),
    [props.environmentId, props.cwd, props.relativePath, target?.relativePath],
  );
  const prepareDocument = useCallback(async () => {
    if (!target || props.truncated) return null;
    const result = await prepareLatexDocument(target, {
      ...(persistence ? { selected: persistence } : {}),
    });
    if (!result.ok) {
      setSyncNotice({ label: "Document not ready", message: result.message });
      return null;
    }
    setSyncNotice(null);
    return result;
  }, [target, props.truncated, persistence]);
  const pdfVisible = activePreview === "pdf";
  const buildBlocked = props.truncated || sourceNeedsAttention || visualProjectState.error !== null;
  const buildRequestInFlight = useRef(false);
  const saveAndBuild = useCallback(
    async (reprobe = false, compile = true) => {
      if (buildRequestInFlight.current || buildBlocked) return;
      buildRequestInFlight.current = true;
      try {
        const prepared = await prepareDocument();
        if (prepared?.isCurrent() && compile && target !== null)
          requestLatexRebuild(target, { reprobeToolchain: reprobe });
      } finally {
        buildRequestInFlight.current = false;
      }
    },
    [buildBlocked, prepareDocument, target],
  );
  const requestAutoBuild = useCallback(() => {
    void saveAndBuild();
  }, [saveAndBuild]);
  useLatexAutoBuild({
    visible: pdfVisible,
    needsBuild:
      status.stale || descriptor === null || (sourceIdentity !== null && !pdfMatchesBuffer),
    blocked:
      !target ||
      !status.canRebuild ||
      buildBlocked ||
      sourcePending ||
      visualProjectState.pending ||
      hasLocalVisualDraft,
    busy: status.busy,
    toolchainReady: !!build.toolchain?.kind,
    sourceKey: (target?.relativePath ?? "") + "\0" + props.revision + "\0" + lastEditAt,
    requestBuild: requestAutoBuild,
  });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host) return;
    const ownsSave = (event: KeyboardEvent) =>
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "s" &&
      host.contains(document.activeElement);
    const releaseClaim = registerShortcutClaim(host, ownsSave);
    const save = (event: KeyboardEvent) => {
      if (!ownsSave(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void saveAndBuild(false, pdfVisible && !!build.toolchain?.kind);
    };
    window.addEventListener("keydown", save, true);
    return () => {
      releaseClaim();
      window.removeEventListener("keydown", save, true);
    };
  }, [saveAndBuild, pdfVisible, build.toolchain?.kind]);

  // Every mode with a right-hand pane: PDF, Visual, and Split's PDF or Visual.
  const mergesReaderBar = showRightPane;
  const splitPreviewSwitch =
    mode === "split" ? (
      <div
        className="scient-latex-modes scient-latex-split-modes"
        role="group"
        aria-label="Split right pane view"
      >
        {LATEX_SPLIT_PREVIEWS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="scient-latex-mode-button"
            aria-pressed={splitPreview === candidate}
            onClick={() => selectSplitPreview(candidate)}
          >
            {LATEX_PREVIEW_MODE_LABELS[candidate]}
          </button>
        ))}
      </div>
    ) : null;
  const readerHosted = mergesReaderBar && hostedReaders > 0;
  const buildButton = (
    <ScientTooltip
      content={
        status.canCancel
          ? "Cancel PDF build"
          : status.busy
            ? status.label
            : status.state === "failed"
              ? "Build failed. Rebuild PDF or open the log."
              : "Save and rebuild the PDF"
      }
    >
      <button
        type="button"
        className="scient-latex-action scient-latex-build-action"
        aria-label={status.canCancel ? "Cancel PDF build" : "Rebuild PDF"}
        disabled={target === null || (!status.canCancel && (!status.canRebuild || buildBlocked))}
        onClick={() => {
          if (status.canCancel && target) cancelLatexBuild(target);
          else void saveAndBuild(true);
        }}
      >
        {status.canCancel ? (
          <X className="size-3.5" aria-hidden="true" />
        ) : status.busy ? (
          <LoaderCircle className="size-3.5" aria-hidden="true" />
        ) : status.state === "failed" ? (
          <CircleAlert className="size-3.5" aria-hidden="true" />
        ) : (
          <RotateCw className="size-3.5" aria-hidden="true" />
        )}
        <span>{status.canCancel ? "Cancel" : status.busy ? "Building…" : "Rebuild"}</span>
      </button>
    </ScientTooltip>
  );
  const documentMenuItems = (
    <>
      {mode === "split"
        ? LATEX_SPLIT_PREVIEWS.map((candidate) => (
            <DockCommandItem key={candidate} onClick={() => selectSplitPreview(candidate)}>
              Split preview: {LATEX_PREVIEW_MODE_LABELS[candidate]}
            </DockCommandItem>
          ))
        : null}
      {diagnostics.length > 0 || status.state === "failed" ? (
        <DockCommandItem onClick={() => setDiagnosticsOpen(true)}>
          <CircleAlert /> Build messages
        </DockCommandItem>
      ) : null}
      <DocumentExportMenuItems
        onWordExport={() => setWordExportOpen(true)}
        wordDisabled={
          target === null ||
          sourcePending ||
          visualProjectState.pending ||
          hasLocalVisualDraft ||
          buildBlocked
        }
        pdfLabel={exportingPdf ? "Exporting\u2026" : "PDF"}
        pdfDisabled={
          descriptor === null ||
          !pdfMatchesBuffer ||
          status.stale ||
          status.busy ||
          sourcePending ||
          visualProjectState.pending ||
          hasLocalVisualDraft ||
          buildBlocked ||
          exportingPdf
        }
        pdfUnavailableReason="Rebuild PDF to export the current document."
        onPdfExport={() => {
          if (!descriptor || !pdfMatchesBuffer || status.stale || exportingPdf) return;
          setExportingPdf(true);
          setSyncNotice(null);
          void (async () => {
            const prepared = await prepareDocument();
            if (!prepared?.isCurrent() || !target) return;
            const snapshot = await readLatexBuildStatus(target.environmentId, {
              workspaceRoot: target.cwd,
              relativePath: target.relativePath,
            });
            if (!prepared.isCurrent()) return;
            const current = { ...build, snapshot };
            if (
              !snapshot?.descriptor ||
              latexStatusStripModel(current, props.cwd).stale ||
              latexStatusStripModel(current, props.cwd).busy ||
              [...prepared.revisions].some(
                ([path, revision]) =>
                  isLatexPreviewFile(path) && snapshot.visualSourceRevisions?.[path] !== revision,
              )
            ) {
              setSyncNotice({
                label: "Rebuild needed",
                message: "Rebuild the PDF before exporting the current document.",
              });
              return;
            }
            await savePdfCopy(snapshot.descriptor);
          })()
            .catch((error: unknown) =>
              setSyncNotice({
                label: "Export failed",
                message: error instanceof Error ? error.message : "Could not save the PDF copy.",
              }),
            )
            .finally(() => setExportingPdf(false));
        }}
      />
    </>
  );
  const readerBarHost = (slot: HTMLElement | null): ReaderBarHost => ({
    slot,
    beforeSearch: splitPreviewSwitch,
    trailing: buildButton,
    moreActions: documentMenuItems,
    onHosted: onReaderHosted,
  });
  return (
    <div
      ref={surfaceRef}
      className="scient-latex-surface"
      data-latex-layout={mode}
      dir="ltr"
      onInputCapture={() => setLastEditAt(Date.now())}
    >
      <div className="scient-latex-toolbar" data-reader-hosted={readerHosted ? "" : undefined}>
        <div className="scient-latex-modes" role="group" aria-label="Document view">
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
          ) : status.offline ? (
            <span className="scient-latex-status-label">Build status unavailable</span>
          ) : status.state === "failed" ? (
            <ScientTooltip
              content={
                status.firstDiagnosticLine ?? build.snapshot?.failureSummary ?? "Open the build log"
              }
            >
              <button
                type="button"
                className="scient-latex-action"
                onClick={() => setDiagnosticsOpen((open) => !open)}
              >
                Build failed · View details
              </button>
            </ScientTooltip>
          ) : null}
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
            <button
              type="button"
              className="scient-latex-chip scient-latex-chip-error"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((open) => !open)}
            >
              {status.errorCount} {status.errorCount === 1 ? "error" : "errors"}
            </button>
          ) : null}
          {status.warningCount > 0 ? (
            <button
              type="button"
              className="scient-latex-chip scient-latex-chip-warning"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((open) => !open)}
            >
              {status.warningCount} {status.warningCount === 1 ? "warning" : "warnings"}
            </button>
          ) : null}
          {visualProjectState.error === null ? null : (
            <ScientTooltip content={visualProjectState.error}>
              <span className="scient-latex-chip scient-latex-chip-error">Save failed</span>
            </ScientTooltip>
          )}
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
        <div ref={setReaderSlot} className="scient-latex-reader-slot" hidden={!mergesReaderBar} />
        <div className="scient-latex-actions">
          {readerHosted ? null : splitPreviewSwitch}
          {readerHosted ? null : buildButton}
          {readerHosted ? null : (
            // The same button and menu the reader controls use, so Rebuild and
            // More do not shift when the mode changes.
            <DropdownMenu>
              <DropdownMenuTrigger render={<ReaderButton label="More actions" />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{documentMenuItems}</DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {(diagnostics.length > 0 || status.state === "failed") && diagnosticsOpen ? (
        // Floats over the document: opening it moves nothing underneath.
        <div className="scient-latex-diagnostics-anchor">
          <div
            className="scient-latex-diagnostics"
            role="region"
            aria-label="Build messages"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              setDiagnosticsOpen(false);
            }}
          >
            <div className="scient-latex-diagnostics-header">
              <span className="scient-latex-diagnostics-summary">Build messages</span>
              {diagnostics.length > 0 ? (
                <span className="scient-latex-diagnostics-count">{diagnostics.length}</span>
              ) : null}
              <ScientTooltip content="Close">
                <button
                  type="button"
                  className="scient-latex-diagnostics-close"
                  aria-label="Close build messages"
                  onClick={() => setDiagnosticsOpen(false)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </ScientTooltip>
            </div>
            {diagnosticsOpen ? (
              diagnostics.length === 0 ? (
                <p className="scient-latex-diagnostic-message">
                  {build.snapshot?.failureSummary ??
                    "The build failed without compiler diagnostics. Check the LaTeX toolchain and rebuild."}
                </p>
              ) : (
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
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {(showEditor || sourceRecovery.blocked) && sourceRecovery.recovery ? (
        <LatexVisualRecoveryBar
          key={sourceRecovery.recovery.identity}
          recovery={sourceRecovery.recovery}
          currentSource={props.contents}
          applicable={true}
          disabled={persistence === null}
          onApply={sourceRecovery.apply}
          onDiscard={sourceRecovery.discard}
        />
      ) : null}
      {sourceRecovery.storageFailed ? (
        <p role="status">
          The local recovery copy could not be stored. Keep this document open until its workspace
          save succeeds.
        </p>
      ) : null}
      <div className="scient-latex-content" ref={containerRef}>
        {showEditor ? (
          <ScientTooltip
            content={
              mode === "split" && splitPreview === "pdf"
                ? "In Split, double-click a source line to find it in the PDF"
                : "LaTeX source"
            }
          >
            <div
              ref={primaryPaneRef}
              className={cn(
                "scient-latex-pane",
                mode === "split" ? "scient-latex-pane-sized" : null,
              )}
              onDoubleClickCapture={(event) => {
                if (mode !== "split" || splitPreview !== "pdf") return;
                const position = sourcePositionFromPointerEvent(event);
                if (position !== null) handleForwardSync(position);
              }}
            >
              {persistence === null || sourceRecovery.blocked ? (
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
                  wordWrap={props.wordWrap}
                  revealRequestId={props.revealRequestId}
                  onPostRender={props.onPostRender}
                />
              )}
            </div>
          </ScientTooltip>
        ) : null}

        {showRightPane || visualOpened ? (
          <div
            style={showRightPane ? undefined : { display: "none" }}
            className={cn(
              "scient-latex-viewer-shell",
              mode !== "split" && "scient-latex-viewer-shell-solo",
            )}
          >
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
            {showVisual || visualOpened ? (
              <div style={{ display: showVisual ? "contents" : "none" }}>
                <ReaderBarHostContext value={readerBarHost(showVisual ? readerSlot : null)}>
                  <Suspense fallback={<LatexPendingViewer label="Opening Visual view…" />}>
                    <LatexProjectVisualEditor
                      // The project's recovery copy is retired only when nothing is
                      // unsaved, so a failed or queued save of this file counts too.
                      selectedPending={sourcePending}
                      fileTruncated={props.truncated}
                      onSaved={() => {
                        if (target) notifyLatexBindingChange(target);
                      }}
                      onProjectStateChange={setVisualProjectState}
                      onOpenFileSource={(path, line) =>
                        props.onOpenFileSource(
                          path,
                          line,
                          resolvedRootRelativePath
                            ? { latexRootRelativePath: resolvedRootRelativePath }
                            : undefined,
                        )
                      }
                      rootRelativePath={resolvedRootRelativePath}
                      key={visualDraftKey}
                      source={props.contents}
                      onLocalDraftChange={reportLocalVisualDraft}
                      draftKey={visualDraftKey}
                      fileRevision={props.revision}
                      environmentId={props.environmentId}
                      cwd={props.cwd}
                      relativePath={props.relativePath}
                      disabled={props.truncated || persistence === null || sourceRecovery.blocked}
                      onEdit={handleVisualEdit}
                      onEditingChange={ignoreVisualEditing}
                      onOpenSource={() => selectMode("source")}
                      onOpenRoot={(mode = "source") => {
                        if (
                          !resolvedRootRelativePath ||
                          resolvedRootRelativePath === props.relativePath
                        )
                          selectMode(mode);
                        else
                          props.onOpenFileSource(
                            resolvedRootRelativePath,
                            mode === "source" ? 1 : undefined,
                            mode === "visual" ? { latexPreviewMode: "visual" } : undefined,
                          );
                      }}
                      registerFinishEditing={registerFinishVisualEditing}
                    />
                  </Suspense>
                </ReaderBarHostContext>
              </div>
            ) : null}
            {activePreview === "pdf" ? (
              <ReaderBarHostContext value={readerBarHost(readerSlot)}>
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
              </ReaderBarHostContext>
            ) : null}
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
          savedRevision={async () => {
            const prepared = await prepareDocument();
            return prepared?.isCurrent()
              ? (prepared.revisions.get(props.relativePath) ?? null)
              : null;
          }}
          onClose={() => setWordExportOpen(false)}
        />
      ) : null}
    </div>
  );
}
