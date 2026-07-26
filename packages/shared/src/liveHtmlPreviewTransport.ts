// FILE: liveHtmlPreviewTransport.ts
// Purpose: Owns additive local-HTML live-preview transport outside released migration contracts.
// Layer: Shared desktop/web runtime overlay

import {
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectPrepareHtmlArtifactPreviewResult,
  TrimmedNonEmptyString,
  WsRpcError,
  WsRpcGroup,
} from "@synara/contracts";
import type {
  BrowserOpenInput,
  BrowserNewTabInput,
  DesktopBridge,
  NativeApi,
  ThreadBrowserState,
  ThreadId,
} from "@synara/contracts";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

declare module "@synara/contracts" {
  interface BrowserTabState {
    /** Authority root used to re-prepare a source-backed local HTML preview. */
    previewCwd?: string;
    /** Set while a watched source revision is waiting to be re-prepared. */
    sourceChanged?: boolean;
    /** Monotonic filesystem generation used to consume one automatic refresh once. */
    sourceChangeGeneration?: number;
    /** Canonical server-established identity for source deduplication and replacement. */
    sourceIdentity?: string;
    /** Canonical server-established root that bounds dependency watches. */
    sourceRoot?: string;
    /** True when automatic dependency refresh is operating with a bounded watch set. */
    sourceWatchLimited?: boolean;
    /** One of the bounded session slots used for atomic local-HTML replacement. */
    previewSessionSlot?: 0 | 1;
  }

  interface BrowserOpenInput {
    previewCwd?: string;
    watchedPaths?: readonly string[];
    sourceIdentity?: string;
    sourceRoot?: string;
  }

  interface BrowserNewTabInput {
    previewCwd?: string;
    watchedPaths?: readonly string[];
    sourceIdentity?: string;
    sourceRoot?: string;
  }
}

export interface BrowserReplaceLocalHtmlPreviewInput {
  threadId: ThreadId;
  tabId: string;
  url: string;
  displayUrl: string;
  previewCwd: string;
  sourceIdentity?: string;
  sourceRoot?: string;
  watchedPaths: readonly string[];
  allowedExternalUrls?: readonly string[];
  activate?: boolean;
}

export const LIVE_HTML_PREVIEW_PREPARE_V1_METHOD = "scient.liveHtmlPreview.prepare.v1";

export const LiveHtmlPreviewPrepareResult = Schema.Struct({
  ...ProjectPrepareHtmlArtifactPreviewResult.fields,
  sourceIdentity: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  sourceRoot: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  watchedPaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  ),
});
export type LiveHtmlPreviewPrepareResult = typeof LiveHtmlPreviewPrepareResult.Type;

export const LiveHtmlPreviewPrepareRpc = Rpc.make(LIVE_HTML_PREVIEW_PREPARE_V1_METHOD, {
  payload: ProjectPrepareHtmlArtifactPreviewInput,
  success: LiveHtmlPreviewPrepareResult,
  error: WsRpcError,
});

export const LiveHtmlPreviewRpcGroup = WsRpcGroup.add(LiveHtmlPreviewPrepareRpc);

type LiveHtmlBrowserApi<T extends NativeApi["browser"] | DesktopBridge["browser"]> = T & {
  replaceLocalHtmlPreview: (
    input: BrowserReplaceLocalHtmlPreviewInput,
  ) => Promise<ThreadBrowserState>;
};

export type LiveHtmlNativeApi = Omit<NativeApi, "browser" | "projects"> & {
  browser: LiveHtmlBrowserApi<NativeApi["browser"]>;
  projects: NativeApi["projects"] & {
    prepareLiveHtmlPreview: (
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
