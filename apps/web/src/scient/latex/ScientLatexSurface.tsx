import type { SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScientLatexDiagnostic, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRight, CircleAlert, LoaderCircle, RotateCw, TriangleAlert, X } from "lucide-react";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { DiffCommentAnnotation } from "~/components/diffs/DiffCommentAnnotation";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "~/components/files/fileCommentAnnotations";
import {
  projectFileCacheKey,
  projectFileEditorCacheKey,
} from "~/components/files/fileContentRevision";
import { installFileEditorDismissal } from "~/components/files/fileEditorDismissal";
import { FileSaveCoordinator } from "~/components/files/fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { LatexToolchainSetupCard } from "./LatexToolchainSetupCard";
import {
  cancelLatexBuild,
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
  LATEX_SPLIT_RATIO_STORAGE_KEY,
  LATEX_TOOLCHAIN_MISSING_HINT,
  formatLatexDiagnosticLocation,
  latexDiagnosticRows,
  latexSplitFractionFromPointer,
  latexStatusStripModel,
  normalizeLatexPreviewMode,
  normalizeLatexSplitFraction,
  type ScientLatexPreviewMode,
} from "./scientLatexSurfaceModel";

import "./scient-latex.css";

type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

interface ScientLatexSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly contents: string;
  readonly truncated: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
  readonly onPostRender: FilePostRender;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

const FILE_SAVE_DEBOUNCE_MS = 500;
const NO_DIAGNOSTICS: ReadonlyArray<ScientLatexDiagnostic> = [];
/**
 * Mirrors the file panel's private editor theming, including the reveal
 * highlight its post-render hook paints on this surface's rows. The attribute
 * name is part of that hook's contract, so both must move together.
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

function LatexDiagnosticsRow(props: { readonly diagnostic: ScientLatexDiagnostic }) {
  const location = formatLatexDiagnosticLocation(props.diagnostic);
  return (
    <li className="scient-latex-diagnostic">
      {props.diagnostic.severity === "error" ? (
        <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      )}
      {location === null ? null : (
        <span className="scient-latex-diagnostic-location">{location}</span>
      )}
      <span className="scient-latex-diagnostic-message">{props.diagnostic.message}</span>
    </li>
  );
}

interface LatexEditorHalfProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly contents: string;
  readonly revision: string;
  readonly resolvedTheme: "light" | "dark";
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
  readonly onPostRender: FilePostRender;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onSaveConfirmed: () => void;
}

interface FileSelectionOverride {
  readonly revealRequestId: number;
  readonly range: SelectedLineRange | null;
}

/**
 * The source half of the split. Same editor wiring as the inherited file
 * panel's editable surface, plus a build trigger on every confirmed save.
 */
function LatexEditorHalf({
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  revision,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onPendingChange,
  onSaveFailure,
  onSaveConfirmed,
}: LatexEditorHalfProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const saveCoordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        initialRevision: revision,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: (nextContents, expectedRevision) =>
          writeFile({
            environmentId,
            input: { cwd, relativePath, contents: nextContents, expectedRevision },
          }),
        revisionFromResult: (result) => result.revision,
        onConfirmed: (confirmedContents, result) => {
          confirmProjectFileQueryData(
            environmentId,
            cwd,
            relativePath,
            confirmedContents,
            result.revision,
          );
          onSaveConfirmed();
        },
        onFailure: (_contents, result) => onSaveFailure(squashAtomCommandFailure(result)),
      }),
    // The coordinator owns the debounce timer, so it outlives revision changes;
    // the confirmed revision is synced into it below instead.
    [cwd, environmentId, onPendingChange, onSaveConfirmed, onSaveFailure, relativePath, writeFile],
  );

  useEffect(() => saveCoordinator.syncConfirmedFileRevision(revision), [saveCoordinator, revision]);
  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        persistState: true,
        persistStateStorage: "inMemory",
        onChange: (file, nextLineAnnotations) => {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
          saveCoordinator.change(file.contents);
          if (nextLineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            setLineAnnotations(remapped);
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
                addReviewComment(
                  composerDraftTarget,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: file.contents,
                  }),
                );
              }
            }
          }
        },
      }),
    [addReviewComment, composerDraftTarget, cwd, environmentId, relativePath, saveCoordinator],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) =>
        current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        }),
      );
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      );
      if (existingIndex < 0) {
        return [...withoutDraft, { lineNumber: endLine, metadata: { entries: [draftEntry] } }];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, draftEntry] } }
          : annotation,
      );
    });
  }, []);

  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );

  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);

  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) beginComment(range);
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

  return (
    <EditProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 min-w-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: relativePath,
              contents,
              ...scientificSourceLanguageOverride(relativePath),
              cacheKey: projectFileEditorCacheKey(
                environmentId,
                cwd,
                relativePath,
                contents,
                editor.getFile(),
              ),
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: LATEX_EDITOR_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <DiffCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditProvider>
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

export function ScientLatexSurface(props: ScientLatexSurfaceProps) {
  const target = useMemo<LatexBuildTarget>(
    () => ({
      environmentId: props.environmentId,
      cwd: props.cwd,
      relativePath: props.relativePath,
    }),
    [props.cwd, props.environmentId, props.relativePath],
  );
  const build = useLatexBuild(target);
  const status = useMemo(() => latexStatusStripModel(build), [build]);
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.relativePath);
  const [mode, setMode] = useState(initialPreviewMode);
  const [splitFraction, setSplitFraction] = useState(initialSplitFraction);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    readonly left: number;
    readonly width: number;
    fraction: number;
    frame: number | null;
  } | null>(null);

  useEffect(() => startWatchingLatexBuild(target), [target]);

  const handleSaveConfirmed = useCallback(() => {
    setSaveError(null);
    requestLatexRebuild(target);
  }, [target]);
  const handleSaveFailure = useCallback((error: unknown) => {
    setSaveError(error instanceof Error ? error.message : "The file could not be saved.");
  }, []);
  const handleInstallToolchain = useCallback(() => {
    requestManagedLatexInstall(target);
  }, [target]);

  const selectMode = useCallback((next: ScientLatexPreviewMode) => {
    setMode(next);
    persist(LATEX_PREVIEW_MODE_STORAGE_KEY, next, Schema.String);
  }, []);

  // The divider writes straight to the pane's flex basis while dragging, so the
  // PDF beside it never re-renders mid-drag; React state catches up on release.
  const handleDividerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = splitRef.current;
      if (!container || event.button !== 0) return;
      const rect = container.getBoundingClientRect();
      dragRef.current = {
        left: rect.left,
        width: rect.width,
        fraction: splitFraction,
        frame: null,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [splitFraction],
  );

  const handleDividerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.fraction = latexSplitFractionFromPointer({
      pointerX: event.clientX,
      left: drag.left,
      width: drag.width,
    });
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      editorPaneRef.current?.style.setProperty("flex-basis", `${drag.fraction * 100}%`);
    });
  }, []);

  const handleDividerPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSplitFraction(drag.fraction);
    persist(LATEX_SPLIT_RATIO_STORAGE_KEY, drag.fraction, Schema.Number);
  }, []);

  const diagnostics = build.snapshot?.diagnostics ?? NO_DIAGNOSTICS;
  const diagnosticRows = useMemo(() => latexDiagnosticRows(diagnostics), [diagnostics]);
  const descriptor = build.snapshot?.descriptor ?? null;
  // Keyed by artifact, never by revision: a rebuild of the same document swaps
  // the reader's asset URL, and the reader keeps page and zoom across that.
  const readerKey =
    descriptor === null
      ? null
      : descriptor._tag === "generated-pdf"
        ? descriptor.artifactId
        : descriptor.logicalDocumentKey;
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
          {status.busy ? (
            <LoaderCircle
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          <span
            className={cn(
              "scient-latex-status-label",
              status.toolchainMissing || status.state === "failed" ? "text-destructive" : undefined,
            )}
            title={status.toolchainMissing ? LATEX_TOOLCHAIN_MISSING_HINT : undefined}
          >
            {status.label}
          </span>
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
            <span className="scient-latex-chip" title={status.staleReason ?? undefined}>
              Stale
            </span>
          ) : null}
          {saveError === null ? null : (
            <span className="scient-latex-chip scient-latex-chip-error" title={saveError}>
              Save failed
            </span>
          )}
        </div>
        <div className="scient-latex-actions">
          {status.canCancel ? (
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
            disabled={!status.canRebuild}
            onClick={() => requestLatexRebuild(target)}
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
                <LatexDiagnosticsRow key={row.key} diagnostic={row.diagnostic} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="scient-latex-content" ref={splitRef}>
        {showEditor ? (
          <div
            ref={editorPaneRef}
            className={cn("scient-latex-pane", mode === "split" ? "scient-latex-pane-sized" : null)}
            style={mode === "split" ? { flexBasis: `${splitFraction * 100}%` } : undefined}
          >
            {props.truncated ? (
              <LatexReadOnlyHalf
                cwd={props.cwd}
                relativePath={props.relativePath}
                contents={props.contents}
                resolvedTheme={props.resolvedTheme}
                wordWrap={props.wordWrap}
                onPostRender={props.onPostRender}
              />
            ) : (
              <LatexEditorHalf
                environmentId={props.environmentId}
                cwd={props.cwd}
                relativePath={props.relativePath}
                composerDraftTarget={props.composerDraftTarget}
                contents={props.contents}
                revision={file.data?.revision ?? ""}
                resolvedTheme={props.resolvedTheme}
                revealRequestId={props.revealRequestId}
                wordWrap={props.wordWrap}
                onPostRender={props.onPostRender}
                onPendingChange={props.onPendingChange}
                onSaveFailure={handleSaveFailure}
                onSaveConfirmed={handleSaveConfirmed}
              />
            )}
          </div>
        ) : null}

        {showEditor && showViewer ? (
          <div
            className="scient-latex-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize LaTeX preview"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            onPointerCancel={handleDividerPointerUp}
          />
        ) : null}

        {showViewer ? (
          <div className="scient-latex-pane scient-latex-pane-viewer">
            {descriptor !== null && readerKey !== null ? (
              <Suspense fallback={<LatexPendingViewer label="Opening PDF…" />}>
                <ScientPdfReader key={readerKey} source={descriptor} />
              </Suspense>
            ) : status.toolchainMissing ? (
              <LatexToolchainSetupCard status={build} onInstall={handleInstallToolchain} />
            ) : status.viewer === "diagnostics" ? (
              <div className="scient-latex-placeholder">
                <CircleAlert className="size-5 text-destructive" aria-hidden="true" />
                <h2>This document did not build</h2>
                <p>
                  {status.firstDiagnosticLine ??
                    build.snapshot?.failureSummary ??
                    "Check the build messages above."}
                </p>
              </div>
            ) : status.viewer === "building" ? (
              <LatexPendingViewer label="Building…" />
            ) : (
              <div className="scient-latex-placeholder">
                <p>Save this document or select Rebuild to compile a PDF.</p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
