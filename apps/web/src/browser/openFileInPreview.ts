import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspacePdfPreviewPath,
} from "@t3tools/shared/filePreview";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useHtmlPdfSourceStore } from "~/scient/documentExport/htmlPdfSourceStore";

export const isBrowserPreviewFile = isWorkspaceBrowserPreviewPath;

export function isTrackableWorkspaceHtml(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) && !isWorkspacePdfPreviewPath(path);
}

/**
 * HTML workspace links keep T3's browser-first behavior. PDF links instead
 * mount the Scient file surface, which owns the range-aware PDF reader. Users
 * can still explicitly open a PDF in the integrated browser from that surface.
 */
export function resolveWorkspaceFileLinkOpenTarget(path: string): "browser" | "file" {
  return isWorkspaceBrowserPreviewPath(path) && !isWorkspacePdfPreviewPath(path)
    ? "browser"
    : "file";
}

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export function workspaceFilePreviewAssetResource(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
}): AssetResource {
  return {
    _tag: "workspace-file",
    cwd: input.workspaceRoot,
    relativePath: input.relativePath,
    // Retain the legacy pair so this client can still open persisted-thread
    // previews when it is connected to an older server.
    threadId: input.threadRef.threadId,
    path: input.filePath,
  };
}

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly onOpened?: (snapshot: PreviewSessionSnapshot) => void;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
    input.onOpened?.(snapshot);
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, AssetError | PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: workspaceFilePreviewAssetResource(input),
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
    onOpened: (snapshot) => {
      if (!isTrackableWorkspaceHtml(input.relativePath)) return;
      useHtmlPdfSourceStore.getState().bind({
        threadRef: input.threadRef,
        tabId: snapshot.tabId,
        authorizedUrl: assetUrl,
        source: {
          _tag: "workspace-html",
          environmentId: input.threadRef.environmentId,
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
          absolutePath: assetResult.value.sourcePath ?? input.filePath,
        },
      });
    },
  });
}
