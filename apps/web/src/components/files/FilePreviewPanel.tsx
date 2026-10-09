import type { EditorSelection } from "@pierre/diffs/edit";
// SCIENT-FORK:START
import {
  FILE_ACTIVE_RANGE_ATTRIBUTE,
  StaticTextFileSurface,
  type FilePostRender,
} from "~/scient/fileSurfaces/StaticTextFileSurface";
import {
  retryScientViewerAsset,
  scientViewerRevisionSuffix,
  useScientViewerRefreshKey,
  useScientViewerResource,
} from "~/scient/fileSurfaces/scientWorkspaceViewerRefresh";
import {
  ScientMathSourceToolbar,
  scientEditorGutterUtility,
  scientFileEditorUnsafeCss,
  useScientFileEditorBindings,
} from "~/scient/fileSurfaces/scientFileEditorBindings";
import {
  applyScientFileRename,
  ScientDocumentSessionAdmissionFailure,
  scientDocumentSessionFile,
} from "~/scient/fileSurfaces/scientDocumentSession";
import {
  ScientComputeFileSurface,
  ScientLatexSurface,
  ScientPdfReader,
  ScientSurfaceSuspense,
} from "~/scient/fileSurfaces/scientLazyFileSurfaces";
import { useScientFileReadRecovery } from "~/scient/fileSurfaces/scientFileReadRecovery";
// SCIENT-FORK:END
import { useAtomValue } from "@effect/atom-react";
import { Spinner } from "~/components/ui/spinner";
import {
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import { VirtualizedFile, type GetHoveredLineResult, type SelectedLineRange } from "@pierre/diffs";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  getFiletypeFromFileName,
  type FileContents,
  type PostRenderPhase,
} from "@pierre/diffs";
import {
  Editor,
  type EditorChangeEvent,
  type EditorFactory,
  type EditorOptions,
} from "@pierre/diffs/edit";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { EditProvider, File, Virtualizer, useWorkerPool } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useFilesystemReadAccess } from "~/state/filesystem";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { Download, FolderTree, Globe, WrapTextIcon } from "lucide-react";
import { Code2, Eye, Table2 } from "lucide";
import { MarkdownDownloadMenu } from "~/scient/documentExport/MarkdownDownloadMenu";
import {
  DocumentDownloadMenu,
  type DocumentDownloadActions,
} from "~/scient/documentExport/DocumentDownloadMenu";
import * as Schema from "effect/Schema";
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import type { FileCitation } from "@t3tools/contracts";
import type { MarkdownCiteHandler } from "~/scient/markdownEditor/markdownCitation";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { MorphIcon } from "~/components/MorphIcon";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import type {
  HtmlFilePresentationRequest,
  LatexFilePresentationRequest,
  OpenFileOptions,
} from "~/rightPanelStore";
import { workspaceFileHostPath } from "./filePath";
import type { ChatFileAttachment } from "~/types";
import { isAbsolutePath } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  RENDER_MARKDOWN_STORAGE_KEY,
  SCIENT_DEFAULT_RENDER_MARKDOWN,
  resolveHtmlRenderedState,
  resolveMarkdownRenderedState,
  markdownViewTransition,
  resolveInitialFileExplorerOpen,
} from "~/scient/fileOpening/fileOpeningPolicy";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";
import { computeSourceLanguageForPath } from "~/scient/compute/computeSourceLanguage";
import { computeFileContextId } from "~/scient/compute/computeContextStore";
import { FileRenameButton } from "./FileRenameButton";
import { useNewDocument } from "~/scient/documents/useNewDocument";
import { normalizeMarkdownCreatePath } from "~/scient/markdownEditor/ui/ScientMarkdownCreateButton";
import type { LatexRenameContext } from "~/scient/latex/ScientLatexSurface";
import {
  isScientMarkdownDocumentPath,
  shouldUseScientMarkdownEditor,
} from "~/scient/markdownEditor/markdownDocumentPaths";
import { ScientMarkdownPersistenceNotice } from "~/scient/markdownEditor/ui/ScientMarkdownPersistenceNotice";
import { useMarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease";
import { useMarkdownPersistenceGuards } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceGuards";
import { useMarkdownSourcePersistence } from "~/scient/markdownEditor/persistence/useMarkdownSourcePersistence";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { documentSessionIsCurrent } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { workspacePdfSourceForPreview } from "~/scient/pdf/pdfSource";
import {
  ScientFileFreshnessNotices,
  ScientFileFreshnessStatus,
  ScientFileReloadButton,
} from "~/scient/fileSurfaces/ScientFileFreshnessControls";
import {
  type FileSaveResolution,
  useSessionFileWatch,
  useWorkspaceFileRefresh,
} from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { usePendingSurfaceDeparture } from "~/scient/fileSurfaces/usePendingSurfaceDeparture";
import { MEDIA_FAILURE_COPY, readOnlyNotice } from "~/scient/fileSurfaces/fileFailureCopy";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import {
  FILE_LINK_REVEAL_ATTRIBUTE,
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";
import SourceFilePreview from "./ReadOnlySourcePreview";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { projectFileCacheKey } from "./fileContentRevision";
import { FileBreadcrumbNavigator } from "./FileBreadcrumbNavigator";
import {
  isLatexPreviewFile,
  isMarkdownPreviewFile,
  resolveMarkdownTaskPreviewUpdate,
  resolveFilePreviewPath,
  shouldShowFileExplorer,
} from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  onCiteFile?: MarkdownCiteHandler;
  fileCitation?: FileCitation | undefined;
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  attachment?: ChatFileAttachment;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  htmlPresentationRequest: HtmlFilePresentationRequest | null;
  latexPresentationRequest: LatexFilePresentationRequest | null;
  latexRootRelativePath: string | null;
  onOpenFile: (relativePath: string) => void;
  /** The open file was renamed: its tab follows it to the new path. */
  onFileRenamed: (fromPath: string, toPath: string) => void;
  onOpenFileSource: (relativePath: string, line?: number, options?: OpenFileOptions) => void;
  onHtmlPresentationRequestHandled: (
    relativePath: string,
    request: HtmlFilePresentationRequest,
  ) => void;
  onLatexPresentationRequestHandled: (
    relativePath: string,
    request: LatexFilePresentationRequest,
  ) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "t3code.renderTable";
// SCIENT-FORK:START — the Markdown surface loads on first use
const ScientMarkdownFileSurface = lazy(() =>
  import("~/scient/markdownEditor/ScientMarkdownFileSurface").then((module) => ({
    default: module.ScientMarkdownFileSurface,
  })),
);
// SCIENT-FORK:END

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly alt: string;
  readonly refreshKey: number;
}) {
  // SCIENT-FORK:START — the asset is named by the tab's own path
  const resource = useScientViewerResource(props);
  // SCIENT-FORK:END
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // SCIENT-FORK:START — reload when the file's watcher reports a change
  useScientViewerRefreshKey(props.refreshKey, assetUrl.refresh, setFailedUrl);
  const revisionSuffix = scientViewerRevisionSuffix(assetUrl, props.refreshKey);
  // SCIENT-FORK:END
  const imageUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  const actionsSource: MediaActionSource = {
    kind: "image",
    name: props.alt,
    src: imageUrl,
    reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
    asset: { environmentId: props.environmentId, resource },
  };

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <MediaActions source={actionsSource}>
        {/* A plain element receives the menu trigger's handlers and ref. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <FileSurfaceFailure
            {...MEDIA_FAILURE_COPY.image}
            retrying={retrying || (assetUrl._tag === "Failure" && assetUrl.waiting === true)}
            onRetry={() =>
              // Keep the failure (busy) until renewed authorization arrives, so
              // the old URL is not shown, and cannot fail, in the meantime.
              retryScientViewerAsset(refreshAssetUrl, setRetrying, () => setFailedUrl(null))
            }
          />
        </div>
      </MediaActions>
    );
  }

  return assetUrl._tag === "Success" && imageUrl !== null ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <MediaActions source={actionsSource}>
        <img
          className="max-h-full max-w-full object-contain"
          src={imageUrl}
          alt={props.alt}
          onError={() => setFailedUrl(imageUrl)}
        />
      </MediaActions>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner size="lg" />
    </div>
  );
}

/**
 * Renders an HTML or PDF file in place from its signed asset URL. HTML runs in
 * a sandboxed frame with an opaque origin, so a page cannot reach the app's
 * session or storage. A page may load the files beside it, inside the
 * workspace or out of it; a PDF outside the workspace is served on its own.
 */
function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly title: string;
  readonly refreshKey: number;
}) {
  // SCIENT-FORK:START — the asset is named by the tab's own path
  const resource = useScientViewerResource(props, !isPdfPreviewFile(props.absolutePath));
  // SCIENT-FORK:END
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  // SCIENT-FORK:START — reload when the file's watcher reports a change
  useScientViewerRefreshKey(props.refreshKey, assetUrl.refresh);
  const revisionSuffix = scientViewerRevisionSuffix(assetUrl, props.refreshKey);
  // SCIENT-FORK:END

  if (assetUrl._tag === "Failure") {
    return (
      <FileSurfaceFailure
        {...MEDIA_FAILURE_COPY.document}
        retrying={assetUrl.waiting === true}
        onRetry={assetUrl.refresh}
      />
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly name: string;
  readonly refreshKey: number;
}) {
  const reference = mediaFileReference(props.absolutePath, props.workspaceRoot);
  // SCIENT-FORK:START — the asset is named by the tab's own path
  const resource = useScientViewerResource(props);
  // SCIENT-FORK:END
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  // SCIENT-FORK:START — reload when the file's watcher reports a change
  useScientViewerRefreshKey(props.refreshKey, refreshAssetUrl);
  const revisionSuffix = scientViewerRevisionSuffix(assetUrl, props.refreshKey);
  // SCIENT-FORK:END
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={String(props.refreshKey)}
        preload="metadata"
        className="flex h-full min-h-0 w-full max-w-5xl items-center justify-center"
        onRetry={refreshAssetUrl}
        actionsSource={{
          kind: "video",
          name: props.name,
          src: latestUrl,
          reference,
          asset: { environmentId: props.environmentId, resource },
        }}
      />
    </div>
  );
}

function WorkspaceAudioPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
  /** Advances when the file's native watcher reports a change. */
  readonly refreshKey: number;
}) {
  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  // SCIENT-FORK:START — reload when the file's watcher reports a change
  useScientViewerRefreshKey(props.refreshKey, refreshAssetUrl, setFailedUrl);
  // SCIENT-FORK:END
  const revision =
    props.workspaceMutationId === null && props.refreshKey === 0
      ? null
      : `${props.workspaceMutationId ?? ""}:${props.refreshKey}`;
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(revision)}`;
  const url = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  if (assetUrl._tag === "Failure" || (url !== null && failedUrl === url)) {
    return (
      <FileSurfaceFailure
        {...MEDIA_FAILURE_COPY.audio}
        retrying={retrying}
        onRetry={() => {
          setFailedUrl(null);
          retryScientViewerAsset(refreshAssetUrl, setRetrying);
        }}
      />
    );
  }
  if (url === null) return <FileSurfaceLoading />;
  return <AudioPreview src={url} name={props.name} onError={() => setFailedUrl(url)} />;
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const existingState = revealStatesByPath.get(relativePath);
      const state: FileRevealState = existingState ?? {
        frameId: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      };
      if (!existingState) revealStatesByPath.set(relativePath, state);

      const cancelPendingReveal = () => {
        if (state.frameId !== null) {
          cancelAnimationFrame(state.frameId);
          state.frameId = null;
        }
        state.cancelGuard?.();
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const contents = instance.file?.contents;
      const targetLine =
        revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (state.latestRequestId !== revealRequestId) {
        cancelPendingReveal();
        state.latestRequestId = revealRequestId;
        state.handledRequestId = null;
      }

      if (revealLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (state.handledRequestId === revealRequestId || state.frameId !== null) {
        return;
      }

      const resolveScrollTarget = (line: number): number | null => {
        const linePosition = instance.getLinePosition(line);
        if (!linePosition) return null;

        const scrollContainerRect = scrollContainer.getBoundingClientRect();
        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainerRect.top;
        const root = fileContainer.shadowRoot ?? fileContainer;
        const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
        const renderedLineRect = renderedLineElement?.getBoundingClientRect();

        return resolveCenteredFileLineScrollTop({
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
          viewportTop: scrollContainerRect.top,
          viewportHeight: scrollContainer.clientHeight,
          fileTop,
          estimatedLine: linePosition,
          ...(renderedLineRect && renderedLineRect.height > 0
            ? {
                renderedLine: {
                  top: renderedLineRect.top,
                  height: renderedLineRect.height,
                },
              }
            : {}),
        });
      };

      const guardScrollTarget = (line: number) => {
        let framesLeft = REVEAL_GUARD_FRAMES;
        let guardFrameId: number | null = null;
        const cancelGuard = () => {
          if (guardFrameId !== null) {
            cancelAnimationFrame(guardFrameId);
            guardFrameId = null;
          }
          scrollContainer.removeEventListener("wheel", cancelGuard);
          scrollContainer.removeEventListener("touchstart", cancelGuard);
          scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
          window.removeEventListener("keydown", cancelGuard, true);
          if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
        };
        scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
        scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a comment cancels the reveal guard before the row expands.
        scrollContainer.addEventListener("pointerdown", cancelGuard, {
          passive: true,
          capture: true,
        });
        window.addEventListener("keydown", cancelGuard, true);
        const holdTarget = () => {
          guardFrameId = null;
          framesLeft -= 1;
          if (framesLeft <= 0 || !scrollContainer.isConnected) {
            cancelGuard();
            return;
          }
          const targetTop = resolveScrollTarget(line);
          if (
            targetTop !== null &&
            Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
          ) {
            scrollContainer.scrollTop = targetTop;
          }
          guardFrameId = requestAnimationFrame(holdTarget);
        };
        guardFrameId = requestAnimationFrame(holdTarget);
        state.cancelGuard = cancelGuard;
      };

      const scheduleReveal = (attempt: number) => {
        state.frameId = requestAnimationFrame(() => {
          state.frameId = null;
          if (state.latestRequestId !== revealRequestId || !fileContainer.isConnected) {
            return;
          }

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
          const currentContents = instance.file?.contents;
          const line =
            currentContents === undefined ? null : clampFileLine(currentContents, revealLine);
          const targetTop = line === null ? null : resolveScrollTarget(line);
          if (line === null || targetTop === null) {
            if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
            return;
          }
          updateFileLinkReveal(fileContainer, line);

          scrollContainer.scrollTop = targetTop;
          state.handledRequestId = revealRequestId;
          guardScrollTarget(line);
        });
      };

      scheduleReveal(0);
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId],
  );
}

const createFileEditor: EditorFactory<FileCommentAnnotationGroup, undefined> = (
  editorType,
  options,
  editStateKey,
) => new Editor(editorType, options, editStateKey);

function editableFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): FileContents {
  return {
    name: relativePath,
    contents,
    ...scientificSourceLanguageOverride(relativePath),
    cacheKey: `editor:${environmentId}:${projectFileCacheKey(cwd, relativePath, contents)}`,
  };
}

function needsWorkerHighlight(workerPool: WorkerPoolManager | undefined, file: FileContents) {
  if (workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === "text") return false;
  let lines = 1;
  for (
    let index = file.contents.indexOf("\n");
    index !== -1;
    index = file.contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/**
 * Pierre highlights an active edit session on the main thread, so each version
 * of the file becomes editable only once it has rendered the worker's
 * highlight. A failed worker highlight falls back to main-thread highlighting.
 */
function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlightedFile, setHighlightedFile] = useState<FileContents | null>(null);
  const needsHighlight = useMemo(() => needsWorkerHighlight(workerPool, file), [file, workerPool]);
  const ready = !needsHighlight || highlightedFile === file;

  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlightedFile(file));
  }, [file, ready, workerPool]);

  const onPostRender = useCallback(
    (renderedFile: FileContents | undefined, phase: PostRenderPhase) => {
      if (ready || phase === "unmount" || renderedFile?.cacheKey !== file.cacheKey) return;
      // The pool caches a result just before the instance renders it, so a
      // render that sees the cache has painted highlighted rows.
      if (workerPool?.getFileResultCache(file) !== undefined) setHighlightedFile(file);
    },
    [file, ready, workerPool],
  );
  return { ready, onPostRender };
}

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  revision: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailure: (relativePath: string, error: unknown) => void;
  onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  onSaveResolutionApplied: () => void;
  saveResolution: FileSaveResolution | null;
  onSelectionChange?: (range: SelectedLineRange | null) => void;
  activeLineRange?: SelectedLineRange | null;
  onEditorSelectionChange?: (selection: EditorSelection | null) => void;
  renderEditorGutterAction?: (
    getHoveredLine: () => GetHoveredLineResult<"file"> | undefined,
  ) => ReactNode;
  onRunShortcut?: (selection: EditorSelection | null) => void;
  /** Inline review comments. Selection handlers may independently suppress auto-open. */
  enableFileComments?: boolean;
  /** Compute actions stay quiet until the corresponding source line is engaged. */
  gutterUtilityVisibility?: "always" | "hover";
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

export function EditableFileSurface(props: EditableFileSurfaceProps) {
  const coordinator = useFileSaveCoordinator(props);
  const onContentsChange = useCallback(
    (contents: string) => {
      setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, contents);
      coordinator.change(contents);
    },
    [coordinator, props.environmentId, props.cwd, props.relativePath],
  );
  return (
    <DiffWorkerPoolProvider>
      <EditableFileEditor {...props} onContentsChange={onContentsChange} />
    </DiffWorkerPoolProvider>
  );
}

export function MarkdownSourceSurface({
  persistence,
  ...props
}: Omit<Parameters<typeof EditableFileEditor>[0], "contents" | "revision" | "onContentsChange"> & {
  persistence: MarkdownPersistenceLease;
}) {
  const bindings = useMarkdownSourcePersistence(persistence);
  return (
    <DiffWorkerPoolProvider>
      <EditableFileEditor {...props} {...bindings} />
    </DiffWorkerPoolProvider>
  );
}

export function EditableFileEditor({
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onContentsChange,
  onProjectionApplied,
  externalPersistence,
  onExternalVersionApplied,
  editingBlocked = false,
  onSelectionChange,
  activeLineRange,
  onEditorSelectionChange,
  renderEditorGutterAction,
  onRunShortcut,
  enableFileComments = true,
  gutterUtilityVisibility = "always",
}: Omit<
  EditableFileSurfaceProps,
  | "onPendingChange"
  | "onSaveFailure"
  | "onSaveConfirmed"
  | "onSaveResolutionApplied"
  | "saveResolution"
> & {
  onContentsChange: (source: string) => void;
  onProjectionApplied?: (source: string) => void;
  externalPersistence?: MarkdownPersistenceLease;
  onExternalVersionApplied?: (version: number) => void;
  editingBlocked?: boolean;
}) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const displayedRange = selectedRange ?? activeLineRange ?? null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
      onSelectionChange?.(range);
    },
    [onSelectionChange, revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const editorSelectionFrameRef = useRef<number | null>(null);
  const reportEditorSelectionRef = useRef<() => void>(() => undefined);
  const projectionAppliedRef = useRef(onProjectionApplied);
  projectionAppliedRef.current = onProjectionApplied;
  // SCIENT-FORK:START — Shared document lease gates retained native source history.
  const applyingExternal = useRef(false);
  const projectionReady = useRef(false);
  const [restorationBlocked, setRestorationBlocked] = useState(false);
  const externalBindings = useRef({ externalPersistence, onExternalVersionApplied });
  externalBindings.current = { externalPersistence, onExternalVersionApplied };
  // SCIENT-FORK:END
  const [externalFile, setExternalFile] = useState(() =>
    editableFileContents(environmentId, cwd, relativePath, contents),
  );
  const [editedContents, setEditedContents] = useState<string | null>(null);
  if (contents !== (editedContents ?? externalFile.contents)) {
    setExternalFile(editableFileContents(environmentId, cwd, relativePath, contents));
    setEditedContents(null);
  }
  const { ready: editable, onPostRender: onEditablePostRender } =
    useEditableAfterHighlight(externalFile);
  const editorRef = useRef<Editor<"file", FileCommentAnnotationGroup, undefined> | null>(null);
  const [editor, setEditor] = useState<Editor<
    "file",
    FileCommentAnnotationGroup,
    undefined
  > | null>(null);
  const editorOptions = useMemo<EditorOptions<"file", FileCommentAnnotationGroup, undefined>>(
    () => ({
      ownsVerticalViewport: true,
      // SCIENT-FORK:START — Rebase or refuse stale source projection without dropping undo.
      onAttach: (attachedEditor) => {
        editorRef.current = attachedEditor;
        setEditor(attachedEditor);
        const persistence = externalBindings.current.externalPersistence;
        projectionReady.current = persistence === undefined;
        const snapshot = persistence?.getSnapshot();
        const restored = attachedEditor.getFile();
        // Pierre retains source undo between mounts; the shared document lease
        // may have advanced in Rich while that source editor was dormant.
        if (
          persistence &&
          restored &&
          snapshot &&
          !snapshot.editingBlocked &&
          persistence.getPendingInput() === null &&
          restored.contents !== snapshot.draftSource
        ) {
          const previous = restored.contents;
          const current = snapshot.draftSource;
          const splitsBoundary = (source: string, offset: number) => {
            if (offset === 0 || offset === source.length) return false;
            const before = source.charCodeAt(offset - 1);
            const after = source.charCodeAt(offset);
            return (
              (before === 13 && after === 10) ||
              (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
            );
          };
          let start = 0;
          while (
            start < previous.length &&
            start < current.length &&
            previous[start] === current[start]
          )
            start += 1;
          while (splitsBoundary(previous, start) || splitsBoundary(current, start)) start -= 1;
          let suffix = 0;
          while (
            suffix < previous.length - start &&
            suffix < current.length - start &&
            previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
          )
            suffix += 1;
          while (
            splitsBoundary(previous, previous.length - suffix) ||
            splitsBoundary(current, current.length - suffix)
          )
            suffix -= 1;
          const end = previous.length - suffix;
          const text = current.slice(start, current.length - suffix);
          const prepared = attachedEditor.prepareExternalEdits(previous, [{ start, end, text }]);
          const latest = persistence.getSnapshot();
          if (
            prepared &&
            externalBindings.current.externalPersistence === persistence &&
            editorRef.current === attachedEditor &&
            latest.editVersion === snapshot.editVersion &&
            latest.draftSource === current &&
            !latest.editingBlocked &&
            persistence.getPendingInput() === null &&
            previous.slice(0, start) + text + previous.slice(end) === current
          ) {
            applyingExternal.current = true;
            try {
              prepared();
            } finally {
              applyingExternal.current = false;
            }
          }
        }
        const projected = attachedEditor.getFile();
        if (persistence) {
          const current = persistence.getSnapshot();
          projectionReady.current =
            externalBindings.current.externalPersistence === persistence &&
            editorRef.current === attachedEditor &&
            projected?.contents === current.draftSource;
          setRestorationBlocked(!projectionReady.current);
        }
        if (projected) projectionAppliedRef.current?.(projected.contents);
        queueMicrotask(() => externalBindings.current.externalPersistence?.resumeExternalUpdates());
      },
      // SCIENT-FORK:END
      onComplete: () => {
        editorRef.current = null;
      },
      onFocus: () => queueMicrotask(() => reportEditorSelectionRef.current()),
    }),
    [],
  );
  const handleEditChange = useCallback(
    ({
      file,
      editor: changedEditor,
      lineAnnotations: nextLineAnnotations,
    }: EditorChangeEvent<"file", FileCommentAnnotationGroup, undefined>) => {
      // SCIENT-FORK:START — Only the current, acknowledged projection may publish source edits.
      if (
        externalBindings.current.externalPersistence &&
        !applyingExternal.current &&
        (!projectionReady.current || changedEditor !== editorRef.current)
      )
        return;
      // SCIENT-FORK:END
      setEditedContents(file.contents);
      if (!applyingExternal.current) onContentsChange(file.contents);
      if (nextLineAnnotations) {
        const remapped = remapFileCommentAnnotations(nextLineAnnotations);
        setLineAnnotations((current) => (current === nextLineAnnotations ? current : remapped));
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
      queueMicrotask(() => reportEditorSelectionRef.current());
    },
    [addReviewComment, composerDraftTarget, onContentsChange, relativePath],
  );
  const { mathInput, onCompositionEnd, onKeyDownCapture } = useScientFileEditorBindings({
    editor,
    relativePath,
    editingBlocked: editingBlocked || restorationBlocked,
    surfaceRef,
    externalPersistence,
    externalBindings,
    applyingExternal,
    editorSelectionFrameRef,
    reportEditorSelectionRef,
    onEditorSelectionChange,
    onRunShortcut,
  });

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
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
    editorRef.current?.setSelections([]);
    editorRef.current?.blur();
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
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
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
      editor: {
        getFile: () => editorRef.current?.getFile(),
        setSelections: (selections) => editorRef.current?.setSelections(selections),
      },
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range && onSelectionChange === undefined && enableFileComments) {
        beginComment(range);
      }
    },
    [beginComment, enableFileComments, onSelectionChange, setSelectedRange],
  );
  const handleGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      setSelectedRange(range);
      beginComment(range);
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);
      onEditablePostRender(instance.file, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") {
        fileContainer.removeAttribute(FILE_ACTIVE_RANGE_ATTRIBUTE);
        return;
      }

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        const showsActiveRange = selectedRange === null && activeLineRange != null;
        fileContainer.toggleAttribute(FILE_ACTIVE_RANGE_ATTRIBUTE, showsActiveRange);
        instance.setSelectedLines(
          displayedRange,
          showsActiveRange
            ? { notify: false, activeLineSide: "additions", lineNumberOnly: false }
            : { notify: false },
        );
      });
    },
    [activeLineRange, displayedRange, onEditablePostRender, onPostRender, selectedRange],
  );

  return (
    <EditProvider createEditor={createFileEditor}>
      <div
        ref={surfaceRef}
        className="relative flex min-h-0 flex-1"
        onCompositionEnd={onCompositionEnd}
        onKeyDownCapture={onKeyDownCapture}
      >
        {/* SCIENT-FORK:START — Explain source refusal without discarding retained edits. */}
        {restorationBlocked ? (
          <div role="alert" className="p-2 text-xs text-muted-foreground">
            Source editing is paused to protect changes made in Rich. Return to Rich to continue.
          </div>
        ) : null}
        {/* SCIENT-FORK:END */}
        {/* SCIENT-FORK:START — source math input */}
        <ScientMathSourceToolbar
          mathInput={mathInput}
          editingBlocked={editingBlocked || restorationBlocked}
        />
        {/* SCIENT-FORK:END */}
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={externalFile}
            edit={editable && !editingBlocked && !restorationBlocked}
            editStateKey={`scient-file:${environmentId}:${cwd}:${relativePath}`}
            editorOptions={editorOptions}
            onEditChange={handleEditChange}
            options={{
              disableFileHeader: true,
              enableGutterUtility:
                renderEditorGutterAction !== undefined ||
                (enableFileComments && !hasOpenCommentForm),
              enableLineSelection: !hasOpenCommentForm,
              ...(renderEditorGutterAction === undefined && enableFileComments
                ? { onGutterUtilityClick: handleGutterUtilityClick }
                : {}),
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              unsafeCSS: scientFileEditorUnsafeCss(gutterUtilityVisibility),
              onPostRender: handlePostRender,
            }}
            selectedLines={displayedRange}
            lineAnnotations={enableFileComments ? lineAnnotations : []}
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
            // SCIENT-FORK:START — editor action beside Add comment in the gutter
            {...scientEditorGutterUtility(
              renderEditorGutterAction,
              enableFileComments,
              handleGutterUtilityClick,
            )}
            // SCIENT-FORK:END
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

/** T3's ordinary rendered preview remains authoritative for MDX. */
function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  revision,
  truncated,
  readOnly,
  threadRef,
  onPendingChange,
  onSaveFailure,
  onSaveConfirmed,
  onSaveResolutionApplied,
  saveResolution,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
> & {
  truncated: boolean;
  readOnly: boolean;
  threadRef: ScopedThreadRef;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    revision,
    onPendingChange,
    onSaveFailure,
    onSaveConfirmed,
    onSaveResolutionApplied,
    saveResolution,
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        onTaskListChange={
          truncated || readOnly
            ? undefined
            : ({ markerOffset, checked }) => {
                const currentContents =
                  getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
                  contents;
                const nextContents = resolveMarkdownTaskPreviewUpdate({
                  markdown: currentContents,
                  markerOffset,
                  checked,
                  truncated,
                });
                if (nextContents === null) return;
                setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
                saveCoordinator.change(nextContents);
              }
        }
      />
    </ScrollArea>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

function initialExplorerOpen(): boolean {
  try {
    return resolveInitialFileExplorerOpen(
      getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean),
    );
  } catch (error) {
    console.error(error);
    return resolveInitialFileExplorerOpen(null);
  }
}

export default function FilePreviewPanel({
  onCiteFile,
  fileCitation,
  environmentId,
  cwd,
  projectName,
  relativePath: requestedPath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  htmlPresentationRequest,
  latexPresentationRequest,
  latexRootRelativePath,
  onOpenFile,
  onFileRenamed,
  onOpenFileSource,
  onHtmlPresentationRequestHandled,
  onLatexPresentationRequestHandled,
  onPendingChange,
  selectedFilePending,
  workspaceMutationId,
}: FilePreviewPanelProps) {
  const relativePath =
    attachment === undefined ? resolveFilePreviewPath(requestedPath, cwd) : requestedPath;
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const updateClientSettings = useUpdateClientSettings();
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const previewAvailable = usePreviewAvailable(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && !isVideo && isWorkspaceAudioPreviewPath(relativePath);
  const isImage = relativePath !== null && !isVideo && isWorkspaceImagePreviewPath(relativePath);
  const isMedia = isImage || isVideo || isAudio;
  // PDFs have no text to show; HTML has, and can toggle between page and source.
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  // Attachments and absolute host paths are preview-only and never enter the
  // workspace editor or explorer.
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isAbsolutePath(relativePath));
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [genericPendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const {
    pendingSurfaceIds: pendingPaths,
    quietSurfaceIds: quietMarkdownPaths,
    departureOptions,
  } = useMarkdownPersistenceGuards({
    environmentId,
    cwd,
    idKind: "path",
    genericPendingIds: genericPendingPaths,
  });
  const sourcePending = relativePath !== null && pendingPaths.has(relativePath);
  const effectiveSourcePending = sourcePending || selectedFilePending;
  const runAfterPendingSave = usePendingSurfaceDeparture(pendingPaths, departureOptions);
  const isMarkdownPreview = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const isRichMarkdown = relativePath ? isScientMarkdownDocumentPath(relativePath) : false;
  const isMarkdownDocument = isMarkdownPreview || isRichMarkdown;
  // Files whose saving belongs to a document session, not to this panel's
  // generic saver: one owner per file for every view of it.
  const usesDocumentSession =
    !isHostFile &&
    relativePath !== null &&
    (isRichMarkdown ||
      (documentSessionIsCurrent &&
        (isLatexPreviewFile(relativePath) || /\.bib$/i.test(relativePath))));
  const {
    automaticRefreshUnavailable,
    cancelReloadNotice,
    file: queriedFile,
    handleSaveConfirmed,
    handleSaveFailure,
    handleSaveResolutionApplied,
    reloadNotice,
    requestManualReload,
    requestOverwrite,
    requestRetrySave,
    resolveReloadNotice,
    saveError,
    saveResolution,
    saveRetryReady,
    viewerRefreshKey,
  } = useWorkspaceFileRefresh({
    environmentId,
    cwd,
    relativePath,
    // Read every workspace path so a chat link to a directory can be
    // distinguished from a media or PDF file before choosing a preview.
    loadAsText: attachment === undefined,
    sourcePending: effectiveSourcePending,
    surfaceOwnsConflictDetection: usesDocumentSession,
    workspaceMutationId,
    // Host files outside the workspace are watched too: they stay read-only,
    // but an agent or another app can still change them while they are open.
    watchChanges: attachment === undefined && !quietMarkdownPaths.has(relativePath ?? ""),
  });
  const sessionWatch = useSessionFileWatch(
    environmentId,
    cwd,
    relativePath,
    relativePath !== null && quietMarkdownPaths.has(relativePath),
  );
  const isDirectory = queriedFile.isNotFile && !isHostFile;
  const previewPath = isDirectory ? null : relativePath;
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [pdfExplorerOpen, setPdfExplorerOpen] = useState(false);
  const effectiveExplorerOpen = isDirectory || (isPdf ? pdfExplorerOpen : explorerOpen);
  const showExplorer = shouldShowFileExplorer({
    relativePath: previewPath,
    explorerOpen: effectiveExplorerOpen,
    attachmentOpen: attachment !== undefined,
  });
  // Reading markdown rendered is a preference, not a property of one file. Keeping
  // it on the panel meant a thread switch dropped it and forced source back.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    SCIENT_DEFAULT_RENDER_MARKDOWN,
    Schema.Boolean,
  );
  const [renderBrowserFilePreferred, setRenderBrowserFilePreferred] = useLocalStorage(
    RENDER_BROWSER_FILE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [renderTablePreferred, setRenderTablePreferred] = useLocalStorage(
    RENDER_TABLE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // Paired with the path on purpose: each file surface counts its reveals from
  // one, so a bare id would let a dismissed reveal on one file swallow the first
  // reveal on the next.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const computeSourceLanguage =
    previewPath === null ? null : computeSourceLanguageForPath(previewPath);
  const computeContextId =
    previewPath === null || computeSourceLanguage === null
      ? null
      : computeFileContextId({
          environmentId,
          threadId: threadRef.threadId,
          cwd,
          relativePath: previewPath,
        });
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const [dismissedCitationReveal, setDismissedCitationReveal] = useState<number | null>(null);
  const citationRevealActive =
    fileCitation !== undefined && dismissedCitationReveal !== revealRequestId;
  const renderMarkdown =
    isMarkdownDocument &&
    resolveMarkdownRenderedState(renderMarkdownPreferred, citationRevealActive, revealHandled);
  const requestedHtmlMode =
    htmlPresentationRequest?.id === revealRequestId ? htmlPresentationRequest.mode : null;
  const renderBrowserFile =
    isHtml &&
    resolveHtmlRenderedState(renderBrowserFilePreferred, requestedHtmlMode) &&
    revealHandled;
  const rendered = isMarkdownDocument ? renderMarkdown : isHtml ? renderBrowserFile : false;
  const tableDelimiter =
    previewPath && attachment === undefined ? filePreviewDelimiter({ name: previewPath }) : null;
  const renderTable = tableDelimiter !== null && renderTablePreferred && revealHandled;
  const renderedMode = isMarkdownDocument
    ? ("markdown" as const)
    : tableDelimiter
      ? ("table" as const)
      : isHtml
        ? ("html" as const)
        : null;
  const canToggleRenderedForSurface =
    previewPath !== null && attachment === undefined && renderedMode !== null;
  const surfaceRendered = tableDelimiter ? renderTable : rendered;
  // A denied read is explained in terms of the computer that holds the file.
  const hostOs =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.platform.os ?? null;
  const {
    lease: markdownLease,
    snapshot: markdownSnapshot,
    admissionError,
    retryAdmission,
  } = useMarkdownPersistenceLease({
    target:
      usesDocumentSession && relativePath !== null ? { environmentId, cwd, relativePath } : null,
    authoritativeSnapshot: queriedFile.authoritativeData,
    workspaceMutationId,
  });
  // SCIENT-FORK:START — a document session's draft is the displayed file
  const { markdownRefreshFailure, markdownRefreshCopy, file } = scientDocumentSessionFile(
    queriedFile,
    markdownSnapshot,
    relativePath,
    hostOs,
  );
  // SCIENT-FORK:END
  // Rendered documents and media own their layout. Word wrap only applies to
  // the raw text surfaces that feed the Pierre file renderer/editor.
  const showsRawText =
    previewPath !== null &&
    file.data !== null &&
    !(isMarkdownDocument && renderMarkdown) &&
    !(tableDelimiter && renderTable) &&
    !renderBrowserFile &&
    !isMedia &&
    !isPdf;
  const awaitingMarkdownLease =
    usesDocumentSession &&
    markdownLease === null &&
    queriedFile.authoritativeData !== null &&
    !queriedFile.authoritativeData.truncated &&
    !queriedFile.authoritativeData.readOnly;
  const usesScientMarkdownEditor =
    relativePath !== null &&
    markdownLease !== null &&
    file.data !== null &&
    shouldUseScientMarkdownEditor({
      path: relativePath,
      readOnly: false,
      renderMarkdown,
      truncated: false,
    });
  const applyMarkdownViewChange = useCallback(
    (pressed: boolean) => {
      const next = markdownViewTransition(pressed, relativePath, revealRequestId);
      setDismissedCitationReveal(next.dismissedCitationReveal);
      setRenderMarkdownPreferred(next.preferred);
      setHandledReveal(next.handledReveal);
    },
    [relativePath, revealRequestId, setRenderMarkdownPreferred],
  );
  const handleRenderMarkdownChange = useCallback(
    (pressed: boolean) => {
      const apply = () => applyMarkdownViewChange(pressed);
      if (relativePath === null) {
        apply();
        return;
      }
      runAfterPendingSave([relativePath], apply);
    },
    [relativePath, runAfterPendingSave, applyMarkdownViewChange],
  );
  const handleRenderedChange = useCallback(
    (pressed: boolean) => {
      if (isMarkdownDocument) {
        handleRenderMarkdownChange(pressed);
        return;
      }
      if (tableDelimiter !== null) {
        setRenderTablePreferred(pressed);
        setHandledReveal(
          pressed && relativePath !== null
            ? { path: relativePath, requestId: revealRequestId }
            : null,
        );
        return;
      }
      if (!isHtml) return;
      if (relativePath !== null && htmlPresentationRequest !== null) {
        onHtmlPresentationRequestHandled(relativePath, htmlPresentationRequest);
      }
      setRenderBrowserFilePreferred(pressed);
      setHandledReveal(
        pressed && relativePath !== null
          ? { path: relativePath, requestId: revealRequestId }
          : null,
      );
    },
    [
      handleRenderMarkdownChange,
      htmlPresentationRequest,
      isHtml,
      isMarkdownDocument,
      onHtmlPresentationRequestHandled,
      relativePath,
      revealRequestId,
      setRenderBrowserFilePreferred,
      setRenderTablePreferred,
      tableDelimiter,
    ],
  );
  const canOpenInBrowser =
    canOperatePreview &&
    previewPath !== null &&
    attachment === undefined &&
    !isVideo &&
    previewAvailable &&
    isBrowserPreviewFile(previewPath);
  const absolutePath =
    relativePath && attachment === undefined ? workspaceFileHostPath(relativePath, cwd) : null;
  // SCIENT-FORK:START — missing-file choices, read failure and save a copy
  const { missingFile, canSaveCopy, handleSaveCopy, readFailure, blockingReadFailure } =
    useScientFileReadRecovery({
      environmentId,
      cwd,
      relativePath,
      attachment,
      isHostFile,
      isDirectory,
      absolutePath,
      environmentHttpBaseUrl,
      file,
      markdownRefreshFailure,
      hostOs,
      requestManualReload,
      onOpenFile,
    });
  // Any workspace file can be renamed from its name in the header. A file the
  // editor holds is renamed only at the revision it last read; a file the app
  // cannot read whole (media, PDF, other binary, or truncated) has no such
  // revision and is renamed as it is.
  const [latexRename, setLatexRename] = useState<LatexRenameContext | null>(null);
  const canRenameFile =
    relativePath !== null &&
    !isHostFile &&
    !isDirectory &&
    canWriteFiles &&
    file.data?.readOnly !== true &&
    file.data?.outsideWorkspace !== true;
  const renameRevision =
    file.data && !file.data.truncated
      ? (markdownSnapshot?.baselineRevision ?? file.data.revision)
      : null;
  const [renamingInPlace, setRenamingInPlace] = useState(false);
  const renamePendingRef = useRef(effectiveSourcePending);
  renamePendingRef.current = effectiveSourcePending;
  // A document session holds its own barrier; a file saved by this panel is
  // held here: nothing pending when the rename starts, no edits until it ends.
  const holdPanelFileForRename = () => {
    if (renamePendingRef.current) return null;
    setRenamingInPlace(true);
    return () => setRenamingInPlace(false);
  };
  const renameDisabled =
    effectiveSourcePending ||
    (latexRename?.blocked ?? false) ||
    (file.data === null && file.failure !== "binary_file");
  // A document started from the Documents menu: its template row, then its one rename.
  const newDocument = useNewDocument({
    environmentId,
    cwd,
    relativePath,
    lease: markdownLease,
    snapshot: markdownSnapshot ?? null,
    renameDisabled,
    onRenamed: (destinationRelativePath) => {
      if (relativePath === null) return;
      applyScientFileRename({
        environmentId,
        cwd,
        relativePath,
        usesDocumentSession,
        destinationRelativePath,
        onFileRenamed,
      });
    },
  });
  // A LaTeX document's own exports, published by its surface.
  const [latexDownloads, setLatexDownloads] = useState<DocumentDownloadActions | null>(null);
  // SCIENT-FORK:END
  const pdfSource = useMemo(
    () =>
      workspacePdfSourceForPreview({
        absolutePath,
        environmentId,
        relativePath,
        threadId: threadRef.threadId,
        workspaceRoot: cwd,
      }),
    [absolutePath, cwd, environmentId, relativePath, threadRef.threadId],
  );
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  const handlePendingChange = useCallback(
    (path: string, pending: boolean) => {
      setPendingPaths((current) => {
        const next = new Set(current);
        if (pending) next.add(path);
        else next.delete(path);
        return next;
      });
      onPendingChange(path, pending);
    },
    [onPendingChange],
  );
  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    if (isPdf) {
      setPdfExplorerOpen((current) => !current);
      return;
    }
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (
      !canReadFiles ||
      !canOperatePreview ||
      !absolutePath ||
      !relativePath ||
      !environmentHttpBaseUrl
    )
      return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        workspaceRoot: cwd,
        relativePath,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [
    absolutePath,
    canReadFiles,
    canOperatePreview,
    createAssetUrl,
    cwd,
    environmentHttpBaseUrl,
    openPreview,
    relativePath,
    threadRef,
  ]);

  const freshnessNoticeProps = {
    relativePath,
    notice: reloadNotice,
    readError: isDirectory ? null : file.error,
    readFailureReason: file.failureReason,
    missingFileChoices: missingFile.paths,
    onOpenFile,
    saveError,
    saveRetryReady,
    hasFallbackData: file.data !== null,
    reloading: file.isPending,
    onCancel: cancelReloadNotice,
    onReload: requestManualReload,
    onRequestOverwrite: requestOverwrite,
    onRetrySave: requestRetrySave,
    onResolve: resolveReloadNotice,
  };
  if (attachment === undefined && !canReadFiles) {
    if (fileAccess.isPending) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking file access...
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {fileAccess.error ?? "This connection cannot read host files."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath && attachment === undefined ? (
        <div
          className={cn(
            FILE_SURFACE_SUBHEADER_CLASS,
            usesScientMarkdownEditor && "in-data-[preview-panel-mode=inline]:mb-2",
          )}
          data-surface-subheader
        >
          <ScrollArea
            radius="none"
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1"
            data-file-breadcrumbs
          >
            {isHostFile ? (
              <div className="flex h-full w-max min-w-full items-center scient-reading-ui text-xs">
                <FileBreadcrumbs
                  cwd={cwd}
                  environmentId={environmentId}
                  onOpenFile={onOpenFile}
                  projectName={projectName}
                  relativePath={relativePath}
                  workspaceMutationId={workspaceMutationId}
                />
              </div>
            ) : (
              <FileBreadcrumbNavigator
                environmentId={environmentId}
                cwd={cwd}
                projectName={projectName}
                relativePath={relativePath}
                onOpenFile={onOpenFile}
                currentFileControl={
                  canRenameFile ? (
                    <FileRenameButton
                      beforeRename={
                        markdownLease ? () => markdownLease.holdForRename() : holdPanelFileForRename
                      }
                      {...(isRichMarkdown
                        ? {
                            normalize: normalizeMarkdownCreatePath,
                            invalidMessage: "Enter a relative Markdown path inside this workspace.",
                          }
                        : {})}
                      {...(latexRename?.includedBy
                        ? {
                            notice: (
                              <>
                                {latexRename.includedBy} includes this file. After renaming, update
                                the line that includes it.
                              </>
                            ),
                          }
                        : {})}
                      environmentId={environmentId}
                      cwd={cwd}
                      relativePath={relativePath}
                      revision={renameRevision}
                      disabled={renameDisabled}
                      label={relativePath.slice(relativePath.lastIndexOf("/") + 1)}
                      onRenamed={(destinationRelativePath) =>
                        applyScientFileRename({
                          environmentId,
                          cwd,
                          relativePath,
                          usesDocumentSession,
                          destinationRelativePath,
                          onFileRenamed,
                        })
                      }
                    />
                  ) : undefined
                }
              />
            )}
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
            />
          ) : null}
          {/* Word wrap comes before the view toggle, so the toggle keeps its place
              when it switches to the source and back. */}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : canToggleRenderedForSurface ? (
            // The rich view has no word wrap; its place stays, so Open in and
            // the buttons after it do not move when the view changes.
            <span aria-hidden="true" className="h-8 w-8 shrink-0 sm:h-7 sm:w-7" />
          ) : null}
          {canToggleRenderedForSurface ? (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode!, surfaceRendered)}
              pressed={surfaceRendered}
              onPress={() => handleRenderedChange(!surfaceRendered)}
            >
              <MorphIcon
                className="size-3.5"
                icon={surfaceRendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
              />
            </FileSurfaceAction>
          ) : null}
          {canOpenInBrowser ? (
            <FileSurfaceAction label="Open file in preview browser" onPress={handleOpenInBrowser}>
              <Globe className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {relativePath && isLatexPreviewFile(relativePath) ? (
            <ScientFileFreshnessStatus
              {...freshnessNoticeProps}
              pending={effectiveSourcePending}
              sessionAttention={
                // The same three cases the session's own notice tells apart.
                markdownSnapshot?.conflict
                  ? "conflict"
                  : markdownSnapshot?.error
                    ? markdownSnapshot.pending
                      ? "failure"
                      : "refresh"
                    : null
              }
            />
          ) : null}
          {canSaveCopy && isRichMarkdown && markdownLease && relativePath ? (
            // A Markdown file downloads as itself, or as a PDF or Word document.
            <MarkdownDownloadMenu
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              threadRef={threadRef}
              persistence={markdownLease}
              onSaveCopy={handleSaveCopy}
            />
          ) : canSaveCopy && latexDownloads ? (
            <DocumentDownloadMenu
              {...latexDownloads}
              sourceLabel="LaTeX source (.tex)"
              onSaveCopy={handleSaveCopy}
            />
          ) : canSaveCopy ? (
            <FileSurfaceAction label="Save a copy to this device" onPress={handleSaveCopy}>
              <Download className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {attachment === undefined && previewPath !== null ? (
            <ScientFileReloadButton
              automaticRefreshUnavailable={automaticRefreshUnavailable || sessionWatch.unavailable}
              isPending={markdownSnapshot?.reading ?? file.isPending}
              onReload={
                markdownLease
                  ? () => {
                      sessionWatch.refresh();
                      void markdownLease.refresh();
                    }
                  : admissionError
                    ? retryAdmission
                    : requestManualReload
              }
            />
          ) : null}
          {!isHostFile && previewPath !== null ? (
            <FileSurfaceAction
              label={effectiveExplorerOpen ? "Hide file explorer" : "Show file explorer"}
              pressed={effectiveExplorerOpen}
              onPress={toggleExplorer}
            >
              <FolderTree className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}
      {markdownLease ? (
        <ScientMarkdownPersistenceNotice
          key={relativePath}
          persistence={markdownLease}
          {...(!renderMarkdown ? { onReturnToRich: () => applyMarkdownViewChange(true) } : {})}
          {...(markdownRefreshCopy ? { refreshCopy: markdownRefreshCopy } : {})}
          {...(markdownRefreshFailure?.reason === "not_found"
            ? { missingFileChoices: missingFile.paths, onOpenFile }
            : {})}
        />
      ) : attachment === undefined && relativePath && isLatexPreviewFile(relativePath) ? null : (
        <ScientFileFreshnessNotices {...freshnessNoticeProps} />
      )}
      {relativePath && !attachment && !isHostFile && !canWriteFiles && !fileAccess.isPending ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          Read-only connection. Unsaved edits are kept until write access returns.
        </div>
      ) : null}
      {relativePath && !markdownLease && !isPdf && file.data?.readOnly ? (
        <div className="shrink-0 border-b border-border/50 bg-muted/35 px-3 py-1.5 scient-reading-micro text-muted-foreground">
          {readOnlyNotice(file.data.outsideWorkspace === true)}
        </div>
      ) : null}
      {previewPath &&
      attachment === undefined &&
      !markdownLease &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 scient-reading-micro text-warning-foreground">
          Read-only preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()}{" "}
          byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn("min-w-0 flex-1 flex-col overflow-hidden", previewPath ? "flex" : "hidden")}
          // While a file this panel saves is being renamed, it takes no edits:
          // a save started now would go to the name that is going away.
          inert={renamingInPlace || undefined}
        >
          {isDirectory ? null : relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
              htmlRender={attachment.htmlRender === true}
            />
          ) : // SCIENT-FORK:START — the read failure says why nothing can be shown
          relativePath && blockingReadFailure ? (
            blockingReadFailure // SCIENT-FORK:END
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              name={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              workspaceRoot={cwd}
              relativePath={relativePath}
              absolutePath={absolutePath}
              alt={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isPdf && absolutePath && pdfSource ? (
            <ScientSurfaceSuspense>
              <ScientPdfReader
                key={absolutePath}
                source={pdfSource}
                readerScope={threadRef.threadId}
                refreshKey={viewerRefreshKey}
              />
            </ScientSurfaceSuspense>
          ) : relativePath && renderBrowserFile && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              title={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : awaitingMarkdownLease && admissionError ? (
            // SCIENT-FORK:START — document session could not be admitted
            <ScientDocumentSessionAdmissionFailure
              admissionError={admissionError}
              onRetry={retryAdmission}
              cwd={cwd}
              relativePath={relativePath}
              contents={file.data?.contents}
              resolvedTheme={resolvedTheme}
              wordWrap={wordWrap}
              onPostRender={onFilePostRender}
            />
          ) : // SCIENT-FORK:END
          awaitingMarkdownLease ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
              aria-label="Opening editor"
            />
          ) : relativePath && file.error && file.data === null ? (
            readFailure
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner size="lg" />
            </div>
          ) : relativePath && file.data ? (
            file.data.readOnly || !canWriteFiles ? (
              tableDelimiter && renderTable ? (
                <DelimitedTablePreview
                  key={relativePath}
                  name={relativePath}
                  text={file.data.contents}
                  delimiter={tableDelimiter}
                />
              ) : isMarkdownDocument && renderMarkdown ? (
                <RenderedMarkdownSurface
                  key={relativePath}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  threadRef={threadRef}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  truncated={file.data.truncated}
                  readOnly
                  onPendingChange={handlePendingChange}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                />
              ) : (
                // SCIENT-FORK:START
                <StaticTextFileSurface
                  key={`${relativePath}:${resolvedTheme}:${file.data.revision}`}
                  cwd={cwd}
                  relativePath={relativePath}
                  contents={file.data.contents}
                  resolvedTheme={resolvedTheme}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                />
                // SCIENT-FORK:END
              )
            ) : isLatexPreviewFile(relativePath) ? (
              <ScientSurfaceSuspense>
                <ScientLatexSurface
                  key={`${relativePath}:${resolvedTheme}`}
                  onDownloadActions={setLatexDownloads}
                  onRenameContext={setLatexRename}
                  startBar={newDocument.startBar}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  latexRootRelativePath={latexRootRelativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  truncated={file.data.truncated}
                  // Without a session the file is read-only or too large to edit completely.
                  persistence={markdownLease}
                  resolvedTheme={resolvedTheme}
                  revealLine={revealLine}
                  revealRequestId={revealRequestId}
                  latexPresentationRequest={latexPresentationRequest}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onOpenFileSource={onOpenFileSource}
                  onLatexPresentationRequestHandled={onLatexPresentationRequestHandled}
                />
              </ScientSurfaceSuspense>
            ) : computeSourceLanguage !== null && !file.data.truncated ? (
              <ScientSurfaceSuspense>
                <ScientComputeFileSurface
                  key={`${computeContextId}:${resolvedTheme}`}
                  language={computeSourceLanguage}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  contextId={computeContextId!}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  sourcePending={
                    effectiveSourcePending ||
                    (file.authoritativeData !== null &&
                      file.data.contents !== file.authoritativeData.contents)
                  }
                  onPostRender={onFilePostRender}
                  onPendingChange={handlePendingChange}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                />
              </ScientSurfaceSuspense>
            ) : usesScientMarkdownEditor && markdownLease ? (
              <ScientSurfaceSuspense>
                {/* A new document's file name, drawn on its page. */}
                {newDocument.startBar}
                <ScientMarkdownFileSurface
                  key={relativePath}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  threadRef={threadRef}
                  persistence={markdownLease}
                  {...(onCiteFile ? { onCite: onCiteFile } : {})}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  citationRevealId={revealRequestId}
                  resolvedTheme={resolvedTheme}
                  onOpenFile={onOpenFile}
                  onOpenFileSource={(path, line) =>
                    runAfterPendingSave([relativePath], () => onOpenFileSource(path, line))
                  }
                />
              </ScientSurfaceSuspense>
            ) : markdownLease ? (
              <MarkdownSourceSurface
                key={relativePath}
                persistence={markdownLease}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : isMarkdownDocument && renderMarkdown ? (
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                revision={file.data.revision}
                truncated={file.data.truncated}
                readOnly={isHostFile || !canWriteFiles}
                onPendingChange={handlePendingChange}
                onSaveFailure={handleSaveFailure}
                onSaveConfirmed={handleSaveConfirmed}
                onSaveResolutionApplied={handleSaveResolutionApplied}
                saveResolution={saveResolution}
              />
            ) : tableDelimiter && renderTable ? (
              <DelimitedTablePreview
                key={relativePath}
                name={relativePath}
                text={file.data.contents}
                delimiter={tableDelimiter}
              />
            ) : file.data.truncated ? (
              // SCIENT-FORK:START
              <StaticTextFileSurface
                key={`${relativePath}:${resolvedTheme}:${file.data.revision}`}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : // SCIENT-FORK:END
            isHostFile || !canWriteFiles ? (
              <SourceFilePreview
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
                onPostRender={onFilePostRender}
              />
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                contents={file.data.contents}
                revision={file.data.revision}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
                onPendingChange={handlePendingChange}
                onSaveFailure={handleSaveFailure}
                onSaveConfirmed={handleSaveConfirmed}
                onSaveResolutionApplied={handleSaveResolutionApplied}
                saveResolution={saveResolution}
              />
            )
          ) : null}
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              previewPath
                ? "w-[min(20rem,40%)] min-w-40 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              onOpenFile={onOpenFile}
              onOpenFileSource={onOpenFileSource}
              workspaceMutationId={workspaceMutationId}
              {...(previewPath && !isMedia && !isPdf
                ? { onRefreshSelectedFile: file.refresh }
                : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
