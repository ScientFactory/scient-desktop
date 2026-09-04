import type {
  DiscoveredLocalServer,
  ProjectScript,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

export interface ProjectScriptPreviewRequest {
  readonly requestedUrl: string;
  readonly resolvedUrl: string;
  readonly localServerKey: string | null;
}

export type ProjectScriptAutoPreviewPlan =
  | { readonly kind: "ignore" }
  | { readonly kind: "focus"; readonly tabId: string }
  | { readonly kind: "open"; readonly request: ProjectScriptPreviewRequest }
  | { readonly kind: "wait"; readonly request: ProjectScriptPreviewRequest };

type PreviewSessions = Readonly<Record<string, PreviewSessionSnapshot>>;

export interface ProjectScriptPreviewWaitBaseline {
  readonly sessionIds: ReadonlyArray<string>;
  readonly visibleTabId: string | null;
  readonly visibleTabUrl: string | null;
}

export function isCurrentProjectScriptPreviewLaunch(
  activeThreadRef: ScopedThreadRef | null,
  launchThreadRef: ScopedThreadRef,
): boolean {
  return (
    activeThreadRef !== null &&
    scopedThreadKey(activeThreadRef) === scopedThreadKey(launchThreadRef)
  );
}

export function resolveProjectScriptPreviewRequest(
  threadRef: ScopedThreadRef,
  rawUrl: string,
): ProjectScriptPreviewRequest {
  const requestedUrl = normalizePreviewUrl(rawUrl);
  return {
    requestedUrl,
    // This URL belongs to a script on the selected environment, not an address-bar navigation.
    resolvedUrl: resolveDiscoveredServerUrl(threadRef.environmentId, requestedUrl),
    localServerKey: localPreviewUrlKey(requestedUrl),
  };
}

export function planProjectScriptAutoPreview(input: {
  readonly script: Pick<ProjectScript, "autoOpenPreview" | "previewUrl">;
  readonly previewSupported: boolean;
  readonly sessions: PreviewSessions;
  readonly resolveRequest: () => ProjectScriptPreviewRequest;
}): ProjectScriptAutoPreviewPlan {
  if (!input.previewSupported || !input.script.autoOpenPreview || !input.script.previewUrl) {
    return { kind: "ignore" };
  }

  const request = input.resolveRequest();
  const reusableTabId = findReusableProjectScriptPreviewTab(input.sessions, request.resolvedUrl);
  if (reusableTabId !== null) {
    return { kind: "focus", tabId: reusableTabId };
  }
  return request.localServerKey === null ? { kind: "open", request } : { kind: "wait", request };
}

export function findReusableProjectScriptPreviewTab(
  sessions: PreviewSessions,
  resolvedUrl: string,
): string | null {
  const targetUrl = comparablePreviewUrl(resolvedUrl);
  if (targetUrl === null) return null;

  for (const snapshot of Object.values(sessions)) {
    const status = snapshot.navStatus;
    if (status._tag !== "Loading" && status._tag !== "Success") continue;
    if (comparablePreviewUrl(status.url) === targetUrl) return snapshot.tabId;
  }
  return null;
}

export function isProjectScriptPreviewServerReady(
  request: ProjectScriptPreviewRequest,
  servers: ReadonlyArray<DiscoveredLocalServer>,
): boolean {
  return (
    request.localServerKey !== null &&
    servers.some((server) => previewServerKey(server.host, server.port) === request.localServerKey)
  );
}

export function captureProjectScriptPreviewWaitBaseline(
  sessions: PreviewSessions,
  activeTabId: string | null,
): ProjectScriptPreviewWaitBaseline {
  const sessionIds = Object.keys(sessions).toSorted();
  const visibleTabId =
    activeTabId !== null && sessions[activeTabId] ? activeTabId : (sessionIds[0] ?? null);
  return {
    sessionIds,
    visibleTabId,
    visibleTabUrl: visibleTabId ? previewSessionUrl(sessions[visibleTabId]) : null,
  };
}

/**
 * A delayed launch may focus its preview only while the Browser surface the
 * launch exposed is still selected and the user has not changed its tab set
 * or visible URL. Status, title, resize, and timestamp updates are runtime
 * noise and deliberately do not cancel the launch.
 */
export function shouldCancelProjectScriptPreviewWait(input: {
  readonly baseline: ProjectScriptPreviewWaitBaseline;
  readonly sessions: PreviewSessions;
  /** `undefined` means the panel is closed or a non-Browser surface is selected. */
  readonly activePreviewTabId: string | null | undefined;
}): boolean {
  if (input.activePreviewTabId !== input.baseline.visibleTabId) return true;

  const currentSessionIds = Object.keys(input.sessions).toSorted();
  if (
    currentSessionIds.length !== input.baseline.sessionIds.length ||
    currentSessionIds.some((tabId, index) => tabId !== input.baseline.sessionIds[index])
  ) {
    return true;
  }

  const visibleTabId = input.baseline.visibleTabId;
  return (
    visibleTabId !== null &&
    previewSessionUrl(input.sessions[visibleTabId]) !== input.baseline.visibleTabUrl
  );
}

export async function openProjectScriptPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: ProjectScriptPreviewRequest;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<PreviewSessionSnapshot, E>> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: input.request.resolvedUrl,
  });
  if (result._tag === "Success") {
    recordVisitForThread(input.threadRef, input.request.requestedUrl);
    useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
  }
  return result;
}

function comparablePreviewUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (isLoopbackHost(parsed.hostname)) parsed.hostname = "localhost";
    return parsed.href;
  } catch {
    return null;
  }
}

function previewSessionUrl(snapshot: PreviewSessionSnapshot | undefined): string | null {
  if (!snapshot || snapshot.navStatus._tag === "Idle") return null;
  return comparablePreviewUrl(snapshot.navStatus.url) ?? snapshot.navStatus.url;
}

function localPreviewUrlKey(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : parsed.protocol === "https:"
          ? 443
          : null;
    return port === null ? null : previewServerKey(parsed.hostname, port);
  } catch {
    return null;
  }
}

function previewServerKey(host: string, port: number): string {
  const normalizedHost = host.toLowerCase();
  return `${isLoopbackHost(normalizedHost) ? "loopback" : normalizedHost}:${port}`;
}
