// FILE: liveHtmlPreviewTransport.ts
// Purpose: Owns additive local-HTML live-preview transport outside released migration contracts.
// Layer: Shared desktop/web runtime overlay

import type {
  BrowserOpenInput,
  BrowserNewTabInput,
  DesktopBridge,
  NativeApi,
  ProjectPrepareHtmlArtifactPreviewResult,
  ThreadBrowserState,
  ThreadId,
} from "@synara/contracts";

declare module "@synara/contracts" {
  interface BrowserTabState {
    /** Authority root used to re-prepare a source-backed local HTML preview. */
    previewCwd?: string;
    /** Set while a watched source revision is waiting to be re-prepared. */
    sourceChanged?: boolean;
  }

  interface BrowserOpenInput {
    previewCwd?: string;
    watchedPaths?: readonly string[];
  }

  interface BrowserNewTabInput {
    previewCwd?: string;
    watchedPaths?: readonly string[];
  }
}

export interface BrowserReplaceLocalHtmlPreviewInput {
  threadId: ThreadId;
  tabId: string;
  url: string;
  displayUrl: string;
  previewCwd: string;
  watchedPaths: readonly string[];
  allowedExternalUrls?: readonly string[];
  activate?: boolean;
}

export type LiveHtmlPreviewPrepareResult = ProjectPrepareHtmlArtifactPreviewResult & {
  watchedPaths?: readonly string[];
};

type LiveHtmlBrowserApi<T extends NativeApi["browser"] | DesktopBridge["browser"]> = T & {
  replaceLocalHtmlPreview: (
    input: BrowserReplaceLocalHtmlPreviewInput,
  ) => Promise<ThreadBrowserState>;
};

export type LiveHtmlNativeApi = Omit<NativeApi, "browser" | "projects"> & {
  browser: LiveHtmlBrowserApi<NativeApi["browser"]>;
  projects: Omit<NativeApi["projects"], "prepareHtmlArtifactPreview"> & {
    prepareHtmlArtifactPreview: (
      input: Parameters<NativeApi["projects"]["prepareHtmlArtifactPreview"]>[0],
    ) => Promise<LiveHtmlPreviewPrepareResult>;
  };
};

export type LiveHtmlDesktopBridge = Omit<DesktopBridge, "browser"> & {
  browser: LiveHtmlBrowserApi<DesktopBridge["browser"]>;
};

export function asLiveHtmlNativeApi(api: NativeApi): LiveHtmlNativeApi {
  return api as LiveHtmlNativeApi;
}

export function asLiveHtmlDesktopBridge(bridge: DesktopBridge): LiveHtmlDesktopBridge {
  return bridge as LiveHtmlDesktopBridge;
}

export type LiveHtmlBrowserOpenInput = BrowserOpenInput;
export type LiveHtmlBrowserNewTabInput = BrowserNewTabInput;
