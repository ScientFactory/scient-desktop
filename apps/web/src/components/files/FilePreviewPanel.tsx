import { useStableCallback } from "~/hooks/useStableCallback";
import { useLayoutEffect } from "react";
import type { EditorSelection } from "@pierre/diffs/edit";
import { revealFileEditorSelection, type SourceSelectionReveal } from "./fileEditorSourceReveal";
import {
  SourceCitationActions,
  type SourceCaretQuote,
} from "~/scient/fileSurfaces/SourceCitationActions";
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
  scientViewerResource,
} from "~/scient/fileSurfaces/scientWorkspaceViewerRefresh";
import {
  ScientMathSourceToolbar,
  minimalSourceEdit,
  moveEditorToSource,
  scientEditorGutterUtility,
  useScientFileLineRange,
  scientFileEditorUnsafeCss,
  useScientFileEditorBindings,
} from "~/scient/fileSurfaces/scientFileEditorBindings";
import {
  applyScientFileRename,
  ScientDocumentSessionAdmissionFailure,
  scientDocumentSessionFile,
} from "~/scient/fileSurfaces/scientDocumentSession";
import {
  isScientNotebookFile,
  ScientComputeFileSurface,
  ScientDataFileTable,
  ScientLatexSurface,
  ScientNotebookSurface,
  ScientPdfReader,
  ScientSurfaceSuspense,
} from "~/scient/fileSurfaces/scientLazyFileSurfaces";
import { useScientFileReadRecovery } from "~/scient/fileSurfaces/scientFileReadRecovery";
import { isScientDataFile } from "~/scient/dataTable/dataFiles";
import { useSavedDataViewPreview } from "~/scient/dataTable/useSavedDataViewPreview";
// SCIENT-FORK:END
// SCIENT-FORK:START — the server's editor flush names a file whose input method is composing.
import { editorCompositions } from "~/scient/editorFlush/editorComposition";
// SCIENT-FORK:END
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { CopyIcon, CheckIcon, Code2Icon, EyeIcon, Table2Icon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Spinner } from "~/components/ui/spinner";
import { LatexDocumentPreparation } from "~/scient/latex/latexOpeningPresentation";
import { Button } from "~/components/ui/button";
import {
  AuthPreviewOperateScope,
  type AssetResource,
  type EditorId,
  type EnvironmentId,
  type ProjectFilePublicationAttention,
  type ProjectId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import {
  VirtualizedFile,
  type FileContents,
  type GetHoveredLineResult,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceFontPreviewPath,
  isWorkspaceVideoPreviewPath,
  officePreviewKind,
  binaryPreviewKind,
} from "@t3tools/shared/filePreview";
import { useAtomValue } from "@effect/atom-react";
import {
  Editor,
  type EditorChangeEvent,
  type EditorFactory,
  type EditorOptions,
} from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useEditableAfterHighlight } from "./useEditableAfterHighlight";
import { useFilesystemReadAccess } from "~/state/filesystem";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
// SCIENT-FORK:START — FolderTree moved to the tab strip's Files button
import { AlertTriangle, Download, Globe, WrapTextIcon } from "lucide-react";
// SCIENT-FORK:END
import { MarkdownDownloadMenu } from "~/scient/documentExport/MarkdownDownloadMenu";
import {
  DocumentDownloadMenu,
  type DocumentDownloadActions,
} from "~/scient/documentExport/DocumentDownloadMenu";
import * as Schema from "effect/Schema";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import type { FileCitation } from "@t3tools/contracts";
import type { MarkdownCiteHandler } from "~/scient/markdownEditor/markdownCitation";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { fileManagerActionForPath } from "~/components/chat/OpenInPicker.logic";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
// SCIENT-FORK:START — the file list's state moved to usePanelFilesOpen
import { useLocalStorage } from "~/hooks/useLocalStorage";
// SCIENT-FORK:END
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, isMacPlatform } from "~/lib/utils";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import type {
  HtmlFilePresentationRequest,
  LatexFilePresentationRequest,
  OpenFileOptions,
} from "~/rightPanelStore";
import {
  breadcrumbPathOf,
  retainedBreadcrumbTrail,
  trailChildOf,
  workspaceFileHostPath,
} from "./filePath";
import type { ChatFileAttachment } from "~/types";
import { isHostPath } from "@t3tools/shared/path";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
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
  // SCIENT-FORK:START — usePanelFilesOpen resolves the file list's default
  // SCIENT-FORK:END
} from "~/scient/fileOpening/fileOpeningPolicy";
// SCIENT-FORK:START
import { usePanelFilesOpen } from "~/scient/rightPanel/PanelFilesColumn";
import { OfficeFileContext } from "~/scient/office/officeQuote"; // SCIENT-FORK
import { TabHistoryButtons } from "~/scient/rightPanel/tabHistory";
// SCIENT-FORK:END
import { scientificSourceLanguageOverride } from "~/scient/presentation/sourceLanguage";
import { computeSourceLanguageForPath } from "~/scient/compute/computeSourceLanguage";
import { computeFileContextId } from "~/scient/compute/computeContextStore";
import { useComputeFilePresentationStore } from "~/scient/compute/computeFilePresentationStore";
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
import {
  documentIdentity,
  documentSessionIsCurrent,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { workspacePdfSourceForPreview } from "~/scient/pdf/pdfSource";
import {
  ScientFileFreshnessNotices,
  ScientFileFreshnessStatus,
  ScientFileReloadButton,
} from "~/scient/fileSurfaces/ScientFileFreshnessControls";
import { ScientFileRevisionBoundary } from "~/scient/fileSurfaces/ScientFileRevisionBoundary"; // SCIENT-FORK
import {
  ScientDocumentShelf,
  ShelfItem,
  useChangesWhileShown,
} from "~/scient/documentShelf/ScientDocumentShelf"; // SCIENT-FORK
import { ScientFileVersionHistory } from "~/scient/fileSurfaces/ScientFileVersionHistory";
// SCIENT-FORK:START — Overleaf sync state beside "Saved"
import { OverleafFileChip } from "~/scient/overleaf/OverleafFileChip";
import { OverleafConflictActions } from "~/scient/overleaf/OverleafConflictActions";
// SCIENT-FORK:END
// SCIENT-FORK:START — an audio or video file's Transcribe, or its transcript
import { TranscribeFileAction } from "~/scient/recordings/useTranscribeFile";
// SCIENT-FORK:END
import {
  type FileSaveResolution,
  useSessionFileWatch,
  useWorkspaceFileRefresh,
} from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { usePendingSurfaceDeparture } from "~/scient/fileSurfaces/usePendingSurfaceDeparture";
import { mediaFailureCopy, readOnlyNotice } from "~/scient/fileSurfaces/fileFailureCopy";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import { PreviewImage } from "./PreviewImage";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileExplorerPane } from "./FileExplorerPane";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { ChunkedMarkdown } from "./ChunkedMarkdown";
// SCIENT-FORK:START — a file with footnotes renders whole so they resolve
import { splitScientFileMarkdown } from "~/scient/markdown/scientMarkdownPieces";
// SCIENT-FORK:END
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
  promptFileCommentEntries,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import {
  FILE_LINK_REVEAL_ATTRIBUTE,
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";
import LargeFilePreview from "./LargeFilePreview";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";
import { resolveCenteredFileLineScrollTop, resolveFileRevealLine } from "./fileLineReveal";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { projectFileCacheKey } from "./fileContentRevision";
import { FileBreadcrumbNavigator } from "./FileBreadcrumbNavigator";
import {
  isLatexPreviewFile,
  keepsBoundedSourceView,
  isMarkdownPreviewFile,
  resolveMarkdownTaskPreviewUpdate,
  resolveFilePreviewPath,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import { useInPlaceRename } from "~/scient/fileSurfaces/useInPlaceRename";
import {
  newDocuments,
  pathHasLeftoverDrafts,
  templateEdits,
} from "~/scient/documents/newDocuments";
import { setProjectFileQueryData } from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  // SCIENT-FORK:START — the tab this view fills, for its Back and Forward history
  scientSurfaceId?: string | undefined;
  // SCIENT-FORK:END
  onCiteFile?: MarkdownCiteHandler;
  fileCitation?: FileCitation | undefined;
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  projectId?: ProjectId | undefined;
  relativePath: string | null;
  attachment?: ChatFileAttachment;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInShortcutEnabled: boolean;
  revealLine: number | null;
  revealRequestId: number;
  htmlPresentationRequest: HtmlFilePresentationRequest | null;
  latexPresentationRequest: LatexFilePresentationRequest | null;
  latexRootRelativePath: string | null;
  latexSourceReveal?: { readonly id: number; readonly revision: string } | undefined;
  onOpenFile: (relativePath: string) => void;
  /** The open file was renamed: its tab follows it to the new path, keeping its state. */
  onFileMoved: (fromPath: string, toPath: string) => void;
  /** Ordinary renames reopen the file at its new path. */
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

  onNavigateFolder: (relativePath: string, folderTrail: string, keepSource: boolean) => void;
  /** Retained descendant breadcrumb path after navigating up; see navigateFolder. */
  folderTrail: string | undefined;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const MermaidFilePreview = lazy(() =>
  import("./MermaidFilePreview").then((module) => ({ default: module.MermaidFilePreview })),
);

// SCIENT-FORK:START — the file list's storage key lives with usePanelFilesOpen
// SCIENT-FORK:END
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "t3code.renderTable";

function workspaceViewerAssetResource(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly draft: boolean;
    readonly absolutePath: string;
    readonly workspaceRoot: string;
    readonly relativePath: string;
  },
  kind: "workspace-file" | "media-file",
  htmlDocument?: boolean,
) {
  const threadResource = scientViewerResource(input, htmlDocument);
  return input.draft
    ? workspaceAssetResource({
        kind,
        threadRef: input.threadRef,
        draft: true,
        workspaceRoot: input.workspaceRoot,
        absolutePath: input.absolutePath,
      })
    : threadResource;
}
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
  readonly draft: boolean;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly alt: string;
  readonly refreshKey: number;
}) {
  // SCIENT-FORK:START — persisted threads use the rooted tab-path locator; drafts use the upstream draft resource.
  const resource = workspaceViewerAssetResource(props, "workspace-file");
  const messages = useMessages();
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
            // SCIENT-FORK: failure copy in the active language.
            {...mediaFailureCopy("image", messages)}
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
    <MediaActions source={actionsSource}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PreviewImage
          key={imageUrl}
          src={imageUrl}
          name={props.alt}
          onError={() => setFailedUrl(imageUrl)}
        />
      </div>
    </MediaActions>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner size="lg" />
    </div>
  );
}

interface HtmlPreviewFrame {
  readonly revision: string | null;
  readonly url: string;
  /** When the loaded page's grant is about to expire and a fresh URL has to replace it. */
  readonly renewAt: number;
}

const HTML_PREVIEW_RENEW_BEFORE_EXPIRY_MS = 2 * 60_000;
// Grants last an hour. A client clock far from the server's would otherwise renew at once, forever.
const HTML_PREVIEW_MIN_GRANT_HOLD_MS = 3 * 60_000;
const HTML_PREVIEW_MAX_GRANT_HOLD_MS = 60 * 60_000;

const htmlPreviewFrame = (
  minted: { readonly revision: string | null; readonly url: string; readonly expiresAt: number },
  now: number,
): HtmlPreviewFrame => ({
  revision: minted.revision,
  url: minted.url,
  renewAt: Math.min(
    Math.max(
      minted.expiresAt - HTML_PREVIEW_RENEW_BEFORE_EXPIRY_MS,
      now + HTML_PREVIEW_MIN_GRANT_HOLD_MS,
    ),
    now + HTML_PREVIEW_MAX_GRANT_HOLD_MS,
  ),
});

/** Opaque-origin HTML cannot reach app storage; adjacent assets may be outside the workspace. */
export function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly title: string;
  readonly workspaceMutationId: string | null;
  readonly refreshKey: number;
  // SCIENT-FORK: Reload file always reloads the page.
  readonly manualReloadKey: number;
}) {
  // SCIENT-FORK:START — preserve rooted file and HTML document semantics for persisted threads.
  const resource = workspaceViewerAssetResource(props, "workspace-file", true);
  const messages = useMessages();
  // SCIENT-FORK:END
  // Each workspace mutation re-mints the URL: a file outside the workspace is signed by its
  // inode, which an atomic replace changes.
  // SCIENT-FORK:START — so does each change the file's watcher reports.
  const mintRevision = `${props.workspaceMutationId ?? ""}:${props.refreshKey}:${props.manualReloadKey}`;
  const assetUrl = useAssetUrlState(props.environmentId, resource, mintRevision);
  // SCIENT-FORK:END
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  // Servers that report the file's revision let an unchanged page stay loaded.
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  // SCIENT-FORK:START — Reload file always reloads the page. Without a server revision (a page
  // outside the workspace, an older server), Scient's refresh of the page decides, as before.
  const latestRevision =
    fileRevision === undefined
      ? `${props.refreshKey}:${props.manualReloadKey}`
      : `${fileRevision}:${props.manualReloadKey}`;
  // SCIENT-FORK:END
  // The HTML frame keeps the URL it loaded, so it moves only once a re-minted URL has arrived.
  const [frame, setFrame] = useState<HtmlPreviewFrame | null>(null);
  const [endingGrant, setEndingGrant] = useState<string | null>(null);
  const grantEnding = frame !== null && endingGrant === frame.url;
  if (
    assetUrl._tag === "Success" &&
    (frame === null ||
      (!assetUrl.waiting &&
        (frame.revision !== latestRevision || (grantEnding && frame.url !== assetUrl.url))))
  ) {
    const { url, expiresAt } = assetUrl;
    setFrame(() => htmlPreviewFrame({ revision: latestRevision, url, expiresAt }, Date.now()));
  }
  const renewGrant = useEffectEvent((url: string) => {
    setEndingGrant(url);
    // A command may have minted the next URL already; otherwise ask for it.
    if (assetUrl._tag === "Success" && assetUrl.url === url) {
      void refreshAssetUrl().catch(() => undefined);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mints a fresh URL shortly before the loaded page's grant expires
  useEffect(() => {
    if (frame === null) return;
    const timer = setTimeout(() => renewGrant(frame.url), frame.renewAt - Date.now());
    return () => clearTimeout(timer);
  }, [frame]);
  const revision = frame?.revision ?? latestRevision;
  const url = assetUrl._tag !== "Success" ? null : (frame?.url ?? assetUrl.url);
  const revisionSuffix =
    revision === null
      ? ""
      : `${url?.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;

  if (assetUrl._tag === "Failure") {
    return (
      <FileSurfaceFailure
        // SCIENT-FORK: failure copy in the active language.
        {...mediaFailureCopy("document", messages)}
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
  const documentId = `${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}`;
  return (
    <BrowserDocumentFrame
      src={`${url}${revisionSuffix}`}
      documentKey={`${documentId}:${revision}:${frame?.renewAt}`}
      documentId={documentId}
      title={props.title}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
  readonly refreshKey: number;
}) {
  const reference = mediaFileReference(props.absolutePath, props.workspaceRoot);
  // SCIENT-FORK:START — persisted threads use rooted locators; drafts use the upstream draft resource.
  const resource = workspaceViewerAssetResource(props, "media-file");
  // SCIENT-FORK:END
  // Each workspace mutation re-mints the URL, so an edited file loads its new bytes.
  const assetUrl = useAssetUrlState(
    props.environmentId,
    resource,
    props.workspaceMutationId ?? undefined,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  // SCIENT-FORK:START — native watcher changes refresh the media locator.
  useScientViewerRefreshKey(props.refreshKey, refreshAssetUrl);
  // SCIENT-FORK:END
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision =
    fileRevision ??
    // SCIENT-FORK:START — older servers omit native file revisions.
    (props.workspaceMutationId === null && props.refreshKey === 0
      ? null
      : `${props.workspaceMutationId ?? ""}:${props.refreshKey}`);
  // SCIENT-FORK:END
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={revision}
        preload="metadata"
        className="flex h-full min-h-0 w-full max-w-5xl items-center justify-center"
        videoClassName="aspect-auto max-h-full w-auto max-w-full"
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
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
  /** Advances when the file's native watcher reports a change. */
  readonly refreshKey: number;
}) {
  // SCIENT-FORK: failure copy in the active language.
  const messages = useMessages();
  const resource = workspaceAssetResource({
    kind: "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(
    props.environmentId,
    resource,
    props.workspaceMutationId ?? undefined,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // SCIENT-FORK:START — native watcher changes also clear a failed audio locator.
  useScientViewerRefreshKey(props.refreshKey, refreshAssetUrl, setFailedUrl);
  // SCIENT-FORK:END
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision =
    fileRevision ??
    // SCIENT-FORK:START — older servers omit native file revisions.
    (props.workspaceMutationId === null && props.refreshKey === 0
      ? null
      : `${props.workspaceMutationId ?? ""}:${props.refreshKey}`);
  // SCIENT-FORK:END
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;
  const url = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  if (assetUrl._tag === "Failure" || (url !== null && failedUrl === url)) {
    return (
      <FileSurfaceFailure
        // SCIENT-FORK: failure copy in the active language.
        {...mediaFailureCopy("audio", messages)}
        retrying={retrying}
        onRetry={() => {
          setFailedUrl(null);
          retryScientViewerAsset(refreshAssetUrl, setRetrying);
        }}
      />
    );
  }
  if (url === null) return <FileSurfaceLoading />;
  return (
    <AudioPreview
      src={url}
      name={props.name}
      revision={revision}
      onError={() => setFailedUrl(url)}
    />
  );
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

const REVEAL_MAX_ATTEMPTS = 30;
/** Hold the reveal target against late focus/restoration scroll resets. */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
  /** The path's code view offset when it last unmounted, restored when it is shown again. */
  scrollTop: number;
  scrollContainer: HTMLElement | null;
  restoreFrameId: number | null;
}

export function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
  citation?: FileCitation,
  markLine = true,
): { readonly onPostRender: FilePostRender; readonly move: (from: string, to: string) => void } {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());
  // SCIENT-FORK:START — an in-place rename carries a handled reveal along, never replays it
  const move = (from: string, to: string) => {
    const state = revealStatesByPath.get(from);
    if (state === undefined) return;
    revealStatesByPath.delete(from);
    revealStatesByPath.set(to, state);
  };
  // SCIENT-FORK:END
  const onPostRender: FilePostRender = (fileContainer, instance, phase) => {
    if (relativePath === null) return;

    const existingState = revealStatesByPath.get(relativePath);
    const state: FileRevealState = existingState ?? {
      frameId: null,
      cancelGuard: null,
      handledRequestId: null,
      latestRequestId: null,
      scrollTop: 0,
      scrollContainer: null,
      restoreFrameId: null,
    };
    if (!existingState) revealStatesByPath.set(relativePath, state);

    const cancelPendingReveal = () => {
      if (state.frameId !== null) {
        cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.cancelGuard?.();
      if (state.restoreFrameId !== null) {
        cancelAnimationFrame(state.restoreFrameId);
        state.restoreFrameId = null;
      }
    };

    const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");

    if (phase === "unmount") {
      // A view torn down before its restore ran never showed the saved offset, so keep it.
      const restorePending = state.restoreFrameId !== null;
      cancelPendingReveal();
      if (scrollContainer && !restorePending) state.scrollTop = scrollContainer.scrollTop;
      state.scrollContainer = null;
      return;
    }

    const contents = instance.file?.contents;
    const targetLine =
      contents === undefined ? null : resolveFileRevealLine(contents, revealLine, citation);
    updateFileLinkReveal(fileContainer, markLine ? targetLine : null);

    if (!(instance instanceof VirtualizedFile)) return;

    if (state.latestRequestId !== revealRequestId) {
      cancelPendingReveal();
      state.latestRequestId = revealRequestId;
      state.handledRequestId = null;
    }

    if (scrollContainer && state.scrollContainer !== scrollContainer) {
      state.scrollContainer = scrollContainer;
      const savedScrollTop = state.scrollTop;
      // A pending line reveal owns the scroll position.
      if (
        savedScrollTop > 0 &&
        // SCIENT-FORK: a citation's source selection is a pending reveal too.
        ((revealLine === null && !citation?.sourceSelection) ||
          state.handledRequestId === revealRequestId)
      ) {
        const restoreScroll = (attempt: number) => {
          state.restoreFrameId = requestAnimationFrame(() => {
            state.restoreFrameId = null;
            if (!scrollContainer.isConnected || scrollContainer.scrollTop !== 0) return;
            // Wait for the virtualizer to size the file so the offset is not clamped.
            const fits =
              scrollContainer.scrollHeight - scrollContainer.clientHeight >= savedScrollTop;
            if (fits || attempt >= REVEAL_MAX_ATTEMPTS) {
              scrollContainer.scrollTop = savedScrollTop;
              return;
            }
            restoreScroll(attempt + 1);
          });
        };
        restoreScroll(0);
      }
    }

    if (revealLine === null && !citation?.sourceSelection) {
      // SCIENT-FORK:START — a cleared reveal stops its own frames, not the scroll restore.
      if (state.frameId !== null) {
        cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.cancelGuard?.();
      // SCIENT-FORK:END
      fileContainer.style.minHeight = "";
      return;
    }

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
      // Capture gutter pointer events before Pierre stops propagation so comments can cancel the reveal
      // guard.
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

        // Wait for contents and metrics; missing data would clamp fresh-mount reveals to line 1 and mark them
        // handled.
        const currentContents = instance.file?.contents;
        const line =
          currentContents === undefined
            ? null
            : resolveFileRevealLine(currentContents, revealLine, citation);
        const targetTop = line === null ? null : resolveScrollTarget(line);
        if (line === null || targetTop === null) {
          if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
          return;
        }
        updateFileLinkReveal(fileContainer, markLine ? line : null);

        scrollContainer.scrollTop = targetTop;
        state.handledRequestId = revealRequestId;
        guardScrollTarget(line);
      });
    };

    scheduleReveal(0);
  };
  return { onPostRender, move };
}

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

const createFileEditor: EditorFactory<FileCommentAnnotationGroup, undefined> = (
  editorType,
  options,
  editStateKey,
) => new Editor(editorType, options, editStateKey);
type FileEditor = Editor<"file", FileCommentAnnotationGroup, undefined>;

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

interface EditableFileSurfaceProps {
  threadRef?: ScopedThreadRef | undefined;
  onCite?: MarkdownCiteHandler | undefined;
  citationReveal?: FileCitation | undefined;
  citationBaseline?: string | undefined;
  citationRootRelativePath?: string | undefined;
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  revision: string;
  publicationAttention?: ProjectFilePublicationAttention;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailure: (relativePath: string, error: unknown) => void;
  onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  onSaveResolutionApplied: () => void;
  saveResolution: FileSaveResolution | null;
  // SCIENT-FORK: optional, as Scient's other mounts of the editor (LaTeX, compute, Markdown source) pass none.
  onEditorChange?: ((editor: FileEditor | null) => void) | undefined;
  onSelectionChange?: (range: SelectedLineRange | null) => void;
  activeLineRange?: SelectedLineRange | null;
  // SCIENT-FORK:START — what a clicked caret stands for when asking in chat.
  caretQuote?: SourceCaretQuote | undefined;
  // SCIENT-FORK:END
  retainSelectionOnBlur?: boolean;
  sourceSelectionReveal?: SourceSelectionReveal | undefined;
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

export function EditableFileSurface(props: EditableFileSurfaceProps & { initialSource: string }) {
  const coordinator = useFileSaveCoordinator(props);
  const onContentsChange = (contents: string) => {
    setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, contents);
    coordinator.change(contents);
  };
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
  threadRef,
  onCite,
  citationReveal,
  citationBaseline,
  citationRootRelativePath,
  environmentId,
  projectId,
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
  // SCIENT-FORK:START — what a clicked caret stands for when asking in chat.
  caretQuote,
  // SCIENT-FORK:END
  retainSelectionOnBlur = false,
  sourceSelectionReveal,
  onEditorSelectionChange,
  renderEditorGutterAction,
  onRunShortcut,
  enableFileComments = true,
  gutterUtilityVisibility = "always",
  onEditorChange,
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
  const messages = useMessages();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const promptCommentIds = new Set(
    useComposerDraftStore(
      (store) =>
        store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
    ).map((comment) => comment.id),
  );
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const displayedRange = selectedRange ?? activeLineRange ?? null;
  // SCIENT-FORK:START — the line range is drawn in place, outside the editor's options.
  const drawLineRange = useScientFileLineRange(selectedRange, activeLineRange);
  // SCIENT-FORK:END
  const setSelectedRange = (range: SelectedLineRange | null) => {
    setSelectionOverride({ revealRequestId, range });
    onSelectionChange?.(range);
  };
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const attachSurface = useStableCallback((element: HTMLDivElement | null) => {
    surfaceRef.current = element;
    setSurface(element);
  });
  const selectionFrameRef = useRef<number | null>(null);
  const editorSelectionFrameRef = useRef<number | null>(null);
  const reportEditorSelectionRef = useRef<() => void>(() => undefined);
  const projectionAppliedRef = useRef(onProjectionApplied);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest projection callback for editor event handlers
  useLayoutEffect(() => {
    projectionAppliedRef.current = onProjectionApplied;
  });
  // SCIENT-FORK:START — Shared document lease gates retained native source history.
  const applyingExternal = useRef(false);
  const projectionReady = useRef(false);
  const [restorationBlocked, setRestorationBlocked] = useState(false);
  const externalBindings = useRef({ externalPersistence, onExternalVersionApplied });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest document bindings for editor event handlers
  useLayoutEffect(() => {
    externalBindings.current = { externalPersistence, onExternalVersionApplied };
  });
  // SCIENT-FORK:END
  const [externalFile, setExternalFile] = useState(() =>
    editableFileContents(environmentId, cwd, relativePath, contents),
  );
  // SCIENT-FORK:START — track native edits between React commits as well as incoming replacements.
  const lastEditorSource = useRef({ file: externalFile, contents: externalFile.contents });
  // SCIENT-FORK:END
  // SCIENT-FORK:START — a document session's source undo belongs to the document,
  // which keeps its id across an in-place rename and across reopening the file.
  const [fileEditStateKey] = useState(() => `scient-file:${environmentId}:${cwd}:${relativePath}`);
  const editStateKey = externalPersistence
    ? `scient-document:${documentIdentity(externalPersistence)}`
    : fileEditStateKey;
  // SCIENT-FORK:END
  const [editedContents, setEditedContents] = useState<string | null>(null);
  const { ready: editable, onPostRender: onEditablePostRender } =
    useEditableAfterHighlight(externalFile);
  const editorRef = useRef<Editor<"file", FileCommentAnnotationGroup, undefined> | null>(null);
  const [editor, setEditor] = useState<Editor<
    "file",
    FileCommentAnnotationGroup,
    undefined
  > | null>(null);
  // SCIENT-FORK:START — an open editor takes a new version as an edit, which keeps your place.
  const outsideChange = contents !== (editedContents ?? externalFile.contents);
  const updatesInPlace = editor !== null && externalPersistence === undefined;
  if (outsideChange && !updatesInPlace) {
    setExternalFile(editableFileContents(environmentId, cwd, relativePath, contents));
    setEditedContents(null);
  }
  // SCIENT-FORK:END
  // SCIENT-FORK:START — the server's editor flush names a file whose input method is composing.
  const compositionTarget = useStableCallback(
    () => externalPersistence?.target ?? { environmentId, cwd, relativePath },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the editor's composition state with the module-level flush registry
  useEffect(
    () =>
      editor ? editorCompositions.register(compositionTarget, () => editor.isComposing) : undefined,
    [editor, compositionTarget],
  );
  // SCIENT-FORK:END
  const handledSourceSelection = useRef<{ editor: typeof editor; requestId: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the imperative editor selection once it can reveal the requested source range
  useEffect(() => {
    if (
      !editor ||
      !sourceSelectionReveal ||
      !editable ||
      editingBlocked ||
      restorationBlocked ||
      (handledSourceSelection.current?.editor === editor &&
        handledSourceSelection.current.requestId === sourceSelectionReveal.requestId)
    )
      return;
    if (revealFileEditorSelection(editor, sourceSelectionReveal))
      handledSourceSelection.current = { editor, requestId: sourceSelectionReveal.requestId };
  }, [editor, sourceSelectionReveal, editable, editingBlocked, restorationBlocked]);
  const editorOptions: EditorOptions<"file", FileCommentAnnotationGroup, undefined> = {
    ownsVerticalViewport: true,
    // SCIENT-FORK:START — Rebase or refuse stale source projection without dropping undo.
    onAttach: (attachedEditor) => {
      editorRef.current = attachedEditor;
      setEditor(attachedEditor);
      onEditorChange?.(attachedEditor);
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
        const edit = minimalSourceEdit(previous, current);
        const prepared = attachedEditor.prepareExternalEdits(previous, [edit]);
        const latest = persistence.getSnapshot();
        if (
          prepared &&
          externalBindings.current.externalPersistence === persistence &&
          editorRef.current === attachedEditor &&
          latest.editVersion === snapshot.editVersion &&
          latest.draftSource === current &&
          !latest.editingBlocked &&
          persistence.getPendingInput() === null &&
          previous.slice(0, edit.start) + edit.text + previous.slice(edit.end) === current
        ) {
          applyingExternal.current = true;
          applyExternalProjection(
            () => {
              prepared();
            },
            () => {
              applyingExternal.current = false;
            },
          );
        }
      }
      // Without a document session the latest text, or your unsaved draft, wins over a retained copy.
      if (!persistence) moveEditorToSource(attachedEditor, contents, applyingExternal);
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
      // SCIENT-FORK:START — a detached editor takes no in-place update.
      setEditor(null);
      // SCIENT-FORK:END
      onEditorChange?.(null);
    },
    onFocus: () => queueMicrotask(() => reportEditorSelectionRef.current()),
  };
  const handleEditChange = ({
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
    // SCIENT-FORK:START — Pierre also reports incoming prop replacements as edit changes.
    const previousSource =
      lastEditorSource.current.file === externalFile
        ? lastEditorSource.current.contents
        : externalFile.contents;
    lastEditorSource.current = { file: externalFile, contents: file.contents };
    if (!applyingExternal.current && file.contents !== previousSource)
      onContentsChange(file.contents);
    // SCIENT-FORK:END
    if (nextLineAnnotations) {
      const remapped = remapFileCommentAnnotations(nextLineAnnotations);
      setLineAnnotations((current) => (current === nextLineAnnotations ? current : remapped));
      for (const annotation of remapped) {
        for (const entry of annotation.metadata.entries) {
          if (entry.kind !== "comment" || !promptCommentIds.has(entry.id)) continue;
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
  };
  const { mathInput, onCompositionEnd, onKeyDownCapture } = useScientFileEditorBindings({
    editor,
    environmentId,
    cwd,
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
    outsideSource: updatesInPlace && outsideChange ? contents : null,
  });
  const readCitationBaseline = () =>
    externalBindings.current.externalPersistence?.getSnapshot().baselineSource ??
    citationBaseline ??
    contents;
  const citationReady = () => {
    const current = editorRef.current;
    const lease = externalBindings.current.externalPersistence;
    return Boolean(
      current &&
      !restorationBlocked &&
      (!lease ||
        (projectionReady.current &&
          lease.getSnapshot().draftSource === current.getText() &&
          lease.getPendingInput() === null)),
    );
  };

  const removeAnnotationEntry = (entryId: string) => {
    setSelectedRange(null);
    removeReviewComment(composerDraftTarget, entryId);
    setLineAnnotations((current) => {
      return current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
    });
  };

  const submitAnnotationEntry = (entryId: string, text: string) => {
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
  };

  const beginComment = (range: SelectedLineRange) => {
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
  };
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs selection dismissal listeners on the editor surface DOM node
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
      retainSelectionOnBlur,
      onDismiss: () => setSelectedRange(null),
    });
  }, [hasOpenCommentForm, setSelectedRange, retainSelectionOnBlur]);
  const handleLineSelectionEnd = (range: SelectedLineRange | null) => {
    setSelectedRange(range);
    if (range && onSelectionChange === undefined && enableFileComments) {
      beginComment(range);
    }
  };
  const handleGutterUtilityClick = useStableCallback((range: SelectedLineRange) => {
    setSelectedRange(range);
    beginComment(range);
  });

  const handlePostRender: FilePostRender = (fileContainer, instance, phase) => {
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

    fileContainer.toggleAttribute("data-scient-retained-selection", retainSelectionOnBlur);

    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      if (!fileContainer.isConnected) return;
      // SCIENT-FORK:START — the line range is drawn in place, outside the editor's options.
      drawLineRange(fileContainer, instance);
      // SCIENT-FORK:END
    });
  };

  return (
    <EditProvider createEditor={createFileEditor}>
      <div
        ref={attachSurface}
        className="relative flex min-h-0 flex-1"
        onCompositionEnd={onCompositionEnd}
        onKeyDownCapture={onKeyDownCapture}
      >
        {threadRef ? (
          <SourceCitationActions
            editor={editor}
            viewport={surface}
            target={{
              ...threadRef,
              cwd,
              path: relativePath,
              latexRootRelativePath: citationRootRelativePath,
            }}
            baseline={readCitationBaseline}
            ready={citationReady}
            onCite={onCite}
            reveal={citationReveal}
            revealId={revealRequestId}
            // SCIENT-FORK:START — what a clicked caret stands for, while no lines are picked.
            caretQuote={selectedRange === null ? caretQuote : undefined}
            // SCIENT-FORK:END
          />
        ) : null}
        {/* SCIENT-FORK:START — Overleaf conflict blocks: highlighted, with a choice above each */}
        <OverleafConflictActions
          editor={editor}
          surface={surface}
          source={editedContents ?? externalFile.contents}
          disabled={!editable || editingBlocked || restorationBlocked}
        />
        {/* SCIENT-FORK:END */}
        {/* SCIENT-FORK:START — Explain source refusal without discarding retained edits. */}
        {restorationBlocked ? (
          <div role="alert" className="p-2 text-xs text-muted-foreground">
            <T>
              Source editing is paused to protect changes made in Rich. Return to Rich to continue.
            </T>
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
            editStateKey={editStateKey}
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
            renderAnnotation={(annotation) => {
              // Sent comments stay annotated so a failed send can restore them at remapped lines.
              const entries = promptFileCommentEntries(
                annotation.metadata.entries,
                promptCommentIds,
              );
              if (entries.length === 0) return null;
              return (
                <div className="py-1">
                  {entries.map((entry) => (
                    <DiffCommentAnnotation
                      key={entry.id}
                      environmentId={environmentId}
                      projectId={projectId}
                      ownerKey={JSON.stringify([
                        environmentId,
                        composerDraftTarget,
                        relativePath,
                        entry.id,
                      ])}
                      kind={entry.kind}
                      rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine, messages)}
                      text={entry.text}
                      onCancel={() => removeAnnotationEntry(entry.id)}
                      onComment={(text) => submitAnnotationEntry(entry.id, text)}
                      onDelete={() => removeAnnotationEntry(entry.id)}
                    />
                  ))}
                </div>
              );
            }}
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

function selectRenderedContentOnSelectAll(event: ReactKeyboardEvent<HTMLElement>) {
  const mac = isMacPlatform(navigator.platform);
  const selectAll =
    event.key.toLowerCase() === "a" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.shiftKey &&
    !event.altKey;
  // React bubbles keys from portaled children (the image dialog) through this surface.
  if (
    !selectAll ||
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  event.preventDefault();
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

/** T3's ordinary rendered preview remains authoritative for MDX. */
function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  revision,
  initialSource,
  publicationAttention,
  truncated,
  workspaceMutationId,
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
  | "onEditorChange"
> & {
  truncated: boolean;
  readOnly: boolean;
  threadRef: ScopedThreadRef;
  workspaceMutationId: string | null;
  initialSource: string;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    enabled: !readOnly && !truncated,
    environmentId,
    cwd,
    relativePath,
    revision,
    initialSource,
    ...(publicationAttention === undefined ? {} : { publicationAttention }),
    onPendingChange,
    onSaveFailure,
    onSaveConfirmed,
    onSaveResolutionApplied,
    saveResolution,
  });
  const onTaskListChange =
    truncated || readOnly
      ? undefined
      : ({
          markerOffset,
          checked,
        }: {
          readonly markerOffset: number;
          readonly checked: boolean;
        }) => {
          const nextContents = resolveMarkdownTaskPreviewUpdate({
            markdown: saveCoordinator.getDraftSource(),
            markerOffset,
            checked,
            truncated,
          });
          if (nextContents === null) return;
          setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
          saveCoordinator.change(nextContents);
        };

  return (
    <ChunkedMarkdown
      // SCIENT-FORK:START
      {...splitScientFileMarkdown(contents)}
      // SCIENT-FORK:END
      cwd={cwd}
      relativePath={relativePath}
      threadRef={threadRef}
      workspaceMutationId={workspaceMutationId}
      onKeyDown={selectRenderedContentOnSelectAll}
      onTaskListChange={onTaskListChange}
    />
  );
}

function renderedToggleLabel(
  mode: "markdown" | "mermaid" | "html" | "table",
  rendered: boolean,
  resolve: MessageResolver,
): string {
  if (mode === "mermaid")
    return rendered ? resolve(msg("Show Mermaid source")) : resolve(msg("Show rendered diagram"));
  if (mode === "markdown")
    return rendered ? resolve(msg("Show markdown source")) : resolve(msg("Show rendered markdown"));
  if (mode === "table") return rendered ? resolve(msg("Show source")) : resolve(msg("Show table"));
  return rendered ? resolve(msg("Show HTML source")) : resolve(msg("Show rendered page"));
}

// SCIENT-FORK:START — the file list's saved state is read through usePanelFilesOpen
// SCIENT-FORK:END

export default function FilePreviewPanel({
  // SCIENT-FORK:START
  scientSurfaceId,
  // SCIENT-FORK:END
  onCiteFile,
  fileCitation,
  environmentId,
  cwd,
  projectName,
  projectId,
  relativePath: requestedPath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  openInShortcutEnabled,
  revealLine,
  revealRequestId,
  htmlPresentationRequest,
  latexPresentationRequest,
  latexRootRelativePath,
  latexSourceReveal,
  onOpenFile,
  onFileMoved,
  onFileRenamed,
  onOpenFileSource,
  onHtmlPresentationRequestHandled,
  onLatexPresentationRequestHandled,
  onNavigateFolder,
  folderTrail,
  onPendingChange,
  selectedFilePending,
  workspaceMutationId,
}: FilePreviewPanelProps) {
  const relativePath =
    attachment === undefined ? resolveFilePreviewPath(requestedPath, cwd) : requestedPath;
  const draft = typeof composerDraftTarget === "string";
  const gt = useGT();
  const m = useMessages();
  const { resolvedTheme } = useTheme();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? defaultWordWrap;
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const remoteOpenState = useRemoteOpenState(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const previewAvailable = usePreviewAvailable(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && !isVideo && isWorkspaceAudioPreviewPath(relativePath);
  const isImage = relativePath !== null && !isVideo && isWorkspaceImagePreviewPath(relativePath);
  const isMedia = isImage || isVideo || isAudio;
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isDocument =
    relativePath !== null &&
    (binaryPreviewKind({ name: relativePath }) !== null ||
      officePreviewKind({ name: relativePath }) !== null ||
      isWorkspaceFontPreviewPath(relativePath));
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  // Attachments and absolute host paths are preview-only and never enter the
  // workspace editor or explorer.
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isHostPath(relativePath));
  const fileAccess = useFilesystemReadAccess(environmentId, m);
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
  // SCIENT-FORK:START — attachments and files outside the project keep the read-only preview.
  const isProjectNotebook = !isHostFile && isScientNotebookFile(relativePath);
  // SCIENT-FORK:END
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
    manualReloadKey,
  } = useWorkspaceFileRefresh({
    environmentId,
    cwd,
    relativePath,
    // Read every workspace path so a chat link to a directory can be
    // distinguished from a media or PDF file before choosing a preview.
    // SCIENT-FORK:START — a project notebook loads cell by cell from the server, never as text.
    loadAsText: attachment === undefined && !isProjectNotebook,
    // SCIENT-FORK:END
    sourcePending: effectiveSourcePending,
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
  const [fileRefreshRevision, setFileRefreshRevision] = useState(0);
  // Folder links fail file reads; retain mutation refresh to detect conversion to files. Host folders own
  // roots; folderTrail keeps descendants.
  const breadcrumbPath =
    attachment !== undefined ? null : (relativePath ?? (folderTrail === undefined ? null : ""));
  // Reset crumbs when a host trail reaches the workspace root and no longer passes through the current path.
  const breadcrumbTrail =
    breadcrumbPath === null ? null : retainedBreadcrumbTrail(folderTrail, breadcrumbPath);
  // A trail implies a folder before reads settle, preventing file-preview flashes while navigating up.
  const isFolder =
    attachment === undefined &&
    (queriedFile.isNotFile ||
      (folderTrail !== undefined && queriedFile.data === null && queriedFile.error === null));
  const hostFolderPath = isFolder && isHostFile ? relativePath : null;
  // A chat-linked folder reads as a file until its read settles, and a trail only implies a folder.
  const fileManagerAction = fileManagerActionForPath({
    isFolder: relativePath === null || queriedFile.isNotFile,
    isSettled: queriedFile.data !== null || queriedFile.error !== null,
    canReveal: serverConfig?.shellRevealInFileManager === true,
  });
  // Everything preview-related keys off previewPath; a folder has no preview.
  const previewPath = isFolder ? null : relativePath;
  // SCIENT-FORK:START — a workspace file's crumbs are Scient's picker; see the subheader
  const scientCrumbPath =
    !isHostFile && folderTrail === undefined && breadcrumbPath ? breadcrumbPath : null;
  // SCIENT-FORK:END
  // SCIENT-FORK:START — one switch, the tab strip's Files button, serves every tab and
  // every kind of file, PDFs included
  const [explorerOpen] = usePanelFilesOpen();
  const effectiveExplorerOpen = isFolder || explorerOpen;
  // SCIENT-FORK:END
  const showExplorer = shouldShowFileExplorer({
    relativePath: previewPath,
    explorerOpen: effectiveExplorerOpen,
    attachmentOpen: attachment !== undefined,
  });
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
  // Reveal ids restart at one per file; pair with the path so dismissal cannot swallow another file's reveal.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMermaid = previewPath !== null && /\.(mmd|mermaid)$/i.test(previewPath);
  const [renderMermaidPreferred, setRenderMermaidPreferred] = useLocalStorage(
    "t3code.renderMermaid",
    true,
    Schema.Boolean,
  );
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
  const markdownRenderable =
    isMarkdownDocument && (queriedFile.data?.byteLength ?? 0) <= FULL_TEXT_MAX_BYTES;
  const renderMarkdown =
    markdownRenderable &&
    !(citationRevealActive && fileCitation?.sourceSelection) &&
    resolveMarkdownRenderedState(renderMarkdownPreferred, citationRevealActive, revealHandled);
  const requestedHtmlMode =
    htmlPresentationRequest?.id === revealRequestId ? htmlPresentationRequest.mode : null;
  const renderBrowserFile =
    isHtml &&
    resolveHtmlRenderedState(renderBrowserFilePreferred, requestedHtmlMode) &&
    revealHandled;
  const renderMermaid =
    isMermaid && renderMermaidPreferred && revealHandled && !citationRevealActive;
  const rendered = isMermaid
    ? renderMermaid
    : isMarkdownDocument
      ? renderMarkdown
      : isHtml
        ? renderBrowserFile
        : false;
  const tableDelimiter =
    previewPath && attachment === undefined ? filePreviewDelimiter({ name: previewPath }) : null;
  // SCIENT-FORK:START — saved data views share the table presentation with delimited files.
  const savedView = useSavedDataViewPreview(
    isHostFile ? null : previewPath,
    queriedFile.authoritativeData?.contents,
    runAfterPendingSave,
  );
  const hasTablePreview = tableDelimiter !== null || savedView !== null;
  const renderTable =
    (savedView?.rendered ?? (tableDelimiter !== null && renderTablePreferred)) &&
    revealHandled &&
    !(citationRevealActive && fileCitation?.sourceSelection);
  const renderedMode = isMermaid
    ? ("mermaid" as const)
    : isMarkdownDocument
      ? ("markdown" as const)
      : hasTablePreview
        ? ("table" as const)
        : isHtml
          ? ("html" as const)
          : null;
  const surfaceRendered = hasTablePreview ? renderTable : rendered;
  const canToggleRenderedForSurface =
    previewPath !== null &&
    attachment === undefined &&
    renderedMode !== null &&
    (!isMarkdownDocument || markdownRenderable) &&
    !(savedView !== null && surfaceRendered);
  // SCIENT-FORK:END
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
    authoritativeReadError: queriedFile.readError,
    onAttentionResolved: () => handleSaveResolutionApplied(),
    workspaceMutationId,
  });
  // SCIENT-FORK:START — a document session's draft is the displayed file
  const { markdownRefreshFailure, markdownRefreshCopy, file } = scientDocumentSessionFile(
    queriedFile,
    markdownSnapshot,
    relativePath,
    hostOs,
    m,
  );
  const compiledRevealRevision =
    latexSourceReveal?.id === revealRequestId ? latexSourceReveal.revision : null;
  const [rejectedCompiledReveal, setRejectedCompiledReveal] = useState<number | null>(null);
  const compiledRevealCurrent =
    compiledRevealRevision === null ||
    (file.data?.revision === compiledRevealRevision &&
      !file.data.truncated &&
      !effectiveSourcePending &&
      !queriedFile.isPending &&
      (!usesDocumentSession ||
        markdownLease !== null ||
        queriedFile.authoritativeData?.readOnly === true) &&
      queriedFile.readError === null &&
      (markdownSnapshot === null ||
        (!markdownSnapshot.pending &&
          !markdownSnapshot.reading &&
          !markdownSnapshot.currentMissing &&
          markdownSnapshot.error === null &&
          markdownSnapshot.conflict === null &&
          markdownSnapshot.draftSource === markdownSnapshot.baselineSource &&
          markdownSnapshot.baselineRevision === compiledRevealRevision)));
  const currentRevealLine =
    compiledRevealCurrent && rejectedCompiledReveal !== revealRequestId ? revealLine : null;
  // Once the loaded source is known not to be the compiled one, this request
  // stays unrevealed even if a later read matches.
  if (
    compiledRevealRevision !== null &&
    file.data !== null &&
    !queriedFile.isPending &&
    !markdownSnapshot?.reading &&
    (!usesDocumentSession ||
      markdownLease !== null ||
      queriedFile.authoritativeData?.readOnly === true) &&
    !compiledRevealCurrent &&
    rejectedCompiledReveal !== revealRequestId
  )
    setRejectedCompiledReveal(revealRequestId);
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
    !isPdf &&
    !isDocument &&
    !renderMermaid;
  const copyableContents =
    previewPath !== null &&
    !isMedia &&
    !isDocument &&
    !isPdf &&
    file.data &&
    !file.data.truncated &&
    file.data.contents.length > 0
      ? file.data.contents
      : null;
  const showsLargeText =
    previewPath !== null &&
    attachment === undefined &&
    !isMedia &&
    // SCIENT-FORK: Scient's PDF viewer owns PDFs.
    !isPdf &&
    !renderBrowserFile &&
    !isDocument &&
    !renderMermaid &&
    file.data?.truncated === true &&
    // SCIENT-FORK: some sources keep their bounded view.
    !keepsBoundedSourceView(previewPath, citationRevealActive);
  const copyLargeText = useRef<(() => Promise<string>) | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(previewPath ?? ""),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: gt("Could not copy file"),
        description: error.message,
      }),
  });
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
  const applyMarkdownViewChange = (pressed: boolean) => {
    const next = markdownViewTransition(pressed, relativePath, revealRequestId);
    setDismissedCitationReveal(next.dismissedCitationReveal);
    setRenderMarkdownPreferred(next.preferred);
    setHandledReveal(next.handledReveal);
  };
  const handleRenderMarkdownChange = (pressed: boolean) => {
    const apply = () => applyMarkdownViewChange(pressed);
    if (relativePath === null) {
      apply();
      return;
    }
    runAfterPendingSave([relativePath], apply);
  };
  const contentFocusRef = useRef<HTMLDivElement>(null);
  const fileEditorRef = useRef<FileEditor | null>(null);
  const focusEditorFromContent = () => {
    const editor = fileEditorRef.current;
    if (!editor || document.activeElement !== contentFocusRef.current) return;
    // Without a caret the editor focuses with no selection, so no caret shows and typing
    // lands on whatever the browser selection held.
    const hasCaret = Boolean(editor.getViewState().selections?.length);
    editor.focus(
      hasCaret
        ? { preventScroll: true }
        : { preventScroll: true, lineNumber: revealLine ?? "first-visible" },
    );
  };
  const handleEditorChange = (editor: FileEditor | null) => {
    fileEditorRef.current = editor;
    focusEditorFromContent();
  };
  const handleEditorChangeStable = useStableCallback(handleEditorChange);
  // SCIENT-FORK:START — rendered beside a source editor, or a loading view that may become one,
  // which Scient's surface chain picks. Panel focus lands here and passes to the editor once it
  // attaches. sr-only keeps the 1px box workspace focus needs, and clips it so clicks in the file
  // never reach it. The hand-off waits a microtask: workspace focus checks that focus stayed here.
  const contentFocus = (
    <div
      ref={contentFocusRef}
      tabIndex={-1}
      data-workspace-focus-default
      data-file-content-focus
      aria-label={gt("File contents")}
      className="sr-only"
      onFocus={() => queueMicrotask(focusEditorFromContent)}
    />
  );
  // Each branch is this fragment, so the target stays mounted from loading to editor; its slot
  // stays when it is left out, so the surface beside it is not remounted.
  const withContentFocus = (surface: ReactNode, mayOpenEditor = true) => (
    <>
      {mayOpenEditor ? contentFocus : null}
      {surface}
    </>
  );
  const computeShowsEditor = useComputeFilePresentationStore(
    (state) =>
      computeContextId === null || state.presentations[computeContextId]?.view !== "results",
  );
  const loadingMayOpenEditor =
    !isHostFile &&
    canWriteFiles &&
    !rendered &&
    !(tableDelimiter && renderTable) &&
    computeShowsEditor;
  // SCIENT-FORK:END
  const focusEditorOnTreeRowClickOrEnter = (event: {
    nativeEvent: Event;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = event.nativeEvent
      .composedPath()
      .find(
        (node): node is Element =>
          node instanceof Element && node.matches('[role="treeitem"][data-item-path]'),
      );
    const path = row?.getAttribute("data-item-path");
    if (!path || path.endsWith("/")) return;
    requestWorkspaceFocus({ area: "panel", selector: "[data-file-content-focus]" });
  };
  const handleRenderedChange = (pressed: boolean) => {
    if (isMermaid) {
      const apply = () => {
        setRenderMermaidPreferred(pressed);
        setDismissedCitationReveal(revealRequestId);
        setHandledReveal(
          pressed && relativePath !== null
            ? { path: relativePath, requestId: revealRequestId }
            : null,
        );
      };
      if (relativePath === null) apply();
      else runAfterPendingSave([relativePath], apply);
      return;
    }
    if (isMarkdownDocument) {
      handleRenderMarkdownChange(pressed);
      return;
    }
    // SCIENT-FORK:START — wait for the saved query before switching presentation.
    if (savedView !== null) {
      savedView.setRendered(pressed, () =>
        setHandledReveal(pressed ? { path: savedView.path, requestId: revealRequestId } : null),
      );
      return;
    }
    // SCIENT-FORK:END
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
      pressed && relativePath !== null ? { path: relativePath, requestId: revealRequestId } : null,
    );
  };
  const canOpenInBrowser =
    canOperatePreview &&
    previewPath !== null &&
    attachment === undefined &&
    !isVideo &&
    previewAvailable &&
    isBrowserPreviewFile(previewPath);
  // Navigating up preserves the file tab; retain the trail's path spelling to find its folder tab.
  const navigateToFolder = (crumbPath: string) => {
    const path =
      breadcrumbTrail !== null && breadcrumbPathOf(breadcrumbTrail) === crumbPath
        ? breadcrumbTrail
        : crumbPath;
    onNavigateFolder(path, retainedBreadcrumbTrail(breadcrumbTrail ?? undefined, path), !isFolder);
  };
  const absolutePath =
    breadcrumbPath === ""
      ? cwd
      : relativePath && attachment === undefined
        ? workspaceFileHostPath(relativePath, cwd)
        : null;
  // SCIENT-FORK:START — the grid reports its own coverage, independent of the source text read.
  const showDataGrid =
    relativePath !== null &&
    absolutePath !== null &&
    attachment === undefined &&
    (isScientDataFile(relativePath) || savedView !== null) &&
    (!hasTablePreview || renderTable);
  // SCIENT-FORK:END
  // SCIENT-FORK:START — missing-file choices, read failure and save a copy
  const { missingFile, canSaveCopy, handleSaveCopy, readFailure, blockingReadFailure } =
    useScientFileReadRecovery({
      environmentId,
      cwd,
      relativePath,
      attachment,
      isHostFile,
      isDirectory: isFolder,
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
    !isFolder &&
    canWriteFiles &&
    file.data?.readOnly !== true &&
    file.data?.outsideWorkspace !== true;
  const renameRevision =
    file.data && !file.data.truncated
      ? (markdownSnapshot?.baselineRevision ?? file.data.revision)
      : null;
  const [renamingInPlace, setRenamingInPlace] = useState(false);
  const renamePendingRef = useRef(effectiveSourcePending);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest pending-source state for the async rename handler
  useLayoutEffect(() => {
    renamePendingRef.current = effectiveSourcePending;
  });
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
  const { onPostRender: onFilePostRender, move: moveFileLineReveal } = useFileLineReveal(
    relativePath,
    currentRevealLine,
    revealRequestId,
    citationRevealActive ? fileCitation : undefined,
  );
  // SCIENT-FORK:START — an open Markdown document renames in place, keeping its editor
  const { moveInPlace, surfaceGeneration } = useInPlaceRename({
    threadRef,
    environmentId,
    cwd,
    relativePath,
    lease: markdownLease,
    // Markdown; and a LaTeX document just started from the Documents menu,
    // while its surface says its editors can follow. Everything else keeps
    // the ordinary rename.
    canMove: (from, to) =>
      (isScientMarkdownDocumentPath(from) && isScientMarkdownDocumentPath(to)) ||
      (isLatexPreviewFile(from) &&
        /\.tex$/iu.test(to) &&
        latexRename?.movable === true &&
        newDocuments.get({ environmentId, cwd, relativePath: from }) !== null),
    // Visual drafts still stored under the old name (being confirmed, or parked
    // recovery) would be left behind; wait for them. Unreadable counts as busy.
    sourceBusy: (from) =>
      isLatexPreviewFile(from) &&
      pathHasLeftoverDrafts({ environmentId, cwd, relativePath: from }, true),
    // Drafts left at the new name by an earlier file would be offered as this
    // document's recovery, or overwritten. Unreadable counts as occupied.
    destinationStorageFree: (to) =>
      !isLatexPreviewFile(to) ||
      !pathHasLeftoverDrafts({ environmentId, cwd, relativePath: to }, true),
    reopen: (from, to) =>
      applyScientFileRename({
        environmentId,
        cwd,
        relativePath: from,
        usesDocumentSession,
        destinationRelativePath: to,
        onFileRenamed,
      }),
    moveTab: (from, to) => (onFileMoved ?? onFileRenamed)(from, to),
    moveViewState: (from, to) => {
      templateEdits.move(
        { environmentId, cwd, relativePath: from },
        { environmentId, cwd, relativePath: to },
      );
      setHandledReveal((current) => (current?.path === from ? { ...current, path: to } : current));
      moveFileLineReveal(from, to);
    },
  });
  const documentSurfaceKey = markdownLease
    ? `${documentIdentity(markdownLease)}:${surfaceGeneration}`
    : relativePath;
  // SCIENT-FORK:END
  // A document started from the Documents menu: its template row, then its one rename.
  const newDocument = useNewDocument({
    environmentId,
    cwd,
    relativePath,
    lease: markdownLease,
    snapshot: markdownSnapshot ?? null,
    renameDisabled,
    ...(moveInPlace ? { moveInPlace } : {}),
    canMoveInPlace:
      relativePath !== null &&
      (isRichMarkdown || (isLatexPreviewFile(relativePath) && latexRename?.movable === true)),
    onRenamed: (from, destinationRelativePath) => {
      applyScientFileRename({
        environmentId,
        cwd,
        // The document Scient moved, even if another now shows in this panel.
        relativePath: from,
        usesDocumentSession,
        destinationRelativePath,
        onFileRenamed,
      });
    },
  });
  // A LaTeX document's own exports, published by its surface.
  const [latexDownloads, setLatexDownloads] = useState<DocumentDownloadActions | null>(null);
  // SCIENT-FORK:END
  const pdfSource = workspacePdfSourceForPreview({
    absolutePath,
    environmentId,
    relativePath,
    threadId: threadRef.threadId,
    workspaceRoot: cwd,
  });
  // SCIENT-FORK:START — what a document or binary preview loads; ScientFileRevisionBoundary checks it.
  const documentAsset =
    relativePath && absolutePath
      ? {
          environmentId,
          resource: isDocument
            ? workspaceViewerAssetResource(
                { draft, threadRef, workspaceRoot: cwd, absolutePath, relativePath },
                "workspace-file",
              )
            : {
                _tag: "media-file" as const,
                threadId: threadRef.threadId,
                path: absolutePath,
                disposition: "attachment" as const,
              },
        }
      : null;
  // A document's view stays hidden after it is left (ScientDocumentShelf); a reload asked while
  // another file showed is not its own.
  const documentShelfKey = `${environmentId}:${absolutePath ?? ""}`;
  const documentReloads = useChangesWhileShown(
    documentShelfKey,
    `${manualReloadKey}:${fileRefreshRevision}`,
  );
  // SCIENT-FORK:END
  const handlePendingChange = (path: string, pending: boolean) => {
    setPendingPaths((current) => {
      const next = new Set(current);
      if (pending) next.add(path);
      else next.delete(path);
      return next;
    });
    onPendingChange(path, pending);
  };
  const genericSaveEnabled =
    !usesDocumentSession &&
    !isDocument &&
    !isHostFile &&
    !isFolder &&
    attachment === undefined &&
    relativePath !== null &&
    ((queriedFile.authoritativeData !== null &&
      !queriedFile.authoritativeData.truncated &&
      !queriedFile.authoritativeData.readOnly) ||
      queriedFile.failureReason === "not_found");
  const genericSaveCoordinator = useFileSaveCoordinator({
    enabled: genericSaveEnabled,
    environmentId,
    cwd,
    relativePath: relativePath ?? "",
    revision: queriedFile.authoritativeData?.revision ?? "",
    initialSource: queriedFile.authoritativeData?.contents ?? "",
    ...(queriedFile.authoritativeData?.publicationAttention === undefined
      ? {}
      : { publicationAttention: queriedFile.authoritativeData.publicationAttention }),
    onPendingChange: handlePendingChange,
    onSaveFailure: handleSaveFailure,
    onSaveConfirmed: handleSaveConfirmed,
    onSaveResolutionApplied: handleSaveResolutionApplied,
    saveResolution,
  });
  const publicationAttention = markdownLease
    ? (markdownSnapshot?.publicationAttention ?? null)
    : genericSaveCoordinator.publicationAttention;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the breadcrumb DOM so the deepest and current crumbs are in view after commit
  useEffect(() => {
    const crumbs = breadcrumbRef.current?.querySelectorAll<HTMLElement>("[data-file-crumb]");
    // Show the deepest crumb when it fits, but never at the cost of the current one.
    crumbs?.[crumbs.length - 1]?.scrollIntoView({ block: "nearest", inline: "end" });
    breadcrumbRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new path or trail re-renders the crumbs, so the current one scrolls back into view.
  }, [breadcrumbPath, breadcrumbTrail]);

  // SCIENT-FORK:START — the file list's switch is the tab strip's Files button
  // SCIENT-FORK:END

  const handleOpenInBrowser = () => {
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
          title: gt("Unable to open file in browser"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
        }),
      );
    })();
  };

  const freshnessNoticeProps = {
    relativePath,
    notice: reloadNotice,
    readError: isFolder ? null : file.error,
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
      if (relativePath && isLatexPreviewFile(relativePath)) return <LatexDocumentPreparation />;
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          <T>Checking file access...</T>
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {fileAccess.error ?? gt("This connection cannot read host files.")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbPath !== null && breadcrumbTrail !== null ? (
        <div
          className={cn(
            FILE_SURFACE_SUBHEADER_CLASS,
            usesScientMarkdownEditor && "in-data-[preview-panel-mode=inline]:mb-2",
          )}
          data-surface-subheader
        >
          {/* SCIENT-FORK:START — -me-1 gives back the room the crumbs' ps-1 takes, so the path stays put */}
          <TabHistoryButtons
            className="-me-1"
            threadRef={threadRef}
            surfaceId={scientSurfaceId}
            keybindings={keybindings}
          />
          {/* SCIENT-FORK:END */}
          <ScrollArea
            radius="none"
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1"
            data-file-breadcrumbs
          >
            {/* SCIENT-FORK:START — a workspace file's crumbs browse with Scient's picker and carry the rename control; host paths and folders walked up by crumbs keep upstream's navigating crumbs */}
            {scientCrumbPath === null ? (
              <div className="flex h-full w-max min-w-full items-center scient-reading-ui text-xs">
                <FileBreadcrumbs
                  cwd={cwd}
                  environmentId={environmentId}
                  onNavigateFolder={navigateToFolder}
                  onOpenFile={onOpenFile}
                  projectName={projectName}
                  relativePath={breadcrumbPath}
                  trail={breadcrumbTrail}
                  workspaceMutationId={workspaceMutationId}
                />
              </div>
            ) : (
              <FileBreadcrumbNavigator
                environmentId={environmentId}
                cwd={cwd}
                projectName={projectName}
                relativePath={scientCrumbPath}
                onOpenFile={onOpenFile}
                currentFileControl={
                  canRenameFile ? (
                    <FileRenameButton
                      beforeRename={
                        markdownLease ? () => markdownLease.holdForRename() : holdPanelFileForRename
                      }
                      onMutationFailure={(cause, mutationId) =>
                        markdownLease
                          ? markdownLease.noteMutationFailure(cause, mutationId)
                          : genericSaveCoordinator.noteMutationFailure(cause, mutationId)
                      }
                      resolveAttention={(recoveryId, currentRevision) =>
                        markdownLease
                          ? markdownLease.resolveRetainedAttention(recoveryId, currentRevision)
                          : genericSaveCoordinator.resolveRetainedAttention(
                              recoveryId,
                              currentRevision,
                            )
                      }
                      acknowledgeRefusal={(currentRevision) =>
                        markdownLease
                          ? markdownLease.reviewUnchangedRefusal(currentRevision)
                          : genericSaveCoordinator.reviewUnchangedRefusal(currentRevision)
                      }
                      {...(isRichMarkdown
                        ? {
                            normalize: normalizeMarkdownCreatePath,
                            invalidMessage: gt(
                              "Enter a relative Markdown path inside this workspace.",
                            ),
                          }
                        : {})}
                      {...(latexRename?.includedBy
                        ? {
                            notice: (
                              <T>
                                <Var>{latexRename.includedBy}</Var> includes this file. After
                                renaming, update the line that includes it.
                              </T>
                            ),
                          }
                        : {})}
                      {...(markdownLease && moveInPlace
                        ? { moveInPlace, pendingRename: markdownLease.getRenameIntent() }
                        : {
                            renameJournal: {
                              pendingRename: genericSaveCoordinator.getRenameIntent(),
                              isCurrent: genericSaveCoordinator.isRenameCurrent,
                              beginRename: (to: string) =>
                                genericSaveCoordinator.beginRename(
                                  { environmentId, cwd, relativePath },
                                  { environmentId, cwd, relativePath: to },
                                ),
                              acknowledgeRename: genericSaveCoordinator.acknowledgeRename,
                              rejectRename: genericSaveCoordinator.rejectRename,
                            },
                          })}
                      environmentId={environmentId}
                      cwd={cwd}
                      relativePath={scientCrumbPath}
                      revision={renameRevision}
                      metadataOnly={
                        !markdownLease &&
                        (file.failure === "binary_file" || file.data?.truncated === true)
                      }
                      disabled={renameDisabled}
                      label={scientCrumbPath.slice(scientCrumbPath.lastIndexOf("/") + 1)}
                      onOpenFile={onOpenFile}
                      onRenamed={(destinationRelativePath) =>
                        applyScientFileRename({
                          environmentId,
                          cwd,
                          relativePath: scientCrumbPath,
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
            {/* SCIENT-FORK:END */}
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId ||
            environmentId === hostEnvironmentId ||
            remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              enableShortcut={openInShortcutEnabled}
              openInCwd={absolutePath}
              openInCwdIsFile={file.isFile}
              compact
              fileManagerAction={fileManagerAction}
            />
          ) : null}
          {/* Word wrap comes before the view toggle, so the toggle keeps its place
              when it switches to the source and back. */}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? gt("Disable word wrap") : gt("Enable word wrap")}
              pressed={wordWrap}
              onPress={() => setWordWrapOverride(!wordWrap)}
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
              label={renderedToggleLabel(renderedMode!, surfaceRendered, m)}
              pressed={surfaceRendered}
              onPress={() => handleRenderedChange(!surfaceRendered)}
            >
              {surfaceRendered ? (
                <Code2Icon className="size-3.5" />
              ) : renderedMode === "table" ? (
                <Table2Icon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
            </FileSurfaceAction>
          ) : null}
          {copyableContents !== null ? (
            <FileSurfaceAction
              label={isCopied ? gt("Copied") : gt("Copy contents")}
              onPress={() => copyToClipboard(copyableContents, undefined)}
            >
              {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </FileSurfaceAction>
          ) : null}
          {showsLargeText && absolutePath && relativePath ? (
            <LargeFileActions name={relativePath} copyContents={copyLargeText} />
          ) : null}
          {canOpenInBrowser ? (
            <FileSurfaceAction
              label={gt("Open file in preview browser")}
              onPress={handleOpenInBrowser}
            >
              <Globe className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {!isHostFile && !isFolder && relativePath && attachment === undefined ? (
            <ScientFileVersionHistory
              key={documentSurfaceKey}
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              canWrite={canWriteFiles}
              canAcceptCurrent={
                markdownLease
                  ? markdownLease.getPendingInput() === null && !markdownSnapshot?.editingBlocked
                  : true
              }
              onOpenFile={onOpenFile}
              {...(publicationAttention == null ? {} : { publicationAttention })}
              reviewRequired={
                markdownLease
                  ? markdownSnapshot?.publicationOutcome === "unchanged"
                  : genericSaveCoordinator.reviewRequired
              }
              onReviewCurrent={(currentRevision) =>
                markdownLease
                  ? markdownLease.reviewUnchangedRefusal(currentRevision)
                  : genericSaveCoordinator.reviewUnchangedRefusal(currentRevision)
              }
              {...(markdownLease || genericSaveEnabled
                ? {
                    onAcceptCurrent: (recoveryId: string, currentRevision: string | null) =>
                      markdownLease
                        ? markdownLease.resolveRetainedAttention(recoveryId, currentRevision)
                        : genericSaveCoordinator.resolveRetainedAttention(
                            recoveryId,
                            currentRevision,
                          ),
                  }
                : {})}
            />
          ) : null}
          {/* SCIENT-FORK:START — the Overleaf chip of a file in a linked folder, beside "Saved" */}
          {relativePath && !isHostFile && !isFolder ? (
            <OverleafFileChip
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              threadRef={threadRef}
            />
          ) : null}
          {/* SCIENT-FORK:END */}
          {/* SCIENT-FORK:START — an audio or video file's Transcribe, or its transcript */}
          {(isAudio || isVideo) && absolutePath && !isHostFile && attachment === undefined ? (
            <TranscribeFileAction
              environmentId={environmentId}
              cwd={cwd}
              absolutePath={absolutePath}
              threadRef={threadRef}
            />
          ) : null}
          {/* SCIENT-FORK:END */}
          {relativePath && isLatexPreviewFile(relativePath) ? (
            <ScientFileFreshnessStatus
              {...freshnessNoticeProps}
              pending={effectiveSourcePending}
              retrying={markdownSnapshot?.retrying ?? false}
              sessionAttention={
                markdownSnapshot?.attention ??
                (markdownSnapshot?.conflict
                  ? "conflict"
                  : markdownSnapshot?.error
                    ? markdownSnapshot.pending
                      ? "failure"
                      : "refresh"
                    : null)
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
              sourceLabel={gt("LaTeX source (.tex)")}
              onSaveCopy={handleSaveCopy}
            />
          ) : canSaveCopy ? (
            <FileSurfaceAction label={gt("Save a copy to this device")} onPress={handleSaveCopy}>
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
          {/* SCIENT-FORK:START — the tab strip's Files button shows and hides the list */}
          {/* SCIENT-FORK:END */}
        </div>
      ) : null}
      {markdownLease ? (
        <ScientMarkdownPersistenceNotice
          key={documentSurfaceKey}
          persistence={markdownLease}
          onOpenFile={onOpenFile}
          {...(!renderMarkdown ? { onReturnToRich: () => applyMarkdownViewChange(true) } : {})}
          {...(markdownRefreshCopy ? { refreshCopy: markdownRefreshCopy } : {})}
          {...(markdownRefreshFailure?.reason === "not_found"
            ? { missingFileChoices: missingFile.paths }
            : {})}
        />
      ) : attachment === undefined && relativePath && isLatexPreviewFile(relativePath) ? null : (
        <ScientFileFreshnessNotices {...freshnessNoticeProps} />
      )}
      {!markdownLease && genericSaveCoordinator.currentMissing ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 scient-reading-micro text-foreground"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0 flex-1 leading-snug">
            <span className="font-medium">
              <T>This file is no longer on disk.</T>
            </span>{" "}
            <span className="text-muted-foreground">
              <T>Your text is still here and hasn’t been saved anywhere.</T>
            </span>
          </p>
          <Button
            size="xs"
            disabled={!canWriteFiles || file.data === null}
            onClick={() => genericSaveCoordinator.recreateMissingCurrent(file.data!.contents)}
          >
            <T>Save it again</T>
          </Button>
        </div>
      ) : null}
      {relativePath && !attachment && !isHostFile && !canWriteFiles && !fileAccess.isPending ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          <T>Read-only connection. Unsaved edits are kept until write access returns.</T>
        </div>
      ) : null}
      {relativePath && !markdownLease && !isPdf && file.data?.readOnly ? (
        <div className="shrink-0 border-b border-border/50 bg-muted/35 px-3 py-1.5 scient-reading-micro text-muted-foreground">
          {/* SCIENT-FORK: the read-only notice in the active language. */}
          {readOnlyNotice(file.data.outsideWorkspace === true, m)}
        </div>
      ) : null}
      {/* SCIENT-FORK:START — only the source text preview uses the byte-limit notice. */}
      {previewPath &&
      attachment === undefined &&
      !markdownLease &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated &&
      !showsLargeText &&
      !showDataGrid ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 scient-reading-micro text-warning-foreground">
          {gt(
            "{count, plural, one {Read-only preview limited to the first 1 MB of a {formatted} byte file.} other {Read-only preview limited to the first 1 MB of a {formatted} byte file.}}",
            { count: file.data.byteLength, formatted: file.data.byteLength.toLocaleString() },
          )}
        </div>
      ) : null}
      {/* SCIENT-FORK:END */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* SCIENT-FORK: the shelf keeps the views of documents left recently. */}
        <ScientDocumentShelf
          className={cn("min-w-0 flex-1 flex-col overflow-hidden", previewPath ? "flex" : "hidden")}
          // While a file this panel saves is being renamed, it takes no edits:
          // a save started now would go to the name that is going away.
          inert={renamingInPlace || undefined}
        >
          {isFolder ? null : relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
              htmlRender={attachment.htmlRender === true}
              threadRef={threadRef}
            />
          ) : // SCIENT-FORK:START — the read failure says why nothing can be shown
          relativePath && blockingReadFailure ? (
            blockingReadFailure // SCIENT-FORK:END
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              workspaceRoot={cwd}
              relativePath={relativePath}
              absolutePath={absolutePath}
              alt={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isPdf && absolutePath && pdfSource ? (
            // SCIENT-FORK: kept hidden for a while once left.
            <ShelfItem shelfKey={documentShelfKey}>
              <ScientSurfaceSuspense>
                <ScientPdfReader
                  key={absolutePath}
                  source={pdfSource}
                  readerScope={threadRef.threadId}
                  refreshKey={viewerRefreshKey}
                  // SCIENT-FORK:START — Ask in chat quotes this PDF into the panel's conversation.
                  citeThread={threadRef}
                  // SCIENT-FORK:END
                />
              </ScientSurfaceSuspense>
            </ShelfItem>
          ) : relativePath && renderBrowserFile && !isPdf && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              title={relativePath}
              workspaceMutationId={workspaceMutationId}
              refreshKey={viewerRefreshKey}
              manualReloadKey={manualReloadKey}
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
            relativePath && isLatexPreviewFile(relativePath) ? (
              <LatexDocumentPreparation />
            ) : (
              withContentFocus(
                <div
                  className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
                  aria-label={gt("Opening editor")}
                />,
                loadingMayOpenEditor,
              )
            )
          ) : // SCIENT-FORK:START — data files open in the paged grid; CSV and TSV keep their text view
          showDataGrid ? (
            <ScientSurfaceSuspense>
              <ScientDataFileTable
                key={`${environmentId}:${absolutePath}`}
                environmentId={environmentId}
                absolutePath={absolutePath}
                name={relativePath.split(/[\\/]/).at(-1) || relativePath}
                threadId={threadRef.threadId}
                workspace={
                  isHostFile ? undefined : { cwd, path: relativePath, onOpenPath: onOpenFile }
                }
                viewSql={savedView !== null ? file.data?.contents : undefined}
                onShowSql={savedView === null ? undefined : () => handleRenderedChange(false)}
                refreshToken={`${workspaceMutationId}:${viewerRefreshKey}`}
                reloadKey={`${manualReloadKey}:${fileRefreshRevision}`}
              />
            </ScientSurfaceSuspense>
          ) : // SCIENT-FORK:END
          // SCIENT-FORK:START — notebooks live on the server, cell by cell, and never load as text
          isProjectNotebook ? (
            <ScientSurfaceSuspense>
              <ScientNotebookSurface
                key={`${environmentId}:${cwd}:${relativePath}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath!}
                threadRef={threadRef}
                fileRevision={`${workspaceMutationId}:${viewerRefreshKey}:${fileRefreshRevision}`}
              />
            </ScientSurfaceSuspense>
          ) : // SCIENT-FORK:END
          relativePath && absolutePath && showsLargeText ? (
            <WorkspaceLargeTextPreview
              key={`${absolutePath}:${renderTable}:${renderMarkdown}:${fileRefreshRevision}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              draftCwd={draft ? cwd : null}
              name={relativePath}
              delimiter={renderTable ? tableDelimiter : null}
              markdownCwd={renderMarkdown ? cwd : null}
              copyContents={copyLargeText}
              preview={file.data?.contents ?? ""}
              sizeBytes={file.data?.byteLength ?? 0}
              onPostRender={onFilePostRender}
              workspaceMutationId={workspaceMutationId}
              refreshKey={viewerRefreshKey}
              revealLine={currentRevealLine}
              revealRequestId={revealRequestId}
              wordWrap={wordWrap}
            />
          ) : relativePath &&
            absolutePath &&
            documentAsset &&
            (isDocument || file.readError?.failure === "binary_file") ? (
            // SCIENT-FORK: an Office reader quotes this file into the panel's conversation, and is
            // kept hidden for a while once left.
            <ShelfItem shelfKey={documentShelfKey}>
              <OfficeFileContext value={{ citeThread: threadRef, cwd, path: relativePath }}>
                {/* SCIENT-FORK: a possible change remounts the preview only when the file changed;
                  a reload the reader asks for always does, so a failed preview can retry. */}
                <ScientFileRevisionBoundary
                  key={`${documentShelfKey}:${documentReloads}`}
                  environmentId={environmentId}
                  resource={documentAsset.resource}
                  refreshToken={`${workspaceMutationId}:${viewerRefreshKey}`}
                >
                  <AttachmentFilePreview
                    name={relativePath.split(/[\\/]/).at(-1) || relativePath}
                    mimeType="application/octet-stream"
                    sizeBytes={0}
                    asset={documentAsset}
                    origin={gt("File", { $context: "label for a file opened from the workspace" })}
                    embedded
                    onSaveCopy={canSaveCopy ? handleSaveCopy : undefined}
                  />
                </ScientFileRevisionBoundary>
                {/* SCIENT-FORK: the end of the Office file context. */}
              </OfficeFileContext>
            </ShelfItem>
          ) : relativePath && file.error && file.data === null ? (
            readFailure
          ) : relativePath && file.data === null ? (
            isLatexPreviewFile(relativePath) ? (
              <LatexDocumentPreparation />
            ) : (
              withContentFocus(
                <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                  <Spinner size="lg" />
                </div>,
                loadingMayOpenEditor,
              )
            )
          ) : relativePath && file.data ? (
            renderMermaid ? (
              <Suspense fallback={<FileSurfaceLoading />}>
                <MermaidFilePreview text={file.data.contents} />
              </Suspense>
            ) : file.data.readOnly || !canWriteFiles ? (
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
                  initialSource={queriedFile.authoritativeData?.contents ?? ""}
                  revision={queriedFile.authoritativeData?.revision ?? ""}
                  {...(queriedFile.authoritativeData?.publicationAttention === undefined
                    ? {}
                    : { publicationAttention: queriedFile.authoritativeData.publicationAttention })}
                  truncated={file.data.truncated}
                  workspaceMutationId={workspaceMutationId}
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
                  threadRef={threadRef}
                  onCite={onCiteFile}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  revealRequestId={revealRequestId}
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
              <ScientSurfaceSuspense fallback={<LatexDocumentPreparation />}>
                <ScientLatexSurface
                  key={`${documentSurfaceKey}:${resolvedTheme}`}
                  onDownloadActions={setLatexDownloads}
                  onRenameContext={setLatexRename}
                  startBar={newDocument.startBar}
                  templateActions={newDocument.templateActions}
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
                  revealLine={currentRevealLine}
                  revealRequestId={revealRequestId}
                  latexPresentationRequest={latexPresentationRequest}
                  threadRef={threadRef}
                  onCite={onCiteFile}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onOpenFileSource={onOpenFileSource}
                  onLatexPresentationRequestHandled={onLatexPresentationRequestHandled}
                />
              </ScientSurfaceSuspense>
            ) : computeSourceLanguage !== null && !file.data.truncated ? (
              withContentFocus(
                <ScientSurfaceSuspense>
                  <ScientComputeFileSurface
                    onEditorChange={handleEditorChangeStable}
                    onCite={onCiteFile}
                    citationReveal={citationRevealActive ? fileCitation : undefined}
                    citationBaseline={file.authoritativeData?.contents}
                    key={`${computeContextId}:${resolvedTheme}`}
                    language={computeSourceLanguage}
                    environmentId={environmentId}
                    threadRef={threadRef}
                    contextId={computeContextId!}
                    cwd={cwd}
                    relativePath={relativePath}
                    composerDraftTarget={composerDraftTarget}
                    contents={file.data.contents}
                    initialSource={queriedFile.authoritativeData?.contents ?? ""}
                    revision={queriedFile.authoritativeData?.revision ?? ""}
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
                </ScientSurfaceSuspense>,
                computeShowsEditor,
              )
            ) : usesScientMarkdownEditor && markdownLease ? (
              <ScientSurfaceSuspense>
                {/* A new document's file name, drawn on its page. */}
                {newDocument.startBar}
                <ScientMarkdownFileSurface
                  key={documentSurfaceKey}
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
              withContentFocus(
                <MarkdownSourceSurface
                  threadRef={threadRef}
                  onCite={onCiteFile}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  key={documentSurfaceKey}
                  persistence={markdownLease}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onEditorChange={handleEditorChangeStable}
                />,
              )
            ) : isMarkdownDocument && renderMarkdown ? (
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                initialSource={queriedFile.authoritativeData?.contents ?? ""}
                revision={queriedFile.authoritativeData?.revision ?? ""}
                truncated={file.data.truncated}
                workspaceMutationId={workspaceMutationId}
                readOnly={file.data.truncated || isHostFile || !canWriteFiles}
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
                threadRef={threadRef}
                onCite={onCiteFile}
                citationReveal={citationRevealActive ? fileCitation : undefined}
                revealRequestId={revealRequestId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : // SCIENT-FORK:END
            isHostFile || !canWriteFiles ? (
              <StaticTextFileSurface
                threadRef={threadRef}
                onCite={onCiteFile}
                citationReveal={citationRevealActive ? fileCitation : undefined}
                revealRequestId={revealRequestId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : (
              withContentFocus(
                <EditableFileSurface
                  threadRef={threadRef}
                  onCite={onCiteFile}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  citationBaseline={file.authoritativeData?.contents}
                  key={`${relativePath}:${resolvedTheme}`}
                  environmentId={environmentId}
                  projectId={projectId}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  initialSource={queriedFile.authoritativeData?.contents ?? ""}
                  revision={queriedFile.authoritativeData?.revision ?? ""}
                  {...(queriedFile.authoritativeData?.publicationAttention === undefined
                    ? {}
                    : { publicationAttention: queriedFile.authoritativeData.publicationAttention })}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onPendingChange={handlePendingChange}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                  onEditorChange={handleEditorChangeStable}
                />,
              )
            )
          ) : null}
        </ScientDocumentShelf>
        {showExplorer ? (
          <FileExplorerPane resizable={Boolean(previewPath)}>
            <div
              className="contents"
              onClick={focusEditorOnTreeRowClickOrEnter}
              onKeyDown={(event) => {
                if (event.key === "Enter") focusEditorOnTreeRowClickOrEnter(event);
              }}
            >
              <FileBrowserPanel
                key={`${environmentId}:${hostFolderPath ?? cwd}`}
                environmentId={environmentId}
                cwd={hostFolderPath ?? cwd}
                projectName={hostFolderPath ?? projectName}
                hostFolder={hostFolderPath !== null}
                selectedPath={
                  hostFolderPath === null
                    ? relativePath
                    : trailChildOf(hostFolderPath, breadcrumbTrail ?? hostFolderPath)
                }
                selectedPathRevealId={revealRequestId}
                onOpenFile={onOpenFile}
                onOpenFileSource={onOpenFileSource}
                answersPanelFind={!previewPath}
                workspaceMutationId={workspaceMutationId}
                // SCIENT-FORK:START — the Files tab's Back and Forward sit in its toolbar
                {...(previewPath === null
                  ? {
                      scientToolbarLeading: (
                        <TabHistoryButtons
                          threadRef={threadRef}
                          surfaceId={scientSurfaceId}
                          keybindings={keybindings}
                        />
                      ),
                    }
                  : {})}
                // SCIENT-FORK:END
                {...(previewPath && !isMedia && !isPdf
                  ? {
                      onRefreshSelectedFile: () => {
                        if (!isDocument) file.refresh();
                        setFileRefreshRevision((value) => value + 1);
                      },
                    }
                  : {})}
              />
            </div>
          </FileExplorerPane>
        ) : null}
      </div>
    </div>
  );
}

function applyExternalProjection(apply: () => void, finish: () => void) {
  try {
    apply();
  } finally {
    finish();
  }
}

// A draft has no thread yet, so its download is scoped to the draft's workspace instead.
function largeFileResource(
  threadRef: ScopedThreadRef,
  absolutePath: string,
  draftCwd: string | null,
): AssetResource {
  return draftCwd === null
    ? {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: absolutePath,
        disposition: "attachment",
      }
    : {
        _tag: "draft-workspace-file",
        cwd: draftCwd,
        path: absolutePath,
        disposition: "attachment",
      };
}

// SCIENT-FORK:START — the header's Save a copy saves this file, so only Copy is added here.
/** Copy for a file past the 1 MB preview, which the panel holds only in its viewer. */
function LargeFileActions(props: {
  name: string;
  copyContents: RefObject<(() => Promise<string>) | null>;
}) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(props.name),
  });
  const showError = (cause: unknown) => {
    toastManager.add({
      type: "error",
      title: gt("Could not read file"),
      description: thrownErrorMessage(cause, m) ?? gt("Try again."),
    });
  };
  return (
    <FileSurfaceAction
      label={isCopied ? gt("Copied") : gt("Copy contents")}
      onPress={() => {
        const copy = props.copyContents.current;
        if (!copy) return;
        void copy()
          .then((text) => copyToClipboard(text, undefined))
          .catch(showError);
      }}
    >
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </FileSurfaceAction>
  );
}
// SCIENT-FORK:END

export function WorkspaceLargeTextPreview(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  absolutePath: string;
  /** The draft's workspace while the thread does not exist yet. */
  draftCwd: string | null;
  name: string;
  delimiter: "," | "\t" | null;
  /** Renders the file as Markdown resolving links against this workspace; null shows source. */
  markdownCwd: string | null;
  copyContents: RefObject<(() => Promise<string>) | null>;
  /** The first megabyte already read, shown until the whole file arrives. */
  preview: string;
  sizeBytes: number;
  onPostRender?: ComponentProps<typeof LargeFilePreview>["onPostRender"];
  workspaceMutationId: string | null;
  refreshKey: number;
  revealLine: number | null;
  revealRequestId: number;
  wordWrap: boolean;
}) {
  const resource = largeFileResource(props.threadRef, props.absolutePath, props.draftCwd);
  const gt = useGT();
  const [revision, setRevision] = useState(0);
  const showError = (cause: unknown) => {
    toastManager.add({
      type: "error",
      title: gt("Could not read file"),
      description: thrownErrorMessage(cause, m) ?? gt("Try again."),
    });
  };
  // Each workspace mutation re-mints the URL, so an edited file loads its new bytes.
  // SCIENT-FORK:START — the existing watcher invalidates the bounded reader too.
  const assetUrl = useAssetUrlState(
    props.environmentId,
    resource,
    `${props.workspaceMutationId ?? ""}:${props.refreshKey}`,
  );
  // SCIENT-FORK:END
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const contentRevision = JSON.stringify([
    props.environmentId,
    resource,
    assetUrl._tag === "Success" ? (assetUrl.fileRevision ?? props.workspaceMutationId) : null,
    props.refreshKey,
    revision,
  ]);
  const [loaded, setLoaded] = useState<{ revision: string; url: string } | null>(null);
  if (assetUrl._tag === "Success" && loaded?.revision !== contentRevision) {
    setLoaded({ revision: contentRevision, url: assetUrl.url });
  }
  if (assetUrl._tag === "Failure")
    return (
      <FileSurfaceFailure
        title={gt("Couldn't open this file")}
        description={gt("Scient couldn't load this file.")}
        onRetry={() => {
          setRevision((value) => value + 1);
          void refreshAssetUrl().catch(showError);
        }}
      />
    );
  if (assetUrl._tag !== "Success" || loaded === null) return <FileSurfaceLoading />;
  const src = `${loaded.url}${loaded.url.includes("?") ? "&" : "?"}revision=${encodeURIComponent(loaded.revision)}`;
  const retry = () => {
    void refreshAssetUrl()
      .then(() => setRevision((value) => value + 1))
      .catch(showError);
  };
  return (
    <LargeFilePreview
      key={`${src}:${revision}`}
      src={src}
      name={props.name}
      preview={props.preview}
      sizeBytes={props.sizeBytes}
      delimiter={props.delimiter}
      markdownCwd={props.markdownCwd}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
      copyContents={props.copyContents}
      onRetry={retry}
      onPostRender={props.onPostRender}
      revealLine={props.revealLine}
      revealRequestId={props.revealRequestId}
      wordWrap={props.wordWrap}
    />
  );
}
