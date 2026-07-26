// FILE: browserManager.ts
// Purpose: Owns the desktop in-app browser runtime and maps thread/tab state onto Electron views.
// Layer: Desktop runtime manager
// Depends on: Electron BrowserWindow/WebContentsView, shared browser IPC contracts

import * as Crypto from "node:crypto";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  nativeImage,
  session,
  shell,
  webContents as electronWebContents,
  WebContentsView,
} from "electron";
import type { WebContents } from "electron";
import {
  artifactPreviewNavigationAllowed,
  artifactPreviewRequestAllowed,
} from "./artifactPreviewPolicy";
import { loadBrowserRuntimeUrl } from "./browserRuntimeLoad";
import {
  localHtmlPreviewNavigationDisposition,
  localHtmlPreviewRequestAllowed,
  localHtmlPreviewResolvedAddressesAllowed,
} from "./localHtmlPreviewPolicy";
import type {
  BrowserAttachWebviewInput,
  BrowserCaptureScreenshotResult,
  BrowserCopyLinkEvent,
  BrowserDetachWebviewInput,
  BrowserExecuteCdpInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserPanelBounds,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserTabKind,
  BrowserTabState,
  BrowserThreadInput,
  ThreadBrowserState,
  ThreadId,
} from "@synara/contracts";
import { isBrowserCopyLinkChord } from "@synara/shared/browserShortcuts";
import {
  serializeLocalHtmlCapabilityAuthority,
  type BrowserReplaceLocalHtmlPreviewInput,
} from "@synara/shared/liveHtmlPreviewTransport";
import {
  BROWSER_BLANK_URL as ABOUT_BLANK_URL,
  BROWSER_WEB_SESSION_PARTITION,
  browserSessionPartition,
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  classifyBrowserWindowOpen,
  deriveChromeUserAgent,
  isBlankBrowserTabUrl,
  normalizeBrowserUrlInput as normalizeUrlInput,
  resolveCopyableBrowserTabUrl,
} from "@synara/shared/browserSession";

const BROWSER_SESSION_PARTITION = BROWSER_WEB_SESSION_PARTITION;
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS = 1_500;
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS = 400;
const BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD = 1;
const BROWSER_THREAD_SUSPEND_DELAY_MS = 30_000;
const BROWSER_ERROR_ABORTED = -3;
const LOCAL_HTML_DEFAULT_CANVAS_SCRIPT = `(() => {
  const isTransparent = (value) =>
    value === "transparent" || value === "rgba(0, 0, 0, 0)";
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;
  if (
    isTransparent(getComputedStyle(root).backgroundColor) &&
    isTransparent(getComputedStyle(body).backgroundColor)
  ) {
    root.style.backgroundColor = "#ffffff";
  }
})()`;

type BrowserStateListener = (state: ThreadBrowserState) => void;
type BrowserCopyLinkListener = (event: BrowserCopyLinkEvent) => void;
interface LocalHtmlSourceWatch {
  readonly watchers: FSWatcher[];
  ownerTabId: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingLocalHtmlReplacement {
  readonly input: BrowserReplaceLocalHtmlPreviewInput;
  readonly promise: Promise<ThreadBrowserState>;
  readonly resolve: (state: ThreadBrowserState) => void;
  readonly reject: (error: unknown) => void;
}

interface LiveTabRuntime {
  key: string;
  threadId: ThreadId;
  tabId: string;
  webContents: WebContents;
  view: WebContentsView | null;
  ownsWebContents: boolean;
  listenerDisposers: Array<() => void>;
}

interface OAuthPopupContext {
  threadId: ThreadId;
  tabId: string;
}

interface OAuthPopupRuntime extends OAuthPopupContext {
  window: BrowserWindow;
  listenerDisposers: Array<() => void>;
}

interface NativeBrowserViewVisibility {
  setVisible?: (visible: boolean) => void;
}

interface PendingRuntimeSync {
  threadId: ThreadId;
  tabId: string;
  faviconUrls?: string[];
}

interface ProvisionalLocalHtmlRuntime {
  threadId: ThreadId;
  sourceTabId: string;
  replacementTaskKey: string;
  tab: BrowserTabState;
}

const LIVE_TAB_STATUS: BrowserTabState["status"] = "live";
const SUSPENDED_TAB_STATUS: BrowserTabState["status"] = "suspended";
const MAX_LOCAL_HTML_WATCH_DIRECTORIES_PER_TAB = 64;
const MAX_LOCAL_HTML_WATCH_DIRECTORIES_TOTAL = 256;
const LOCAL_HTML_REPLACEMENT_TIMEOUT_MS = 15_000;

function safeUrlOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizedLocalHtmlExternalUrls(values: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values?.slice(0, 250) ?? []) {
    if (value.length > 8_192) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      normalized.add(url.toString());
    } catch {
      // Ignore malformed renderer input at the desktop trust boundary.
    }
  }
  return [...normalized];
}

function normalizedLocalHtmlSourcePath(value: string | null | undefined): string | null {
  if (!value?.trim() || !Path.isAbsolute(value)) {
    return null;
  }
  const normalized = Path.normalize(value.trim());
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function canonicalLocalHtmlSourcePath(value: string | null | undefined): string | null {
  const normalized = normalizedLocalHtmlSourcePath(value);
  if (!normalized) return null;
  try {
    return normalizedLocalHtmlSourcePath(realpathSync.native(normalized));
  } catch {
    try {
      const canonicalParent = realpathSync.native(Path.dirname(normalized));
      return normalizedLocalHtmlSourcePath(Path.join(canonicalParent, Path.basename(normalized)));
    } catch {
      return normalized;
    }
  }
}

function validatePreparedLocalHtmlSourceAuthority(input: {
  displayUrl: string | null | undefined;
  sourceIdentity: string | null | undefined;
  sourceRoot: string | null | undefined;
}): { sourceIdentity: string; sourceRoot: string } {
  const preparedSourceIdentity = normalizedLocalHtmlSourcePath(input.sourceIdentity);
  const preparedSourceRoot = normalizedLocalHtmlSourcePath(input.sourceRoot);
  const currentDisplayIdentity = canonicalLocalHtmlSourcePath(input.displayUrl);
  const currentPreparedIdentity = canonicalLocalHtmlSourcePath(input.sourceIdentity);
  const currentPreparedRoot = canonicalLocalHtmlSourcePath(input.sourceRoot);
  if (!preparedSourceIdentity || !preparedSourceRoot) {
    throw new Error("The local HTML preview is missing its prepared source authority.");
  }
  if (
    currentDisplayIdentity !== preparedSourceIdentity ||
    currentPreparedIdentity !== preparedSourceIdentity ||
    currentPreparedRoot !== preparedSourceRoot ||
    !isPathInside(preparedSourceIdentity, preparedSourceRoot)
  ) {
    throw new Error("The local HTML preview source identity changed after preparation.");
  }
  return { sourceIdentity: preparedSourceIdentity, sourceRoot: preparedSourceRoot };
}

function isSameLocalHtmlSource(left: BrowserTabState, right: BrowserTabState): boolean {
  if (left.kind !== "local-html" || right.kind !== "local-html") {
    return false;
  }
  const leftSourceIdentity = canonicalLocalHtmlSourcePath(left.sourceIdentity);
  const rightSourceIdentity = canonicalLocalHtmlSourcePath(right.sourceIdentity);
  if (leftSourceIdentity && rightSourceIdentity) {
    return leftSourceIdentity === rightSourceIdentity;
  }
  const leftDisplayUrl = normalizedLocalHtmlSourcePath(left.sourceIdentity ?? left.displayUrl);
  const rightDisplayUrl = normalizedLocalHtmlSourcePath(right.sourceIdentity ?? right.displayUrl);
  const leftPreviewCwd = normalizedLocalHtmlSourcePath(left.previewCwd);
  const rightPreviewCwd = normalizedLocalHtmlSourcePath(right.previewCwd);
  return (
    leftDisplayUrl !== null &&
    leftDisplayUrl === rightDisplayUrl &&
    leftPreviewCwd !== null &&
    leftPreviewCwd === rightPreviewCwd
  );
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = Path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
}

function isLocalHtmlPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || !url.port) return false;
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    return (
      hostname === "127.0.0.1" ||
      (hostname.startsWith("g-") && hostname.endsWith(".preview.localhost"))
    );
  } catch {
    return false;
  }
}

function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameLocalHtmlReplacementInput(
  left: BrowserReplaceLocalHtmlPreviewInput,
  right: BrowserReplaceLocalHtmlPreviewInput,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.tabId === right.tabId &&
    left.url === right.url &&
    left.displayUrl === right.displayUrl &&
    left.previewCwd === right.previewCwd &&
    left.sourceIdentity === right.sourceIdentity &&
    left.sourceRoot === right.sourceRoot &&
    left.watchDiscoveryLimited === right.watchDiscoveryLimited &&
    left.activate === right.activate &&
    sameStringList(left.watchedPaths, right.watchedPaths) &&
    sameStringList(left.allowedExternalUrls, right.allowedExternalUrls)
  );
}

interface BrowserPerformanceSnapshot {
  counters: {
    setPanelBoundsCalls: number;
    setPanelBoundsNoopSkips: number;
    setPanelBoundsViewportUpdates: number;
    stateEmitCalls: number;
    stateEmitSkips: number;
    stateCloneCount: number;
    runtimeSyncQueueFlushes: number;
    syncRuntimeStateCalls: number;
    inactiveTabSuspendScheduled: number;
    inactiveTabSuspendCancelled: number;
    inactiveTabBudgetEvictions: number;
    warmInactiveRuntimeCount: number;
  };
  trackedProcessIds: number[];
}

export interface BrowserUseSnapshot {
  threadId: ThreadId;
  state: ThreadBrowserState;
}

export interface BrowserUseCdpEvent {
  method: string;
  params?: unknown;
}

function createBrowserTab(
  url = ABOUT_BLANK_URL,
  kind: BrowserTabKind = "web",
  displayUrl?: string,
  allowedExternalUrls?: readonly string[],
  previewCwd?: string,
  previewSessionSlot: 0 | 1 = 0,
  sourceIdentity?: string,
  sourceRoot?: string,
): BrowserTabState {
  const sourceAuthority =
    kind === "local-html"
      ? validatePreparedLocalHtmlSourceAuthority({ displayUrl, sourceIdentity, sourceRoot })
      : null;
  return {
    id: Crypto.randomUUID(),
    kind,
    url,
    displayUrl: displayUrl?.trim() || null,
    ...(kind === "local-html" && previewCwd?.trim()
      ? {
          previewCwd: previewCwd.trim(),
          previewSessionSlot,
          sourceChangeGeneration: 0,
          ...(sourceAuthority ?? {}),
        }
      : {}),
    title: defaultTitleForUrl(url),
    status: SUSPENDED_TAB_STATUS,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: null,
    lastError: null,
    ...(kind === "local-html" && allowedExternalUrls
      ? {
          allowedExternalUrls: normalizedLocalHtmlExternalUrls(allowedExternalUrls),
        }
      : {}),
  };
}

function previewSessionPartitionForTab(threadId: ThreadId, tab: BrowserTabState): string {
  if (
    tab.kind === "local-html" &&
    tab.previewSessionSlot !== undefined &&
    tab.displayUrl &&
    tab.previewCwd
  ) {
    const sourceIdentity = `${threadId}\0${normalizedLocalHtmlSourcePath(tab.previewCwd)}\0${normalizedLocalHtmlSourcePath(tab.sourceIdentity ?? tab.displayUrl)}`;
    const sourceHash = Crypto.createHash("sha256")
      .update(sourceIdentity)
      .digest("hex")
      .slice(0, 24);
    return `scient-local-html-preview-${threadId}-${sourceHash}-${tab.previewSessionSlot}`;
  }
  return browserSessionPartition(tab.kind, threadId, tab.id);
}

function defaultThreadBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function cloneThreadState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function defaultTitleForUrl(url: string): string {
  if (url === ABOUT_BLANK_URL) {
    return "New tab";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function screenshotFileNameForUrl(url: string): string {
  const fallback = "browser";
  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();
    const normalizedHost = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${normalizedHost || fallback}-${Date.now()}.png`;
  } catch {
    return `${fallback}-${Date.now()}.png`;
  }
}

function normalizeBounds(bounds: BrowserPanelBounds | null): BrowserPanelBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width,
    height,
  };
}

function mapBrowserLoadError(errorCode: number): string {
  switch (errorCode) {
    case -102:
      return "Connection refused.";
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return "This page took too long to respond.";
    case -137:
      return "A secure connection couldn't be established.";
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return "Couldn't open this page.";
  }
}

function buildRuntimeKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}:${tabId}`;
}

function buildLocalHtmlReplacementKey(input: BrowserReplaceLocalHtmlPreviewInput): string {
  const normalizedPreviewCwd = normalizedLocalHtmlSourcePath(input.previewCwd);
  const normalizedDisplayUrl = normalizedLocalHtmlSourcePath(
    input.sourceIdentity ?? input.displayUrl,
  );
  if (!normalizedPreviewCwd || !normalizedDisplayUrl) {
    return buildRuntimeKey(input.threadId, input.tabId);
  }
  return `${input.threadId}\0${normalizedPreviewCwd}\0${normalizedDisplayUrl}`;
}

function createPendingLocalHtmlReplacement(
  input: BrowserReplaceLocalHtmlPreviewInput,
): PendingLocalHtmlReplacement {
  let resolve!: (state: ThreadBrowserState) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ThreadBrowserState>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { input, promise, resolve, reject };
}

function browserBoundsSignature(bounds: BrowserPanelBounds | null): string {
  if (!bounds) {
    return "hidden";
  }

  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export class DesktopBrowserManager {
  private readonly localHtmlCapabilityKey: string | null;
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private activeBoundsThreadId: ThreadId | null = null;
  private attachedRuntimeKey: string | null = null;
  private attachedBoundsSignature: string | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly threadVersionById = new Map<ThreadId, number>();
  private readonly snapshotCacheByThreadId = new Map<
    ThreadId,
    { version: number; snapshot: ThreadBrowserState }
  >();
  private readonly lastEmittedVersionByThreadId = new Map<ThreadId, number>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly runtimeLastActiveAtByKey = new Map<string, number>();
  private readonly pendingRuntimeSyncs = new Map<string, PendingRuntimeSync>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly copyLinkListeners = new Set<BrowserCopyLinkListener>();
  private readonly localHtmlSourceWatches = new Map<string, LocalHtmlSourceWatch>();
  private readonly pendingLocalHtmlHttpErrors = new Map<number, number>();
  private readonly localHtmlReplacementTasks = new Map<string, Promise<void>>();
  private readonly localHtmlReplacementCurrentInputs = new Map<
    string,
    PendingLocalHtmlReplacement
  >();
  private readonly localHtmlReplacementQueuedInputs = new Map<
    string,
    PendingLocalHtmlReplacement
  >();
  private readonly provisionalLocalHtmlRuntimes = new Map<string, ProvisionalLocalHtmlRuntime>();
  // OAuth/sign-in popups opened by pages via `window.open`. Tracked so they can be sized over
  // the panel and torn down cleanly without leaking native windows.
  private readonly popupRuntimes = new Map<BrowserWindow, OAuthPopupRuntime>();
  private spoofedUserAgent: string | null = null;
  private sessionConfigured = false;
  private readonly previewSessionsConfigured = new Set<string>();
  private readonly previewSessionReady = new Map<string, Promise<Error | null>>();
  private readonly previewSessionRetries = new Set<string>();
  private readonly previewSessionOwnerIds = new Map<string, Set<number>>();
  private readonly previewSessionRetireRequested = new Set<string>();
  private readonly previewSessionCleanupPromises = new Map<string, Promise<void>>();
  private readonly previewSessionAvailabilityWaiters = new Map<string, Set<() => void>>();
  private readonly previewSessionRetirementFinalizers = new Map<number, () => void>();
  private readonly occludedThreads = new Set<ThreadId>();
  private readonly tabSuspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private runtimeSyncFlushScheduled = false;
  private readonly perfCounters = {
    setPanelBoundsCalls: 0,
    setPanelBoundsNoopSkips: 0,
    setPanelBoundsViewportUpdates: 0,
    stateEmitCalls: 0,
    stateEmitSkips: 0,
    stateCloneCount: 0,
    runtimeSyncQueueFlushes: 0,
    syncRuntimeStateCalls: 0,
    inactiveTabSuspendScheduled: 0,
    inactiveTabSuspendCancelled: 0,
    inactiveTabBudgetEvictions: 0,
    warmInactiveRuntimeCount: 0,
  };

  constructor(localHtmlCapabilityKey?: string) {
    this.localHtmlCapabilityKey = localHtmlCapabilityKey?.trim() || null;
  }

  private requireLocalHtmlCapability(input: {
    readonly url: string;
    readonly displayUrl: string | null | undefined;
    readonly sourceIdentity: string | null | undefined;
    readonly sourceRoot: string | null | undefined;
    readonly watchedPaths: readonly string[] | undefined;
    readonly allowedExternalUrls: readonly string[] | undefined;
    readonly localHtmlCapabilityProof: string | null | undefined;
  }): void {
    const sourceAuthority = validatePreparedLocalHtmlSourceAuthority(input);
    const suppliedProof = input.localHtmlCapabilityProof?.trim();
    if (!this.localHtmlCapabilityKey || !suppliedProof) {
      throw new Error("The local HTML preview is missing its server-issued capability proof.");
    }
    if (suppliedProof.length > 256) {
      throw new Error("The local HTML preview capability proof is invalid.");
    }
    const expectedProof = Crypto.createHmac("sha256", this.localHtmlCapabilityKey)
      .update(
        serializeLocalHtmlCapabilityAuthority({
          previewUrl: input.url,
          sourceIdentity: sourceAuthority.sourceIdentity,
          sourceRoot: sourceAuthority.sourceRoot,
          watchedPaths: input.watchedPaths ?? [],
          allowedExternalUrls: input.allowedExternalUrls ?? [],
        }),
      )
      .digest();
    let suppliedProofBytes: Buffer;
    try {
      suppliedProofBytes = Buffer.from(suppliedProof, "base64url");
    } catch {
      throw new Error("The local HTML preview capability proof is invalid.");
    }
    if (
      suppliedProofBytes.length !== expectedProof.length ||
      !Crypto.timingSafeEqual(suppliedProofBytes, expectedProof)
    ) {
      throw new Error("The local HTML preview capability proof is invalid.");
    }
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      const bounds = this.activeThreadId
        ? this.getVisibleBoundsForThread(this.activeThreadId)
        : null;
      if (this.activeThreadId && bounds) {
        this.attachActiveTab(this.activeThreadId, bounds);
      }
      return;
    }

    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.closeAllPopupWindows();
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCopyLink(listener: BrowserCopyLinkListener): () => void {
    this.copyLinkListeners.add(listener);
    return () => {
      this.copyLinkListeners.delete(listener);
    };
  }

  // Desktop Chrome UA with the Electron/app product tokens stripped. Computed once from the
  // running build so the Chrome version stays accurate instead of drifting against a hardcoded
  // string. Centralized here (and in `@synara/shared/browserSession`) so every browser
  // surface presents the same identity.
  private resolveSpoofedUserAgent(): string {
    if (this.spoofedUserAgent === null) {
      this.spoofedUserAgent = deriveChromeUserAgent(app.userAgentFallback, [app.getName()]);
    }
    return this.spoofedUserAgent;
  }

  // Applies the spoofed UA to the shared persistent partition once. Every webContents in that
  // session (native tabs, the adopted renderer <webview>, and OAuth popups) then inherits it,
  // so we avoid duplicating the UA string across the desktop/web surfaces.
  private ensureSessionConfigured(): void {
    if (this.sessionConfigured) {
      return;
    }
    this.sessionConfigured = true;
    try {
      const partitionSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      const userAgent = this.resolveSpoofedUserAgent();
      partitionSession.setUserAgent(userAgent);

      // `setUserAgent` fixes navigator.userAgent + the UA request header, but NOT the
      // User-Agent Client Hints (`sec-ch-ua*`), which still leak the Electron brand. OAuth
      // providers read those, so rewrite them (and Accept-Language) to a real desktop Chrome on
      // every request in this partition — the same technique the Codex desktop app uses.
      const clientHints = buildChromeClientHints(userAgent, process.platform);
      const acceptLanguage = buildAcceptLanguageHeader(app.getPreferredSystemLanguages());
      partitionSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = withRequestHeadersCaseInsensitive(details.requestHeaders, {
          "User-Agent": userAgent,
          ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}),
          ...(clientHints ?? {}),
        });
        callback({ requestHeaders });
      });
    } catch {
      // If the session can't be configured yet, leave it for the per-webContents fallback.
      this.sessionConfigured = false;
    }
  }

  private ensurePreviewSessionConfigured(
    partition: string,
    preview?: {
      kind: "artifact" | "local-html";
      origin: string;
      allowedExternalUrls?: readonly string[];
    },
  ): void {
    if (this.previewSessionsConfigured.has(partition)) {
      return;
    }
    const partitionSession = session.fromPartition(partition);
    partitionSession.setUserAgent(this.resolveSpoofedUserAgent());
    partitionSession.setPermissionCheckHandler(() => false);
    partitionSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    if (preview) {
      partitionSession.webRequest.onBeforeRequest((details, callback) => {
        if (preview.kind === "artifact") {
          callback({
            cancel: !artifactPreviewRequestAllowed({
              url: details.url,
              allowedOrigin: preview.origin,
              resourceType: details.resourceType,
            }),
          });
          return;
        }
        const allowed = localHtmlPreviewRequestAllowed({
          url: details.url,
          allowedOrigin: preview.origin,
          ...(preview.allowedExternalUrls
            ? { allowedExternalUrls: preview.allowedExternalUrls }
            : {}),
          method: details.method,
          resourceType: details.resourceType,
        });
        if (!allowed) {
          callback({ cancel: true });
          return;
        }
        const requestUrl = new URL(details.url);
        if (
          requestUrl.origin === preview.origin ||
          requestUrl.protocol === "data:" ||
          requestUrl.protocol === "blob:"
        ) {
          callback({ cancel: false });
          return;
        }
        void partitionSession
          .resolveHost(requestUrl.hostname.replace(/^\[|\]$/g, ""))
          .then((resolved) => {
            callback({
              cancel: !localHtmlPreviewResolvedAddressesAllowed(
                resolved.endpoints.map((endpoint) => endpoint.address),
              ),
            });
          })
          .catch(() => callback({ cancel: true }));
      });
      if (preview.kind === "local-html") {
        partitionSession.webRequest.onCompleted((details) => {
          const webContentsId = details.webContentsId ?? details.webContents?.id;
          if (
            details.resourceType === "mainFrame" &&
            details.statusCode >= 400 &&
            webContentsId !== undefined
          ) {
            this.markLocalHtmlHttpError(webContentsId, details.url, details.statusCode);
          }
        });
      }
      partitionSession.on("will-download", (event) => {
        event.preventDefault();
      });
    }
    if (preview?.kind === "local-html" && preview.allowedExternalUrls === undefined) {
      this.configureInteractiveLocalHtmlProxy(partition, preview.origin);
    } else {
      this.previewSessionReady.set(partition, Promise.resolve(null));
    }
    this.previewSessionsConfigured.add(partition);
  }

  private configureInteractiveLocalHtmlProxy(
    partition: string,
    previewOrigin: string,
  ): Promise<Error | null> {
    const readiness = session
      .fromPartition(partition)
      .setProxy({
        mode: "fixed_servers",
        proxyRules: "http=127.0.0.1:1;https=127.0.0.1:1;socks=127.0.0.1:1",
        proxyBypassRules: `<-loopback>;${new URL(previewOrigin).host}`,
      })
      .then(
        () => null,
        (cause: unknown) =>
          cause instanceof Error
            ? cause
            : new Error("Failed to establish the local HTML network boundary."),
      );
    this.previewSessionReady.set(partition, readiness);
    return readiness;
  }

  private configureTabSession(threadId: ThreadId, tab: BrowserTabState): void {
    if (tab.kind === "web") {
      return;
    }
    const partition = previewSessionPartitionForTab(threadId, tab);
    const previewOrigin =
      tab.kind === "artifact" || tab.kind === "local-html" ? safeUrlOrigin(tab.url) : null;
    this.ensurePreviewSessionConfigured(
      partition,
      previewOrigin && (tab.kind === "artifact" || tab.kind === "local-html")
        ? {
            kind: tab.kind,
            origin: previewOrigin,
            ...(tab.kind === "local-html" && tab.allowedExternalUrls
              ? { allowedExternalUrls: tab.allowedExternalUrls }
              : {}),
          }
        : undefined,
    );
  }

  private async clearPreviewSession(partition: string): Promise<void> {
    const previewSession = session.fromPartition(partition);
    this.previewSessionsConfigured.delete(partition);
    this.previewSessionReady.delete(partition);
    this.previewSessionRetries.delete(partition);
    // A local HTML refresh intentionally uses a fresh partition so the new
    // capability can load before the last working page is replaced. Electron
    // retains in-memory partition sessions until app exit, so leaving these
    // handlers attached would also retain one policy closure per source save.
    // Callers defer this cleanup until Electron confirms the owning WebContents
    // is destroyed, so a closing page cannot run without its trust boundary.
    previewSession.webRequest.onBeforeRequest(null);
    previewSession.webRequest.onCompleted(null);
    previewSession.setPermissionCheckHandler(null);
    previewSession.setPermissionRequestHandler(null);
    previewSession.removeAllListeners("will-download");
    await Promise.all([
      previewSession.clearStorageData(),
      previewSession.clearCache(),
      previewSession.setProxy({ mode: "direct" }),
    ]).then(
      () => undefined,
      () => undefined,
    );
  }

  private registerPreviewSessionOwner(partition: string, webContentsId: number): void {
    const owners = this.previewSessionOwnerIds.get(partition) ?? new Set<number>();
    owners.add(webContentsId);
    this.previewSessionOwnerIds.set(partition, owners);
  }

  private waitForPreviewSessionAvailable(partition: string, signal?: AbortSignal): Promise<void> {
    const owners = this.previewSessionOwnerIds.get(partition);
    const cleanup = this.previewSessionCleanupPromises.get(partition);
    if ((!owners || owners.size === 0) && !cleanup) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiters = this.previewSessionAvailabilityWaiters.get(partition) ?? new Set();
      const resolveWaiter = () => {
        signal?.removeEventListener("abort", rejectWaiter);
        resolve();
      };
      const rejectWaiter = () => {
        waiters.delete(resolveWaiter);
        if (waiters.size === 0) this.previewSessionAvailabilityWaiters.delete(partition);
        reject(signal?.reason ?? new Error("The local HTML preview refresh was cancelled."));
      };
      if (signal?.aborted) {
        rejectWaiter();
        return;
      }
      signal?.addEventListener("abort", rejectWaiter, { once: true });
      waiters.add(resolveWaiter);
      this.previewSessionAvailabilityWaiters.set(partition, waiters);
    });
  }

  private resolvePreviewSessionAvailability(partition: string): void {
    const waiters = this.previewSessionAvailabilityWaiters.get(partition);
    if (!waiters) return;
    this.previewSessionAvailabilityWaiters.delete(partition);
    for (const resolve of waiters) resolve();
  }

  private finalizePreviewSessionOwner(partition: string, webContentsId: number): void {
    this.pendingLocalHtmlHttpErrors.delete(webContentsId);
    const owners = this.previewSessionOwnerIds.get(partition);
    owners?.delete(webContentsId);
    if (owners && owners.size > 0) {
      return;
    }
    this.previewSessionOwnerIds.delete(partition);
    if (!this.previewSessionRetireRequested.delete(partition)) {
      this.resolvePreviewSessionAvailability(partition);
      return;
    }
    const cleanup = this.clearPreviewSession(partition).finally(() => {
      if (this.previewSessionCleanupPromises.get(partition) === cleanup) {
        this.previewSessionCleanupPromises.delete(partition);
        this.resolvePreviewSessionAvailability(partition);
      }
    });
    this.previewSessionCleanupPromises.set(partition, cleanup);
  }

  private requestPreviewSessionRetirement(partition: string): void {
    if (this.previewSessionCleanupPromises.has(partition)) {
      return;
    }
    this.previewSessionRetireRequested.add(partition);
    if ((this.previewSessionOwnerIds.get(partition)?.size ?? 0) === 0) {
      this.finalizePreviewSessionOwner(partition, -1);
    }
  }

  private clearLocalHtmlSourceWatch(threadId: ThreadId, tabId: string): void {
    const sourceWatch = this.detachLocalHtmlSourceWatch(threadId, tabId);
    if (!sourceWatch) {
      return;
    }
    this.disposeLocalHtmlSourceWatch(sourceWatch);
  }

  private detachLocalHtmlSourceWatch(
    threadId: ThreadId,
    tabId: string,
  ): LocalHtmlSourceWatch | null {
    const key = buildRuntimeKey(threadId, tabId);
    const sourceWatch = this.localHtmlSourceWatches.get(key) ?? null;
    this.localHtmlSourceWatches.delete(key);
    return sourceWatch;
  }

  private disposeLocalHtmlSourceWatch(sourceWatch: LocalHtmlSourceWatch): void {
    if (sourceWatch.debounceTimer) {
      clearTimeout(sourceWatch.debounceTimer);
    }
    for (const watcher of sourceWatch.watchers) {
      watcher.close();
    }
  }

  private configureLocalHtmlSourceWatch(
    threadId: ThreadId,
    tab: BrowserTabState,
    watchedPaths: readonly string[] | undefined,
    watchDiscoveryLimited = false,
  ): boolean {
    this.clearLocalHtmlSourceWatch(threadId, tab.id);
    if (tab.kind !== "local-html" || !tab.displayUrl) {
      return false;
    }

    const sourceRoot = canonicalLocalHtmlSourcePath(tab.sourceRoot);
    let watchLimited = sourceRoot === null || watchDiscoveryLimited;
    const normalizedPaths = new Set(
      [tab.sourceIdentity ?? tab.displayUrl, ...(watchedPaths ?? [])]
        .filter((sourcePath) => Path.isAbsolute(sourcePath))
        .map((sourcePath) => canonicalLocalHtmlSourcePath(sourcePath))
        .filter((sourcePath): sourcePath is string => sourcePath !== null)
        .filter((sourcePath) => {
          const allowed = sourceRoot !== null && isPathInside(sourcePath, sourceRoot);
          watchLimited ||= !allowed;
          return allowed;
        }),
    );
    const namesByDirectory = new Map<string, Set<string>>();
    const normalizeWatchName = (name: string) =>
      process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name;
    for (const sourcePath of normalizedPaths) {
      const directory = Path.dirname(sourcePath);
      const names = namesByDirectory.get(directory) ?? new Set<string>();
      names.add(normalizeWatchName(Path.basename(sourcePath)));
      namesByDirectory.set(directory, names);
    }

    const sourceWatch: LocalHtmlSourceWatch = {
      watchers: [],
      ownerTabId: tab.id,
      debounceTimer: null,
    };
    const notifyChanged = () => {
      if (sourceWatch.debounceTimer) {
        clearTimeout(sourceWatch.debounceTimer);
      }
      sourceWatch.debounceTimer = setTimeout(() => {
        sourceWatch.debounceTimer = null;
        const state = this.states.get(threadId);
        const currentTab = state?.tabs.find((candidate) => candidate.id === sourceWatch.ownerTabId);
        if (!state || !currentTab) {
          return;
        }
        currentTab.sourceChanged = true;
        currentTab.sourceChangeGeneration = (currentTab.sourceChangeGeneration ?? 0) + 1;
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }, 300);
      sourceWatch.debounceTimer.unref();
    };

    const existingWatchDirectoryCount = [...this.localHtmlSourceWatches.values()].reduce(
      (total, existingWatch) => total + existingWatch.watchers.length,
      0,
    );
    const watchDirectoryBudget = Math.min(
      MAX_LOCAL_HTML_WATCH_DIRECTORIES_PER_TAB,
      Math.max(0, MAX_LOCAL_HTML_WATCH_DIRECTORIES_TOTAL - existingWatchDirectoryCount),
    );
    watchLimited ||= namesByDirectory.size > watchDirectoryBudget;
    for (const [directory, names] of [...namesByDirectory].slice(0, watchDirectoryBudget)) {
      try {
        const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
          if (filename === null || names.has(normalizeWatchName(filename.toString()))) {
            notifyChanged();
          }
        });
        watcher.on("error", () => {
          // A replaced or removed directory invalidates this watcher. The next
          // successful preview revision rebuilds the complete watch set.
          const state = this.states.get(threadId);
          const currentTab = state?.tabs.find(
            (candidate) => candidate.id === sourceWatch.ownerTabId,
          );
          if (state && currentTab && !currentTab.sourceWatchLimited) {
            currentTab.sourceWatchLimited = true;
            this.markThreadStateChanged(threadId);
            this.emitState(threadId);
          }
        });
        sourceWatch.watchers.push(watcher);
      } catch {
        // The source can disappear during an atomic multi-file write. Manual
        // Reload remains available and a later successful revision watches it again.
        watchLimited = true;
      }
    }

    if (sourceWatch.watchers.length > 0) {
      this.localHtmlSourceWatches.set(buildRuntimeKey(threadId, tab.id), sourceWatch);
    }
    const wasLimited = tab.sourceWatchLimited === true;
    if (watchLimited) {
      tab.sourceWatchLimited = true;
    } else {
      delete tab.sourceWatchLimited;
    }
    return wasLimited !== watchLimited;
  }

  // Options for an OAuth/sign-in popup. Stays on the shared persistent partition and keeps the
  // hardened sandbox; `window.opener` is preserved by Electron because we allow (not deny) the
  // open, which is what lets the auth callback `postMessage`/`window.close()` back to the page.
  private buildOAuthPopupWindowOptions(): Electron.BrowserWindowConstructorOptions {
    const options: Electron.BrowserWindowConstructorOptions = {
      width: 480,
      height: 640,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      title: "Sign in",
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
    if (this.window) {
      options.parent = this.window;
    }
    return options;
  }

  private registerOAuthPopupWindow(popup: BrowserWindow, context: OAuthPopupContext): void {
    if (this.popupRuntimes.has(popup)) {
      return;
    }
    const runtime: OAuthPopupRuntime = {
      ...context,
      window: popup,
      listenerDisposers: [],
    };
    this.popupRuntimes.set(popup, runtime);
    popup.setMenuBarVisibility(false);
    this.configureOAuthPopupRuntime(runtime);
    this.centerPopupWindow(runtime);
  }

  private configureOAuthPopupRuntime(runtime: OAuthPopupRuntime): void {
    const { window: popup } = runtime;
    const { webContents } = popup;
    webContents.setUserAgent(this.resolveSpoofedUserAgent());
    const closeOnInput = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      const key = input.key.toLowerCase();
      const isCloseChord =
        key === "escape" ||
        (key === "w" && !input.shift && !input.alt && (input.meta || input.control));
      if (!isCloseChord) {
        return;
      }
      event.preventDefault();
      this.closePopupRuntime(runtime);
    };
    webContents.on("before-input-event", closeOnInput);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", closeOnInput);
    });

    // Auth providers can chain popups (provider -> consent). Keep nested windows inside the
    // shared session too, and send genuine external (non-web) URLs to the OS browser.
    webContents.setWindowOpenHandler((details) => {
      const { url } = details;
      const isWebUrl =
        url.startsWith("http://") || url.startsWith("https://") || url === ABOUT_BLANK_URL;
      if (!isWebUrl) {
        void shell.openExternal(url);
        return { action: "deny" };
      }

      const kind = classifyBrowserWindowOpen({
        url,
        frameName: details.frameName,
        features: details.features,
        disposition: details.disposition,
      });
      if (kind === "popup") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: this.buildOAuthPopupWindowOptions(),
        };
      }

      this.newTab({
        threadId: runtime.threadId,
        url,
        activate: true,
      });
      const bounds = this.getVisibleBoundsForThread(runtime.threadId);
      if (this.activeThreadId === runtime.threadId && bounds) {
        this.attachActiveTab(runtime.threadId, bounds);
      }
      return { action: "deny" };
    });

    const nestedWindowHandler = (nested: BrowserWindow) => {
      this.registerOAuthPopupWindow(nested, {
        threadId: runtime.threadId,
        tabId: runtime.tabId,
      });
    };
    webContents.on("did-create-window", nestedWindowHandler);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-create-window", nestedWindowHandler);
    });

    popup.once("closed", () => {
      this.removePopupRuntime(runtime);
    });
  }

  private removePopupRuntime(runtime: OAuthPopupRuntime): void {
    if (this.popupRuntimes.get(runtime.window) !== runtime) {
      return;
    }
    for (const dispose of runtime.listenerDisposers.splice(0)) {
      dispose();
    }
    this.popupRuntimes.delete(runtime.window);
  }

  private closePopupRuntime(runtime: OAuthPopupRuntime): void {
    this.removePopupRuntime(runtime);
    if (!runtime.window.isDestroyed()) {
      runtime.window.destroy();
    }
  }

  private centerPopupWindow(runtime: OAuthPopupRuntime): void {
    const parent = this.window;
    const popup = runtime.window;
    if (!parent || parent.isDestroyed() || popup.isDestroyed()) {
      return;
    }
    const parentBounds = parent.getBounds();
    const popupBounds = popup.getBounds();
    const nextBounds = {
      x: Math.round(parentBounds.x + (parentBounds.width - popupBounds.width) / 2),
      y: Math.round(parentBounds.y + (parentBounds.height - popupBounds.height) / 2),
      width: popupBounds.width,
      height: popupBounds.height,
    };
    if (
      popupBounds.x === nextBounds.x &&
      popupBounds.y === nextBounds.y &&
      popupBounds.width === nextBounds.width &&
      popupBounds.height === nextBounds.height
    ) {
      return;
    }
    popup.setBounds(nextBounds);
  }

  private updatePopupWindowsForThread(threadId: ThreadId): void {
    for (const runtime of this.popupRuntimes.values()) {
      if (runtime.threadId === threadId) {
        this.centerPopupWindow(runtime);
      }
    }
  }

  private closePopupWindowsWhere(shouldClose: (runtime: OAuthPopupRuntime) => boolean): void {
    for (const runtime of [...this.popupRuntimes.values()]) {
      if (shouldClose(runtime)) {
        this.closePopupRuntime(runtime);
      }
    }
  }

  private closePopupWindowsForThread(threadId: ThreadId): void {
    this.closePopupWindowsWhere((runtime) => runtime.threadId === threadId);
  }

  private closePopupWindowsForTab(threadId: ThreadId, tabId: string): void {
    this.closePopupWindowsWhere(
      (runtime) => runtime.threadId === threadId && runtime.tabId === tabId,
    );
  }

  private closeAllPopupWindows(): void {
    this.closePopupWindowsWhere(() => true);
  }

  dispose(): void {
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    for (const timer of this.tabSuspendTimers.values()) {
      clearTimeout(timer);
    }
    this.tabSuspendTimers.clear();
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.closeAllPopupWindows();
    for (const sourceWatch of this.localHtmlSourceWatches.values()) {
      if (sourceWatch.debounceTimer) {
        clearTimeout(sourceWatch.debounceTimer);
      }
      for (const watcher of sourceWatch.watchers) {
        watcher.close();
      }
    }
    this.localHtmlSourceWatches.clear();
    this.pendingRuntimeSyncs.clear();
    this.pendingLocalHtmlHttpErrors.clear();
    for (const pending of this.localHtmlReplacementQueuedInputs.values()) {
      pending.reject(new Error("The local HTML preview was closed."));
    }
    this.localHtmlReplacementTasks.clear();
    this.localHtmlReplacementCurrentInputs.clear();
    this.localHtmlReplacementQueuedInputs.clear();
    this.provisionalLocalHtmlRuntimes.clear();
    this.runtimeLastActiveAtByKey.clear();
    this.previewSessionsConfigured.clear();
    this.previewSessionReady.clear();
    this.previewSessionRetries.clear();
    this.previewSessionRetirementFinalizers.clear();
    this.occludedThreads.clear();
    this.listeners.clear();
    this.copyLinkListeners.clear();
    this.states.clear();
    this.threadVersionById.clear();
    this.snapshotCacheByThreadId.clear();
    this.lastEmittedVersionByThreadId.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
    this.attachedBoundsSignature = null;
    this.runtimeSyncFlushScheduled = false;
  }

  getPerformanceSnapshot(): BrowserPerformanceSnapshot {
    this.perfCounters.warmInactiveRuntimeCount = this.countWarmInactiveRuntimes();
    return {
      counters: { ...this.perfCounters },
      trackedProcessIds: this.getTrackedProcessIds(),
    };
  }

  getBrowserUseSnapshot(): BrowserUseSnapshot | null {
    if (this.activeThreadId) {
      const activeState = this.states.get(this.activeThreadId);
      if (activeState?.open) {
        return {
          threadId: this.activeThreadId,
          state: this.snapshotThreadState(this.activeThreadId, activeState),
        };
      }
    }

    for (const [threadId, state] of this.states) {
      if (state.open) {
        return {
          threadId,
          state: this.snapshotThreadState(threadId, state),
        };
      }
    }
    return null;
  }

  open(input: BrowserOpenInput): ThreadBrowserState {
    const requestedKind = input.kind ?? "web";
    if (requestedKind === "local-html") {
      if (!input.initialUrl || !isLocalHtmlPreviewUrl(input.initialUrl)) {
        throw new Error("The initial URL is not a local HTML preview capability.");
      }
      this.requireLocalHtmlCapability({
        url: input.initialUrl,
        displayUrl: input.displayUrl,
        sourceIdentity: input.sourceIdentity,
        sourceRoot: input.sourceRoot,
        watchedPaths: input.watchedPaths,
        allowedExternalUrls: input.allowedExternalUrls,
        localHtmlCapabilityProof: input.localHtmlCapabilityProof,
      });
    }
    const state = this.ensureWorkspace(
      input.threadId,
      input.initialUrl,
      requestedKind,
      input.displayUrl,
      input.allowedExternalUrls,
      input.previewCwd,
      input.watchedPaths,
      input.sourceIdentity,
      input.sourceRoot,
      input.watchDiscoveryLimited,
    );
    const didChange = !state.open;
    state.open = true;
    const nextInitialUrl = input.initialUrl ? normalizeUrlInput(input.initialUrl) : null;
    const activeTab = nextInitialUrl ? this.getActiveTab(state) : null;
    if (
      nextInitialUrl &&
      activeTab &&
      (activeTab.kind !== requestedKind ||
        ((requestedKind === "artifact" || requestedKind === "local-html") &&
          activeTab.url !== nextInitialUrl))
    ) {
      return this.newTab({
        threadId: input.threadId,
        url: nextInitialUrl,
        kind: requestedKind,
        ...(input.displayUrl ? { displayUrl: input.displayUrl } : {}),
        ...(input.previewCwd ? { previewCwd: input.previewCwd } : {}),
        ...(input.watchedPaths ? { watchedPaths: input.watchedPaths } : {}),
        ...(input.sourceIdentity ? { sourceIdentity: input.sourceIdentity } : {}),
        ...(input.sourceRoot ? { sourceRoot: input.sourceRoot } : {}),
        ...(input.watchDiscoveryLimited !== undefined
          ? { watchDiscoveryLimited: input.watchDiscoveryLimited }
          : {}),
        ...(input.localHtmlCapabilityProof
          ? { localHtmlCapabilityProof: input.localHtmlCapabilityProof }
          : {}),
        ...(input.allowedExternalUrls ? { allowedExternalUrls: input.allowedExternalUrls } : {}),
        activate: true,
      });
    }
    if (nextInitialUrl && activeTab && activeTab.url !== nextInitialUrl) {
      activeTab.displayUrl = input.displayUrl?.trim() || null;
      if (requestedKind === "local-html") {
        const previewCwd = input.previewCwd?.trim();
        if (previewCwd) {
          activeTab.previewCwd = previewCwd;
        } else {
          delete activeTab.previewCwd;
        }
        activeTab.allowedExternalUrls = normalizedLocalHtmlExternalUrls(input.allowedExternalUrls);
        this.configureLocalHtmlSourceWatch(
          input.threadId,
          activeTab,
          input.watchedPaths,
          input.watchDiscoveryLimited,
        );
      }
      return this.navigate({
        threadId: input.threadId,
        tabId: activeTab.id,
        url: nextInitialUrl,
      });
    }

    const nextDidChange = syncThreadLastError(state) || didChange;

    if (
      this.activeBounds &&
      this.activeBoundsThreadId === input.threadId &&
      (this.activeThreadId === null || this.activeThreadId === input.threadId)
    ) {
      const visibleTab = this.getActiveTab(state);
      if (!isBlankBrowserTabUrl(visibleTab)) {
        this.activateThread(input.threadId, this.activeBounds);
      }
    }

    if (nextDidChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  close(input: BrowserThreadInput): ThreadBrowserState {
    this.clearSuspendTimer(input.threadId);
    this.occludedThreads.delete(input.threadId);

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);
    this.closePopupWindowsForThread(input.threadId);

    this.destroyThreadRuntimes(input.threadId);

    const state = this.getOrCreateState(input.threadId);
    const closedPreviewTabs = state.tabs.filter(
      (tab) => tab.kind === "artifact" || tab.kind === "local-html",
    );
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.markThreadStateChanged(input.threadId);
    this.lastEmittedVersionByThreadId.delete(input.threadId);
    this.emitState(input.threadId);
    for (const tab of closedPreviewTabs) {
      this.clearLocalHtmlSourceWatch(input.threadId, tab.id);
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  hide(input: BrowserThreadInput): void {
    this.occludedThreads.delete(input.threadId);
    const state = this.states.get(input.threadId);
    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }

    if (!state?.open) {
      return;
    }

    this.scheduleThreadSuspend(input.threadId);
  }

  getState(input: BrowserThreadInput): ThreadBrowserState {
    return this.snapshotThreadState(input.threadId);
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): void {
    this.perfCounters.setPanelBoundsCalls += 1;
    const state = this.getOrCreateState(input.threadId);
    const nextBounds = normalizeBounds(input.bounds);
    const nextBoundsSignature = browserBoundsSignature(nextBounds);
    const activeTabId = this.getActiveTab(state)?.id ?? null;
    const activeRuntimeKey = activeTabId ? buildRuntimeKey(input.threadId, activeTabId) : null;
    const activeRuntime = activeRuntimeKey ? this.runtimes.get(activeRuntimeKey) : null;
    const wasOccluded = this.occludedThreads.has(input.threadId);
    this.setActiveBounds(input.threadId, nextBounds);

    if (!state.open || nextBounds === null) {
      this.occludedThreads.delete(input.threadId);
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return;
    }

    if (input.surface === "native" && input.occluded === true) {
      this.occludedThreads.add(input.threadId);
      if (
        this.activeThreadId === input.threadId &&
        this.attachedRuntimeKey === activeRuntimeKey &&
        activeRuntime?.ownsWebContents
      ) {
        this.setRuntimeViewHidden(activeRuntime, true);
        this.attachedBoundsSignature = null;
      }
      return;
    }
    this.occludedThreads.delete(input.threadId);

    if (
      input.surface === "native" &&
      activeTabId &&
      activeRuntime &&
      !activeRuntime.ownsWebContents
    ) {
      // Sheet mode renders more reliably with the native WebContentsView than a translated <webview>.
      this.destroyRuntime(input.threadId, activeTabId);
      const activeTab = this.getTab(state, activeTabId);
      if (activeTab) {
        suspendTabState(activeTab);
        this.markThreadStateChanged(input.threadId);
      }
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
    }

    if (input.surface === "renderer" && activeTabId && !activeRuntime) {
      this.activateThreadForPendingRenderer(input.threadId, nextBounds);
      return;
    }

    // Bounds sync fires often during panel motion. If the visible runtime and
    // applied viewport are already current, avoid waking the browser stack again.
    if (
      this.activeThreadId === input.threadId &&
      this.attachedRuntimeKey === activeRuntimeKey &&
      this.attachedBoundsSignature === nextBoundsSignature &&
      !wasOccluded
    ) {
      this.perfCounters.setPanelBoundsNoopSkips += 1;
      return;
    }

    this.updatePopupWindowsForThread(input.threadId);

    if (this.activeThreadId === input.threadId) {
      if (activeRuntimeKey && this.attachedRuntimeKey === activeRuntimeKey) {
        const runtime = this.runtimes.get(activeRuntimeKey);
        if (runtime) {
          this.perfCounters.setPanelBoundsViewportUpdates += 1;
          this.attachRuntime(runtime, nextBounds);
          return;
        }
      }
      this.attachActiveTab(input.threadId, nextBounds);
      return;
    }

    this.activateThread(input.threadId, nextBounds);
  }

  // Adopts the renderer-owned <webview> so the visible page and browser-use tools
  // share one WebContents instead of racing a hidden native WebContentsView.
  attachWebview(input: BrowserAttachWebviewInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const webContents = electronWebContents.fromId(input.webContentsId);
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("The visible browser webview is not available.");
    }

    const key = buildRuntimeKey(input.threadId, tab.id);
    const existingRendererRuntime = this.findRendererRuntimeByWebContentsId(webContents.id);
    if (existingRendererRuntime && existingRendererRuntime.key !== key) {
      this.destroyRuntime(existingRendererRuntime.threadId, existingRendererRuntime.tabId);
    }

    const existing = this.runtimes.get(key);
    if (existing?.webContents.id !== webContents.id) {
      if (existing) {
        this.destroyRuntime(input.threadId, tab.id);
      }
      const runtime: LiveTabRuntime = {
        key,
        threadId: input.threadId,
        tabId: tab.id,
        webContents,
        view: null,
        ownsWebContents: false,
        listenerDisposers: [],
      };
      this.configureRuntimeWebContents(runtime);
      if (tab.kind === "artifact" || tab.kind === "local-html") {
        this.registerPreviewSessionOwner(
          previewSessionPartitionForTab(input.threadId, tab),
          webContents.id,
        );
      }
      this.runtimes.set(key, runtime);
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    const runtime = this.runtimes.get(key);
    if (runtime && bounds) {
      this.attachRuntime(runtime, bounds);
    }

    const didChange = tab.status !== LIVE_TAB_STATUS || tab.lastError !== null;
    tab.status = LIVE_TAB_STATUS;
    tab.lastError = null;
    syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.queueRuntimeStateSync(input.threadId, tab.id);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  // Drops main-process ownership of a renderer-owned <webview> that React removed.
  // The webContents id guard keeps stale cleanup calls from tearing down a newly attached view.
  detachWebview(input: BrowserDetachWebviewInput): void {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state || !tab) {
      return;
    }

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime || runtime.ownsWebContents || runtime.webContents.id !== input.webContentsId) {
      return;
    }

    this.destroyRuntime(input.threadId, input.tabId);
    const didChange = suspendTabState(tab) || syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }
  }

  navigate(input: BrowserNavigateInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const nextUrl = normalizeUrlInput(input.url);
    if (tab.kind === "artifact" && safeUrlOrigin(nextUrl) !== safeUrlOrigin(tab.url)) {
      throw new Error("Artifact previews cannot navigate outside their capability origin.");
    }
    if (
      tab.kind === "local-html" &&
      localHtmlPreviewNavigationDisposition({
        url: nextUrl,
        allowedOrigin: safeUrlOrigin(tab.url) ?? "",
        isMainFrame: true,
      }) !== "allow"
    ) {
      throw new Error("Local HTML previews cannot replace their capability tab with another site.");
    }
    tab.url = nextUrl;
    tab.title = defaultTitleForUrl(nextUrl);
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);

    const runtimeKey = buildRuntimeKey(input.threadId, tab.id);
    const shouldLoadRuntime =
      this.runtimes.has(runtimeKey) || this.activeThreadId === input.threadId;
    if (shouldLoadRuntime) {
      if (this.activeThreadId === input.threadId) {
        this.clearSuspendTimer(input.threadId);
      }
      // Re-resolve through ensureLiveRuntime so a destroyed-but-still-tracked WebContents is
      // replaced before navigation instead of being handed to the async loader.
      const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(runtime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, { force: true, runtime });
    }

    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  reload(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime && tab.kind === "local-html") {
      let retryPartition: string | null = null;
      if (tab.allowedExternalUrls === undefined) {
        const previewOrigin = safeUrlOrigin(tab.url);
        if (previewOrigin) {
          retryPartition = previewSessionPartitionForTab(input.threadId, tab);
          if (this.previewSessionRetries.has(retryPartition)) {
            return this.snapshotThreadState(input.threadId, state);
          }
          this.previewSessionRetries.add(retryPartition);
          this.configureInteractiveLocalHtmlProxy(retryPartition, previewOrigin);
        }
      }
      tab.isLoading = true;
      tab.lastError = null;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
      void this.loadTab(input.threadId, tab.id, { force: true, runtime }).finally(() => {
        if (retryPartition) {
          this.previewSessionRetries.delete(retryPartition);
        }
      });
    } else if (runtime) {
      runtime.webContents.reload();
    } else if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      void this.loadTab(input.threadId, tab.id, { force: true });
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  replaceLocalHtmlPreview(input: BrowserReplaceLocalHtmlPreviewInput): Promise<ThreadBrowserState> {
    let validatedInput: BrowserReplaceLocalHtmlPreviewInput;
    try {
      validatedInput = this.validateLocalHtmlReplacementInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    // A successful replacement gives this source a new random tab id. Use the
    // logical source identity so later saves cannot start a competing task via
    // that new id while this queue is still draining.
    const key = buildLocalHtmlReplacementKey(validatedInput);
    const pending = createPendingLocalHtmlReplacement(validatedInput);
    const existing = this.localHtmlReplacementTasks.get(key);
    if (existing) {
      const latestPending =
        this.localHtmlReplacementQueuedInputs.get(key) ??
        this.localHtmlReplacementCurrentInputs.get(key);
      if (latestPending && sameLocalHtmlReplacementInput(latestPending.input, validatedInput)) {
        return latestPending.promise;
      }
      // Preserve only the newest distinct queued revision. Its caller owns its
      // capability outcome independently; superseded callers reject and revoke
      // only the grant that never became active.
      this.localHtmlReplacementQueuedInputs
        .get(key)
        ?.reject(new Error("This local HTML preview revision was superseded."));
      this.localHtmlReplacementQueuedInputs.set(key, pending);
      return pending.promise;
    }
    this.localHtmlReplacementCurrentInputs.set(key, pending);
    const task = this.performQueuedLocalHtmlPreviewReplacements(key, pending).finally(() => {
      if (this.localHtmlReplacementTasks.get(key) === task) {
        this.localHtmlReplacementTasks.delete(key);
        this.localHtmlReplacementCurrentInputs.delete(key);
        this.localHtmlReplacementQueuedInputs.delete(key);
      }
    });
    this.localHtmlReplacementTasks.set(key, task);
    return pending.promise;
  }

  private validateLocalHtmlReplacementInput(
    input: BrowserReplaceLocalHtmlPreviewInput,
  ): BrowserReplaceLocalHtmlPreviewInput {
    const state = this.states.get(input.threadId);
    const currentTab = state?.tabs.find((tab) => tab.id === input.tabId);
    if (!currentTab || currentTab.kind !== "local-html") {
      throw new Error("The local HTML preview is no longer available.");
    }
    if (!isLocalHtmlPreviewUrl(input.url)) {
      throw new Error("The replacement URL is not a local HTML preview capability.");
    }

    this.requireLocalHtmlCapability({
      url: input.url,
      displayUrl: input.displayUrl,
      sourceIdentity: input.sourceIdentity,
      sourceRoot: input.sourceRoot,
      watchedPaths: input.watchedPaths,
      allowedExternalUrls: input.allowedExternalUrls,
      localHtmlCapabilityProof: input.localHtmlCapabilityProof,
    });

    const currentDisplayUrl = normalizedLocalHtmlSourcePath(currentTab.displayUrl);
    const currentPreviewCwd = canonicalLocalHtmlSourcePath(currentTab.previewCwd);
    const currentSourceIdentity = normalizedLocalHtmlSourcePath(currentTab.sourceIdentity);
    const currentSourceRoot = normalizedLocalHtmlSourcePath(currentTab.sourceRoot);
    const preparedAuthority = validatePreparedLocalHtmlSourceAuthority({
      displayUrl: input.displayUrl,
      sourceIdentity: input.sourceIdentity,
      sourceRoot: input.sourceRoot,
    });
    if (
      !currentDisplayUrl ||
      !currentPreviewCwd ||
      !currentSourceIdentity ||
      !currentSourceRoot ||
      normalizedLocalHtmlSourcePath(input.displayUrl) !== currentDisplayUrl ||
      canonicalLocalHtmlSourcePath(input.previewCwd) !== currentPreviewCwd ||
      preparedAuthority.sourceIdentity !== currentSourceIdentity ||
      preparedAuthority.sourceRoot !== currentSourceRoot ||
      canonicalLocalHtmlSourcePath(currentTab.displayUrl) !== currentSourceIdentity ||
      !isPathInside(currentSourceIdentity, currentSourceRoot)
    ) {
      throw new Error("The replacement does not match the owned local HTML source.");
    }

    const watchedPaths = [currentSourceIdentity, ...input.watchedPaths]
      .map((sourcePath) => canonicalLocalHtmlSourcePath(sourcePath))
      .filter(
        (sourcePath): sourcePath is string =>
          sourcePath !== null && isPathInside(sourcePath, currentSourceRoot),
      );
    if (watchedPaths.length !== input.watchedPaths.length + 1) {
      throw new Error("A replacement dependency is outside the local HTML source authority.");
    }

    return {
      ...input,
      displayUrl: currentTab.displayUrl ?? currentDisplayUrl,
      previewCwd: currentTab.previewCwd ?? currentPreviewCwd,
      sourceIdentity: currentSourceIdentity,
      sourceRoot: currentSourceRoot,
      watchedPaths: [...new Set(watchedPaths)],
      ...(input.watchDiscoveryLimited !== undefined
        ? { watchDiscoveryLimited: input.watchDiscoveryLimited }
        : {}),
      ...(input.allowedExternalUrls
        ? { allowedExternalUrls: normalizedLocalHtmlExternalUrls(input.allowedExternalUrls) }
        : {}),
    };
  }

  private async performQueuedLocalHtmlPreviewReplacements(
    key: string,
    initialPending: PendingLocalHtmlReplacement,
  ): Promise<void> {
    let nextPending = initialPending;

    while (true) {
      this.localHtmlReplacementCurrentInputs.set(key, nextPending);
      let outcome:
        | { readonly state: ThreadBrowserState; readonly error?: never }
        | { readonly state?: never; readonly error: unknown };
      try {
        const state = await this.performLocalHtmlPreviewReplacement(nextPending.input, key);
        outcome = { state };
      } catch (error) {
        outcome = { error };
      }

      const queuedPending = this.localHtmlReplacementQueuedInputs.get(key);
      this.localHtmlReplacementQueuedInputs.delete(key);
      if (!queuedPending) {
        // Clear single-flight ownership before waking the caller. Otherwise its
        // immediate next save can enqueue behind a drain that has already decided
        // to exit, leaving that per-request promise unresolved.
        this.localHtmlReplacementTasks.delete(key);
        this.localHtmlReplacementCurrentInputs.delete(key);
        if ("error" in outcome) nextPending.reject(outcome.error);
        else nextPending.resolve(outcome.state);
        return;
      }
      if ("error" in outcome) nextPending.reject(outcome.error);
      else nextPending.resolve(outcome.state);

      const state = this.states.get(queuedPending.input.threadId);
      const currentSourceTab = state?.tabs.find(
        (tab) =>
          tab.kind === "local-html" &&
          normalizedLocalHtmlSourcePath(tab.sourceIdentity ?? tab.displayUrl) ===
            normalizedLocalHtmlSourcePath(
              queuedPending.input.sourceIdentity ?? queuedPending.input.displayUrl,
            ) &&
          normalizedLocalHtmlSourcePath(tab.previewCwd) ===
            normalizedLocalHtmlSourcePath(queuedPending.input.previewCwd),
      );
      nextPending = {
        ...queuedPending,
        input: {
          ...queuedPending.input,
          tabId: currentSourceTab?.id ?? queuedPending.input.tabId,
        },
      };
    }
  }

  private async performLocalHtmlPreviewReplacement(
    input: BrowserReplaceLocalHtmlPreviewInput,
    replacementTaskKey: string,
  ): Promise<ThreadBrowserState> {
    const state = this.ensureWorkspace(input.threadId);
    const activeTabIdAtStart = state.activeTabId;
    const previousTabIndex = state.tabs.findIndex((candidate) => candidate.id === input.tabId);
    const previousTab = state.tabs[previousTabIndex];
    if (!previousTab || previousTab.kind !== "local-html") {
      throw new Error("The local HTML preview is no longer available.");
    }
    const sourceGenerationAtStart = previousTab.sourceChangeGeneration ?? 0;

    const nextSessionSlot = previousTab.previewSessionSlot === 1 ? 0 : 1;
    const candidateTab = createBrowserTab(
      normalizeUrlInput(input.url),
      "local-html",
      input.displayUrl,
      input.allowedExternalUrls,
      input.previewCwd,
      nextSessionSlot,
      input.sourceIdentity,
      input.sourceRoot,
    );
    candidateTab.sourceChangeGeneration = previousTab.sourceChangeGeneration ?? 0;
    const partition = previewSessionPartitionForTab(input.threadId, candidateTab);
    const abortController = new AbortController();
    const timeoutError = new Error("The local HTML preview refresh timed out.");
    const timeout = setTimeout(
      () => abortController.abort(timeoutError),
      LOCAL_HTML_REPLACEMENT_TIMEOUT_MS,
    );
    timeout.unref();
    const deadline = new Promise<never>((_resolve, reject) => {
      abortController.signal.addEventListener(
        "abort",
        () => reject(abortController.signal.reason ?? timeoutError),
        { once: true },
      );
    });
    const beforeDeadline = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, deadline]);
    let candidateRuntime: LiveTabRuntime | null = null;

    try {
      await beforeDeadline(this.waitForPreviewSessionAvailable(partition, abortController.signal));
      if (state.tabs[previousTabIndex] !== previousTab) {
        throw new Error("The local HTML preview changed while it was waiting to refresh.");
      }
      this.configureTabSession(input.threadId, candidateTab);
      candidateRuntime = this.createLiveRuntime(input.threadId, candidateTab.id, candidateTab);
      const liveCandidateRuntime = candidateRuntime;
      this.runtimes.set(liveCandidateRuntime.key, liveCandidateRuntime);
      this.provisionalLocalHtmlRuntimes.set(liveCandidateRuntime.key, {
        threadId: input.threadId,
        sourceTabId: input.tabId,
        replacementTaskKey,
        tab: candidateTab,
      });

      const previewSessionError = await beforeDeadline(
        this.previewSessionReady.get(partition) ?? Promise.resolve(null),
      );
      if (previewSessionError) {
        throw previewSessionError;
      }

      const outcome = await beforeDeadline(
        loadBrowserRuntimeUrl({
          webContents: liveCandidateRuntime.webContents,
          nextUrl: candidateTab.url,
          force: true,
          isCurrent: () => this.runtimes.get(liveCandidateRuntime.key) === liveCandidateRuntime,
          onLoadStart: () => undefined,
        }),
      );
      const httpStatus = this.pendingLocalHtmlHttpErrors.get(liveCandidateRuntime.webContents.id);
      this.pendingLocalHtmlHttpErrors.delete(liveCandidateRuntime.webContents.id);
      if (httpStatus !== undefined) {
        throw new Error(`The refreshed local HTML page returned HTTP ${httpStatus}.`);
      }
      if (outcome !== "loaded" && outcome !== "unchanged") {
        throw new Error("The refreshed local HTML page could not be loaded.");
      }

      const currentTabIndex = state.tabs.findIndex((candidate) => candidate.id === input.tabId);
      if (currentTabIndex < 0 || state.tabs[currentTabIndex] !== previousTab) {
        throw new Error("The local HTML preview changed while it was refreshing.");
      }

      candidateTab.status = LIVE_TAB_STATUS;
      candidateTab.isLoading = candidateRuntime.webContents.isLoading();
      candidateTab.lastCommittedUrl =
        candidateRuntime.webContents.getURL() || candidateTab.lastCommittedUrl || candidateTab.url;
      const loadedTitle = candidateRuntime.webContents.getTitle();
      candidateTab.title =
        loadedTitle && loadedTitle !== ABOUT_BLANK_URL
          ? loadedTitle
          : defaultTitleForUrl(candidateTab.url);
      candidateTab.canGoBack = canWebContentsGoBack(candidateRuntime.webContents);
      candidateTab.canGoForward = canWebContentsGoForward(candidateRuntime.webContents);
      candidateTab.lastError = null;

      const duplicateTabs = state.tabs.filter(
        (tab) => tab.id !== previousTab.id && isSameLocalHtmlSource(tab, candidateTab),
      );
      const duplicateTabIds = new Set(duplicateTabs.map((tab) => tab.id));
      const sourceIsSelected =
        state.activeTabId === previousTab.id ||
        (state.activeTabId !== null && duplicateTabIds.has(state.activeTabId));
      const shouldActivate =
        sourceIsSelected || (input.activate !== false && state.activeTabId === activeTabIdAtStart);
      state.tabs = state.tabs
        .map((tab, index) => (index === currentTabIndex ? candidateTab : tab))
        .filter((tab) => !duplicateTabIds.has(tab.id));
      if (shouldActivate) {
        state.activeTabId = candidateTab.id;
      }

      const previousSourceWatch = this.detachLocalHtmlSourceWatch(input.threadId, previousTab.id);
      if (previousSourceWatch) previousSourceWatch.ownerTabId = candidateTab.id;
      const pendingDebouncedSourceChange = previousSourceWatch?.debounceTimer != null;
      const sourceChangedDuringReplacement =
        (previousTab.sourceChangeGeneration ?? 0) > sourceGenerationAtStart ||
        pendingDebouncedSourceChange;
      candidateTab.sourceChangeGeneration =
        (previousTab.sourceChangeGeneration ?? 0) + (pendingDebouncedSourceChange ? 1 : 0);
      if (sourceChangedDuringReplacement) candidateTab.sourceChanged = true;

      this.closePopupWindowsForTab(input.threadId, previousTab.id);
      this.destroyRuntime(input.threadId, previousTab.id, previousTab, true);
      for (const duplicateTab of duplicateTabs) {
        this.closePopupWindowsForTab(input.threadId, duplicateTab.id);
        this.destroyRuntime(input.threadId, duplicateTab.id, duplicateTab, true);
        this.clearLocalHtmlSourceWatch(input.threadId, duplicateTab.id);
      }
      this.configureLocalHtmlSourceWatch(
        input.threadId,
        candidateTab,
        input.watchedPaths,
        input.watchDiscoveryLimited,
      );
      if (previousSourceWatch) this.disposeLocalHtmlSourceWatch(previousSourceWatch);

      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);

      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (
        this.activeThreadId === input.threadId &&
        state.activeTabId === candidateTab.id &&
        bounds
      ) {
        this.attachRuntime(candidateRuntime, bounds);
      }
      this.provisionalLocalHtmlRuntimes.delete(candidateRuntime.key);
      return this.snapshotThreadState(input.threadId, state);
    } catch (error) {
      if (candidateRuntime) {
        this.pendingLocalHtmlHttpErrors.delete(candidateRuntime.webContents.id);
        this.destroyRuntime(input.threadId, candidateTab.id, candidateTab, true);
        this.provisionalLocalHtmlRuntimes.delete(candidateRuntime.key);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  goBack(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canWebContentsGoBack(runtime.webContents)) {
      runtime.webContents.goBack();
    }
    return this.getState({ threadId: input.threadId });
  }

  goForward(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canWebContentsGoForward(runtime.webContents)) {
      runtime.webContents.goForward();
    }
    return this.getState({ threadId: input.threadId });
  }

  newTab(input: BrowserNewTabInput): ThreadBrowserState {
    if (input.kind === "local-html") {
      const localHtmlUrl = input.url;
      if (!localHtmlUrl || !isLocalHtmlPreviewUrl(localHtmlUrl)) {
        throw new Error("The new-tab URL is not a local HTML preview capability.");
      }
      this.requireLocalHtmlCapability({
        url: localHtmlUrl,
        displayUrl: input.displayUrl,
        sourceIdentity: input.sourceIdentity,
        sourceRoot: input.sourceRoot,
        watchedPaths: input.watchedPaths,
        allowedExternalUrls: input.allowedExternalUrls,
        localHtmlCapabilityProof: input.localHtmlCapabilityProof,
      });
    }
    const state = this.ensureWorkspace(input.threadId);
    const tab = createBrowserTab(
      normalizeUrlInput(input.url),
      input.kind ?? "web",
      input.displayUrl,
      input.allowedExternalUrls,
      input.previewCwd,
      0,
      input.sourceIdentity,
      input.sourceRoot,
    );
    const existingSourceTab =
      tab.kind === "local-html"
        ? state.tabs.find((candidate) => isSameLocalHtmlSource(candidate, tab))
        : undefined;
    if (existingSourceTab) {
      const watchStateChanged = this.configureLocalHtmlSourceWatch(
        input.threadId,
        existingSourceTab,
        input.watchedPaths,
        input.watchDiscoveryLimited,
      );
      const selectionChanged =
        input.activate !== false && state.activeTabId !== existingSourceTab.id;
      if (selectionChanged) {
        state.activeTabId = existingSourceTab.id;
      }
      if (watchStateChanged || selectionChanged) {
        syncThreadLastError(state);
        this.markThreadStateChanged(input.threadId);
        this.emitState(input.threadId);
      }
      return this.snapshotThreadState(input.threadId, state);
    }
    this.configureTabSession(input.threadId, tab);
    state.tabs = [...state.tabs, tab];
    this.configureLocalHtmlSourceWatch(
      input.threadId,
      tab,
      input.watchedPaths,
      input.watchDiscoveryLimited,
    );
    if (input.activate !== false || !state.activeTabId) {
      state.activeTabId = tab.id;
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachActiveTab(input.threadId, bounds, { forceLoad: true });
      }
    } else {
      tab.status = "suspended";
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  closeTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const closedTabIndex = state.tabs.findIndex((tab) => tab.id === input.tabId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return this.snapshotThreadState(input.threadId, state);
    }

    if (nextTabs.length === 0) {
      // The tab close button is also the natural close affordance for a one-tab browser.
      // Tear down the browser session so the renderer can close this dock pane and reveal
      // the surface chooser instead of immediately manufacturing another blank tab.
      return this.close({ threadId: input.threadId });
    }

    this.closePopupWindowsForTab(input.threadId, input.tabId);
    this.destroyProvisionalLocalHtmlRuntimesForSource(input.threadId, input.tabId);
    this.destroyRuntime(input.threadId, input.tabId, undefined, true);
    this.clearLocalHtmlSourceWatch(input.threadId, input.tabId);
    state.tabs = nextTabs;

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.min(closedTabIndex, nextTabs.length - 1)]?.id ?? null;
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (this.activeThreadId === input.threadId && bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  selectTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (bounds) {
        this.attachActiveTab(input.threadId, bounds);
      }
    }

    return this.snapshotThreadState(input.threadId, state);
  }

  openDevTools(input: BrowserTabInput): void {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }
    runtime.webContents.openDevTools({ mode: "detach" });
  }

  // Ensures the requested tab is active/live, then returns a fresh PNG capture
  // from the native browser surface for whichever destination needs it next.
  private async captureScreenshotPng(input: BrowserTabInput): Promise<{
    name: string;
    pngBytes: Buffer;
  }> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const expectedUrl = normalizeUrlInput(tab.lastCommittedUrl ?? tab.url);
    const currentUrl = webContents.getURL();
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended || currentUrl.length === 0 || currentUrl !== expectedUrl) {
      await this.loadTab(input.threadId, tab.id, { runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    const pngBytes = (await webContents.capturePage()).toPNG();
    if (pngBytes.byteLength === 0) {
      throw new Error("Couldn't capture a browser screenshot.");
    }

    return {
      name: screenshotFileNameForUrl(tab.lastCommittedUrl ?? tab.url),
      pngBytes,
    };
  }

  // Captures the current browser viewport as a PNG so the renderer can attach
  // it directly to the composer without introducing temp-file disk churn.
  async captureScreenshot(input: BrowserTabInput): Promise<BrowserCaptureScreenshotResult> {
    const { name, pngBytes } = await this.captureScreenshotPng(input);

    return {
      name,
      mimeType: "image/png",
      sizeBytes: pngBytes.byteLength,
      bytes: Uint8Array.from(pngBytes),
    };
  }

  // Copies the active tab's URL via the native clipboard and emits the copy-link
  // event, mirroring the keyboard-chord path. The renderer's navigator.clipboard
  // can reject with "Document is not focused" while the native page view holds
  // focus, so the React toolbar button routes through here for reliability.
  copyLink(input: BrowserTabInput): void {
    this.copyTabLink(input.threadId, input.tabId);
  }

  // Writes the current browser viewport screenshot straight to the native
  // clipboard so the renderer does not have to ferry image payloads over IPC.
  async copyScreenshotToClipboard(input: BrowserTabInput): Promise<void> {
    const { pngBytes } = await this.captureScreenshotPng(input);
    const image = nativeImage.createFromBuffer(pngBytes);
    if (image.isEmpty()) {
      throw new Error("Couldn't copy a browser screenshot to the clipboard.");
    }
    clipboard.writeImage(image);
  }

  // Runs a Chrome DevTools Protocol command against the requested tab so higher-level
  // browser automation can reuse the native browser runtime instead of scripting React.
  async executeCdp(input: BrowserExecuteCdpInput): Promise<unknown> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended) {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    try {
      return await webContents.debugger.sendCommand(input.method, input.params ?? {});
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`CDP ${input.method} failed: ${error.message}`);
      }
      throw error;
    }
  }

  async attachBrowserUseTab(input: BrowserTabInput): Promise<void> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    if (this.activeBounds && this.activeBoundsThreadId === input.threadId) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    if (wasSuspended) {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!runtime.webContents.debugger.isAttached()) {
      runtime.webContents.debugger.attach("1.3");
    }
  }

  subscribeToCdpEvents(
    input: BrowserTabInput,
    listener: (event: BrowserUseCdpEvent) => void,
  ): () => void {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime) {
      return () => {};
    }

    const handleMessage = (_event: Electron.Event, method: string, params?: unknown) => {
      listener({
        method,
        ...(params !== undefined ? { params } : {}),
      });
    };

    runtime.webContents.debugger.on("message", handleMessage);
    return () => {
      runtime.webContents.debugger.removeListener("message", handleMessage);
    };
  }

  private activateThread(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (this.activeThreadId && this.activeThreadId !== threadId) {
      this.scheduleThreadSuspend(this.activeThreadId);
    }

    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.resumeThread(threadId);
    this.attachActiveTab(threadId, bounds);
    this.updatePopupWindowsForThread(threadId);
  }

  // Renderer panels create their own <webview>; keep active-thread bookkeeping current while
  // waiting for attachWebview so startup does not create a duplicate native WebContentsView.
  private activateThreadForPendingRenderer(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.scheduleThreadSuspend(previousThreadId);
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    this.clearSuspendTimer(threadId);
    this.updatePopupWindowsForThread(threadId);
  }

  private setActiveBounds(threadId: ThreadId, bounds: BrowserPanelBounds | null): void {
    if (!bounds) {
      this.clearActiveBoundsForThread(threadId);
      return;
    }
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
  }

  private clearActiveBoundsForThread(threadId: ThreadId): void {
    if (this.activeBoundsThreadId !== threadId) {
      return;
    }
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
  }

  private getVisibleBoundsForThread(threadId: ThreadId): BrowserPanelBounds | null {
    return this.activeBoundsThreadId === threadId ? this.activeBounds : null;
  }

  private resumeThread(threadId: ThreadId): void {
    const state = this.ensureWorkspace(threadId);
    if (!state.open) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const activeTab = this.getActiveTab(state);
    let didChange = this.suspendInactiveTabs(threadId, activeTab?.id ?? null);

    // Only resume the visible tab. Waking every tab can fan out into several
    // Chromium renderer processes and background page activity at once.
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) {
        continue;
      }
      const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
      const runtime = this.ensureLiveRuntime(threadId, tab.id);
      if (wasSuspended) {
        void this.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        didChange = syncTabStateFromRuntime(state, tab, runtime.webContents) || didChange;
      }
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private suspendInactiveTabs(threadId: ThreadId, activeTabId: string | null): boolean {
    const state = this.states.get(threadId);
    if (!state) {
      return false;
    }

    let didChange = false;
    const inactiveRuntimeTabIds = state.tabs
      .filter((tab) => tab.id !== activeTabId)
      .filter((tab) => this.runtimes.has(buildRuntimeKey(threadId, tab.id)))
      .sort((left, right) => {
        const leftKey = buildRuntimeKey(threadId, left.id);
        const rightKey = buildRuntimeKey(threadId, right.id);
        return (
          (this.runtimeLastActiveAtByKey.get(rightKey) ?? 0) -
          (this.runtimeLastActiveAtByKey.get(leftKey) ?? 0)
        );
      });
    const warmRuntimeTabIds = new Set(
      inactiveRuntimeTabIds
        .slice(0, BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD)
        .map((tab) => tab.id),
    );

    for (const tab of state.tabs) {
      if (tab.id === activeTabId) {
        this.clearTabSuspendTimer(threadId, tab.id);
        continue;
      }

      const runtime = this.runtimes.get(buildRuntimeKey(threadId, tab.id));
      if (runtime) {
        if (warmRuntimeTabIds.has(tab.id)) {
          this.scheduleInactiveTabSuspend(threadId, tab.id);
          continue;
        }

        this.perfCounters.inactiveTabBudgetEvictions += 1;
        this.destroyRuntime(threadId, tab.id);
        didChange = suspendTabState(tab) || didChange;
        continue;
      }

      didChange = suspendTabState(tab) || didChange;
    }

    return didChange;
  }

  private scheduleThreadSuspend(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state?.open || this.activeThreadId === threadId) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const timer = setTimeout(() => {
      this.suspendThread(threadId);
      this.suspendTimers.delete(threadId);
    }, BROWSER_THREAD_SUSPEND_DELAY_MS);
    timer.unref();
    this.suspendTimers.set(threadId, timer);
  }

  private suspendThread(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state || this.activeThreadId === threadId) {
      return;
    }

    let didChange = false;
    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
      didChange = suspendTabState(tab) || didChange;
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private clearSuspendTimer(threadId: ThreadId): void {
    const existing = this.suspendTimers.get(threadId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.suspendTimers.delete(threadId);
  }

  private scheduleInactiveTabSuspend(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    if (this.tabSuspendTimers.has(key)) {
      return;
    }

    this.perfCounters.inactiveTabSuspendScheduled += 1;
    const delayMs = this.resolveInactiveTabSuspendDelay(threadId);
    const timer = setTimeout(() => {
      this.tabSuspendTimers.delete(key);
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      this.destroyRuntime(threadId, tabId);
      const didChange = suspendTabState(tab) || syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
    }, delayMs);
    timer.unref();
    this.tabSuspendTimers.set(key, timer);
  }

  private clearTabSuspendTimer(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.tabSuspendTimers.get(key);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    this.tabSuspendTimers.delete(key);
    this.perfCounters.inactiveTabSuspendCancelled += 1;
  }

  private attachActiveTab(
    threadId: ThreadId,
    bounds: BrowserPanelBounds,
    options: { forceLoad?: boolean } = {},
  ): void {
    const state = this.ensureWorkspace(threadId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) {
      return;
    }

    this.suspendInactiveTabs(threadId, activeTab.id);
    const wasSuspended = activeTab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(threadId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (options.forceLoad || wasSuspended) {
      void this.loadTab(threadId, activeTab.id, {
        force: options.forceLoad || wasSuspended,
        runtime,
      });
    } else {
      this.syncRuntimeState(threadId, activeTab.id);
    }
  }

  private attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.window;
    if (!window) {
      return;
    }

    const nextBoundsSignature = browserBoundsSignature(bounds);
    this.runtimeLastActiveAtByKey.set(runtime.key, Date.now());
    // Renderer-owned <webview> runtimes are already visible in React; keep any
    // old native view detached so it cannot cover the real browser surface.
    if (!runtime.ownsWebContents) {
      if (this.attachedRuntimeKey && this.attachedRuntimeKey !== runtime.key) {
        this.detachAttachedRuntime();
      }
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (!runtime.view) {
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (this.occludedThreads.has(runtime.threadId)) {
      if (this.attachedRuntimeKey && this.attachedRuntimeKey !== runtime.key) {
        this.detachAttachedRuntime();
      }
      this.bringRuntimeViewToFront(runtime);
      runtime.view.setBounds(bounds);
      this.setRuntimeViewHidden(runtime, true);
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = null;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (this.attachedRuntimeKey === runtime.key) {
      this.setRuntimeViewHidden(runtime, false);
      this.bringRuntimeViewToFront(runtime);
      if (this.attachedBoundsSignature === nextBoundsSignature) {
        return;
      }
      runtime.view.setBounds(bounds);
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }

    this.detachAttachedRuntime();
    this.setRuntimeViewHidden(runtime, false);
    this.bringRuntimeViewToFront(runtime);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
    this.attachedBoundsSignature = nextBoundsSignature;
    this.updatePopupWindowsForThread(runtime.threadId);
  }

  private bringRuntimeViewToFront(runtime: LiveTabRuntime): void {
    const window = this.window;
    if (!window || !runtime.view) {
      return;
    }

    try {
      window.contentView.removeChildView(runtime.view);
    } catch {
      // Electron throws when the view is not attached yet; adding it below is the desired state.
    }
    window.contentView.addChildView(runtime.view);
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime?.view) {
      this.setRuntimeViewHidden(runtime, true);
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  private setRuntimeViewHidden(runtime: LiveTabRuntime, hidden: boolean): void {
    if (!runtime.view) {
      return;
    }
    const nativeView = runtime.view as typeof runtime.view & NativeBrowserViewVisibility;
    nativeView.setVisible?.(!hidden);
    if (hidden) {
      runtime.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  private ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      if (existing.webContents.isDestroyed()) {
        this.destroyRuntime(threadId, tabId);
      } else {
        return existing;
      }
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      const didChange = tab.status !== "live" || tab.lastError !== null;
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
      }
    }
    return runtime;
  }

  private createLiveRuntime(
    threadId: ThreadId,
    tabId: string,
    sourceTabOverride?: BrowserTabState,
  ): LiveTabRuntime {
    const state = this.ensureWorkspace(threadId);
    const tab = sourceTabOverride ?? this.resolveTab(state, tabId);
    const partition = previewSessionPartitionForTab(threadId, tab);
    if (tab.kind !== "web") {
      this.configureTabSession(threadId, tab);
    }
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Avoid a black native surface while a local page is still loading. Once
    // loaded, a transparent document gets the same white default canvas users
    // expect from a normal browser; authored page backgrounds remain intact.
    view.setBackgroundColor("#ffffff");
    const runtime: LiveTabRuntime = {
      key: buildRuntimeKey(threadId, tabId),
      threadId,
      tabId,
      webContents: view.webContents,
      view,
      ownsWebContents: true,
      listenerDisposers: [],
    };
    this.configureRuntimeWebContents(runtime, tab);
    if (tab.kind === "artifact" || tab.kind === "local-html") {
      this.registerPreviewSessionOwner(partition, view.webContents.id);
    }
    return runtime;
  }

  private configureRuntimeWebContents(
    runtime: LiveTabRuntime,
    sourceTabOverride?: BrowserTabState,
  ): void {
    const { threadId, tabId, webContents } = runtime;
    const state = this.ensureWorkspace(threadId);
    const sourceTab = sourceTabOverride ?? this.getTab(state, tabId);
    const tabKind = sourceTab?.kind ?? "web";
    const artifactOrigin = tabKind === "artifact" ? safeUrlOrigin(sourceTab?.url) : null;
    const localHtmlOrigin = tabKind === "local-html" ? safeUrlOrigin(sourceTab?.url) : null;

    // Belt-and-suspenders alongside the session-level UA: also covers an adopted renderer
    // <webview> for any navigation after it attaches.
    webContents.setUserAgent(this.resolveSpoofedUserAgent());
    if (tabKind === "local-html") {
      // Local HTML capabilities must not gain a UDP/STUN side channel around
      // the HTTP(S) request policy. The awaited deny proxy is the primary
      // boundary for interactive previews; this UDP policy is defense in depth.
      webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    }

    webContents.setWindowOpenHandler((details) => {
      const { url } = details;
      const isWebUrl =
        url.startsWith("http://") || url.startsWith("https://") || url === ABOUT_BLANK_URL;
      if (!isWebUrl) {
        if (tabKind === "web") {
          void shell.openExternal(url);
        }
        return { action: "deny" };
      }

      if (tabKind === "artifact" || tabKind === "local-html") {
        // Capability-backed local documents are one owned source tab. Allowing
        // window.open would create a second tab without canonical source/root
        // metadata and escape the bounded two-slot preview-session lifecycle.
        return { action: "deny" };
      }

      const windowKind = classifyBrowserWindowOpen({
        url,
        frameName: details.frameName,
        features: details.features,
        disposition: details.disposition,
      });
      if (tabKind === "web" && windowKind === "popup") {
        // Allow (don't deny) so Electron creates a real child window that keeps
        // `window.opener`, which the OAuth callback needs to message the page back.
        return {
          action: "allow",
          overrideBrowserWindowOptions: this.buildOAuthPopupWindowOptions(),
        };
      }

      this.newTab({
        threadId,
        url,
        kind: tabKind,
        activate: true,
      });
      const bounds = this.getVisibleBoundsForThread(threadId);
      if (this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
      return { action: "deny" };
    });

    if (artifactOrigin) {
      const blockArtifactFrameNavigation = (
        event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
      ) => {
        if (
          !artifactPreviewNavigationAllowed({
            url: event.url,
            allowedOrigin: artifactOrigin,
            isMainFrame: event.isMainFrame,
          })
        ) {
          event.preventDefault();
        }
      };
      webContents.on("will-frame-navigate", blockArtifactFrameNavigation);
      runtime.listenerDisposers.push(() => {
        webContents.removeListener("will-frame-navigate", blockArtifactFrameNavigation);
      });
    }

    if (localHtmlOrigin) {
      const separateLocalHtmlNavigation = (
        event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
      ) => {
        const disposition = localHtmlPreviewNavigationDisposition({
          url: event.url,
          allowedOrigin: localHtmlOrigin,
          isMainFrame: event.isMainFrame,
        });
        if (disposition === "allow") return;
        event.preventDefault();
      };
      webContents.on("will-frame-navigate", separateLocalHtmlNavigation);
      runtime.listenerDisposers.push(() => {
        webContents.removeListener("will-frame-navigate", separateLocalHtmlNavigation);
      });
    }

    const didCreateWindow = (childWindow: BrowserWindow) => {
      this.registerOAuthPopupWindow(childWindow, { threadId, tabId });
    };
    webContents.on("did-create-window", didCreateWindow);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-create-window", didCreateWindow);
    });

    // The native page owns keyboard focus while browsing, so the renderer never sees the
    // copy-link chord. Intercept it here, copy the live URL, and let the shell toast.
    const beforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      const matches = isBrowserCopyLinkChord(
        {
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          key: input.key,
        },
        process.platform === "darwin",
      );
      if (!matches) {
        return;
      }
      event.preventDefault();
      this.copyTabLink(threadId, tabId);
    };
    webContents.on("before-input-event", beforeInputEvent);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", beforeInputEvent);
    });

    const pageTitleUpdated = (event: Electron.Event) => {
      event.preventDefault();
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("page-title-updated", pageTitleUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-title-updated", pageTitleUpdated);
    });

    const pageFaviconUpdated = (_event: Electron.Event, faviconUrls: string[]) => {
      this.queueRuntimeStateSync(threadId, tabId, faviconUrls);
    };
    webContents.on("page-favicon-updated", pageFaviconUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-favicon-updated", pageFaviconUpdated);
    });

    const didStartLoading = () => {
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (state && tab) {
        const didChange = !tab.isLoading || tab.lastError !== null;
        tab.isLoading = true;
        tab.lastError = null;
        syncThreadLastError(state);
        if (didChange) {
          this.markThreadStateChanged(threadId);
          this.emitState(threadId);
        }
      }
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-start-loading", didStartLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-start-loading", didStartLoading);
    });

    const didStopLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-stop-loading", didStopLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-stop-loading", didStopLoading);
    });

    const didFinishLoad = () => {
      if (tabKind === "local-html") {
        void webContents
          .executeJavaScript(LOCAL_HTML_DEFAULT_CANVAS_SCRIPT, true)
          .catch(() => undefined);
      }
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-finish-load", didFinishLoad);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-finish-load", didFinishLoad);
    });

    const didNavigate = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate", didNavigate);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate", didNavigate);
    });

    const didNavigateInPage = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate-in-page", didNavigateInPage);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate-in-page", didNavigateInPage);
    });

    const didFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || errorCode === BROWSER_ERROR_ABORTED) {
        return;
      }

      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      tab.url = validatedURL || tab.url;
      tab.title = defaultTitleForUrl(tab.url);
      tab.isLoading = false;
      tab.lastError = mapBrowserLoadError(errorCode);
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    };
    webContents.on("did-fail-load", didFailLoad);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-fail-load", didFailLoad);
    });

    const renderProcessGone = () => {
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      this.destroyRuntime(threadId, tabId);
      if (state && tab) {
        tab.status = "suspended";
        tab.isLoading = false;
        tab.lastError = "This tab stopped unexpectedly.";
        syncThreadLastError(state);
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
      const bounds = this.getVisibleBoundsForThread(threadId);
      if (this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    };
    webContents.on("render-process-gone", renderProcessGone);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("render-process-gone", renderProcessGone);
    });
  }

  private async loadTab(
    threadId: ThreadId,
    tabId: string,
    options: { force?: boolean; runtime?: LiveTabRuntime } = {},
  ): Promise<void> {
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (!tab) {
      return;
    }

    const nextUrl = normalizeUrlInput(
      options.force === true ? tab.url : (tab.lastCommittedUrl ?? tab.url),
    );

    try {
      const runtime = options.runtime ?? this.ensureLiveRuntime(threadId, tabId);
      if (tab.kind !== "web") {
        const partition = previewSessionPartitionForTab(threadId, tab);
        const previewSessionError = await (this.previewSessionReady.get(partition) ??
          Promise.resolve(null));
        if (previewSessionError) throw previewSessionError;
      }
      const outcome = await loadBrowserRuntimeUrl({
        webContents: runtime.webContents,
        nextUrl,
        force: options.force === true,
        isCurrent: () => this.runtimes.get(runtime.key) === runtime,
        onLoadStart: () => {
          tab.url = nextUrl;
          tab.status = "live";
          tab.isLoading = true;
          tab.lastError = null;
          syncThreadLastError(state);
          this.markThreadStateChanged(threadId);
          this.emitState(threadId);
        },
      });

      if (outcome === "loaded" || outcome === "unchanged" || outcome === "aborted") {
        this.queueRuntimeStateSync(threadId, tabId);
        return;
      }

      if (outcome === "stale") {
        // If this exact runtime died without its normal render-process-gone cleanup firing,
        // remove it so the next visible activation creates a healthy replacement.
        if (this.runtimes.get(runtime.key) === runtime && runtime.webContents.isDestroyed()) {
          this.destroyRuntime(threadId, tabId);
          const didChange = suspendTabState(tab) || syncThreadLastError(state);
          if (didChange) {
            this.markThreadStateChanged(threadId);
            this.emitState(threadId);
          }
        }
        return;
      }

      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    } catch {
      // Runtime construction and bookkeeping errors must be surfaced as browser state, never as
      // unhandled promises from the fire-and-forget navigation paths above.
      const currentTab = this.getTab(state, tabId);
      if (!currentTab) {
        return;
      }
      currentTab.isLoading = false;
      currentTab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    this.perfCounters.syncRuntimeStateCalls += 1;
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    const didChange = syncTabStateFromRuntime(state, tab, runtime.webContents, faviconUrls);
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private queueRuntimeStateSync(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.pendingRuntimeSyncs.get(key);
    const nextPendingSync: PendingRuntimeSync = {
      threadId,
      tabId,
    };
    const nextFaviconUrls = faviconUrls ?? existing?.faviconUrls;
    if (nextFaviconUrls !== undefined) {
      nextPendingSync.faviconUrls = nextFaviconUrls;
    }
    this.pendingRuntimeSyncs.set(key, nextPendingSync);

    if (this.runtimeSyncFlushScheduled) {
      return;
    }

    this.runtimeSyncFlushScheduled = true;
    queueMicrotask(() => {
      this.runtimeSyncFlushScheduled = false;
      if (this.pendingRuntimeSyncs.size === 0) {
        return;
      }

      this.perfCounters.runtimeSyncQueueFlushes += 1;
      const pendingSyncs = [...this.pendingRuntimeSyncs.values()];
      this.pendingRuntimeSyncs.clear();
      for (const pendingSync of pendingSyncs) {
        this.syncRuntimeState(pendingSync.threadId, pendingSync.tabId, pendingSync.faviconUrls);
      }
    });
  }

  private destroyThreadRuntimes(threadId: ThreadId): void {
    // Include provisional local-HTML replacements, whose random tab ids are not
    // committed to state.tabs until their fresh capability has loaded successfully.
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.threadId === threadId) {
        this.destroyRuntime(threadId, runtime.tabId, undefined, true);
      }
    }
    for (const tab of this.states.get(threadId)?.tabs ?? []) {
      if (tab.kind === "artifact" || tab.kind === "local-html") {
        this.destroyRuntime(threadId, tab.id, tab, true);
      }
    }
    for (const [key, provisional] of [...this.provisionalLocalHtmlRuntimes]) {
      if (provisional.threadId === threadId) {
        this.provisionalLocalHtmlRuntimes.delete(key);
      }
    }
    for (const [key, task] of this.localHtmlReplacementTasks) {
      if (this.localHtmlReplacementCurrentInputs.get(key)?.input.threadId === threadId) {
        // The active promise observes its destroyed runtime and rejects. Discard any
        // not-yet-started revision so a closed workspace cannot be reopened implicitly.
        this.localHtmlReplacementQueuedInputs
          .get(key)
          ?.reject(new Error("The local HTML preview was closed."));
        this.localHtmlReplacementQueuedInputs.delete(key);
        void task.catch(() => undefined);
      }
    }
  }

  private destroyProvisionalLocalHtmlRuntimesForSource(
    threadId: ThreadId,
    sourceTabId: string,
  ): void {
    for (const [key, provisional] of [...this.provisionalLocalHtmlRuntimes]) {
      if (provisional.threadId !== threadId || provisional.sourceTabId !== sourceTabId) {
        continue;
      }
      this.destroyRuntime(threadId, provisional.tab.id, provisional.tab, true);
      this.provisionalLocalHtmlRuntimes.delete(key);
      this.localHtmlReplacementQueuedInputs
        .get(provisional.replacementTaskKey)
        ?.reject(new Error("The local HTML preview was closed."));
      this.localHtmlReplacementQueuedInputs.delete(provisional.replacementTaskKey);
    }
  }

  private destroyAllRuntimes(): void {
    for (const runtime of [...this.runtimes.values()]) {
      this.destroyRuntime(runtime.threadId, runtime.tabId, undefined, true);
    }
    for (const [key, provisional] of [...this.provisionalLocalHtmlRuntimes]) {
      this.destroyRuntime(provisional.threadId, provisional.tab.id, provisional.tab, true);
      this.provisionalLocalHtmlRuntimes.delete(key);
    }
    for (const [threadId, state] of this.states) {
      for (const tab of state.tabs) {
        if (tab.kind === "artifact" || tab.kind === "local-html") {
          this.destroyRuntime(threadId, tab.id, tab, true);
        }
      }
    }
  }

  private destroyRuntime(
    threadId: ThreadId,
    tabId: string,
    explicitPreviewTab?: BrowserTabState,
    retirePreviewSession = false,
  ): void {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    this.pendingRuntimeSyncs.delete(key);
    this.runtimeLastActiveAtByKey.delete(key);
    const previewTab =
      explicitPreviewTab ??
      this.states.get(threadId)?.tabs.find((tab) => tab.id === tabId) ??
      this.provisionalLocalHtmlRuntimes.get(key)?.tab;
    const previewPartition =
      previewTab && (previewTab.kind === "artifact" || previewTab.kind === "local-html")
        ? previewSessionPartitionForTab(threadId, previewTab)
        : null;
    const runtime = this.runtimes.get(key);
    if (previewPartition && retirePreviewSession) {
      this.requestPreviewSessionRetirement(previewPartition);
    }
    if (!runtime) {
      return;
    }

    const webContents = runtime.webContents;
    if (previewPartition && !this.previewSessionRetirementFinalizers.has(webContents.id)) {
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        webContents.removeListener("destroyed", finalize);
        this.previewSessionRetirementFinalizers.delete(webContents.id);
        this.finalizePreviewSessionOwner(previewPartition, webContents.id);
      };
      this.previewSessionRetirementFinalizers.set(webContents.id, finalize);
      webContents.on("destroyed", finalize);
      if (webContents.isDestroyed()) {
        finalize();
      }
    }

    if (this.attachedRuntimeKey === key) {
      this.detachAttachedRuntime();
    }

    this.runtimes.delete(key);
    for (const disposeListener of runtime.listenerDisposers.splice(0)) {
      disposeListener();
    }
    if (!webContents.isDestroyed()) {
      if (webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach();
        } catch {
          // The runtime is being torn down anyway; ignore stale-debugger cleanup noise.
        }
      }
      if (runtime.ownsWebContents) {
        webContents.close({ waitForBeforeUnload: false });
      }
    }
    if (webContents.isDestroyed() && previewPartition) {
      this.previewSessionRetirementFinalizers.get(webContents.id)?.();
    }
  }

  private findRendererRuntimeByWebContentsId(webContentsId: number): LiveTabRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.ownsWebContents && runtime.webContents.id === webContentsId) {
        return runtime;
      }
    }
    return null;
  }

  private markLocalHtmlHttpError(webContentsId: number, url: string, statusCode: number): void {
    for (const [threadId, state] of this.states) {
      const tab = state.tabs.find((candidate) => {
        if (candidate.kind !== "local-html") return false;
        return (
          this.runtimes.get(buildRuntimeKey(threadId, candidate.id))?.webContents.id ===
          webContentsId
        );
      });
      if (!tab) continue;
      tab.url = url || tab.url;
      tab.title = defaultTitleForUrl(tab.url);
      tab.isLoading = false;
      tab.lastError = `This local HTML page could not be loaded (HTTP ${statusCode}).`;
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
      return;
    }
    this.pendingLocalHtmlHttpErrors.set(webContentsId, statusCode);
  }

  private getOrCreateState(threadId: ThreadId): ThreadBrowserState {
    const existing = this.states.get(threadId);
    if (existing) {
      return existing;
    }

    const initial = defaultThreadBrowserState(threadId);
    this.states.set(threadId, initial);
    this.threadVersionById.set(threadId, 0);
    return initial;
  }

  private markThreadStateChanged(threadId: ThreadId): void {
    const nextVersion = (this.threadVersionById.get(threadId) ?? 0) + 1;
    this.threadVersionById.set(threadId, nextVersion);
    const state = this.states.get(threadId);
    if (state) {
      state.version = nextVersion;
    }
  }

  private snapshotThreadState(
    threadId: ThreadId,
    state = this.getOrCreateState(threadId),
  ): ThreadBrowserState {
    const version = state.version;
    const cached = this.snapshotCacheByThreadId.get(threadId);
    if (cached && cached.version === version) {
      return cached.snapshot;
    }

    const snapshot = cloneThreadState(state);
    this.perfCounters.stateCloneCount += 1;
    this.snapshotCacheByThreadId.set(threadId, {
      version,
      snapshot,
    });
    return snapshot;
  }

  private getTrackedProcessIds(): number[] {
    const processIds = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      const webContents = runtime.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }
      processIds.add(webContents.getProcessId());
    }
    return [...processIds];
  }

  private countWarmInactiveRuntimes(): number {
    let count = 0;
    for (const [key] of this.tabSuspendTimers) {
      if (this.runtimes.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  private resolveInactiveTabSuspendDelay(threadId: ThreadId): number {
    const threadRuntimeCount = [...this.runtimes.values()].filter(
      (runtime) => runtime.threadId === threadId,
    ).length;
    if (
      threadRuntimeCount > BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD + 1 ||
      this.runtimes.size > 4
    ) {
      return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS;
    }

    return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS;
  }

  private ensureWorkspace(
    threadId: ThreadId,
    initialUrl?: string,
    kind: BrowserTabKind = "web",
    displayUrl?: string,
    allowedExternalUrls?: readonly string[],
    previewCwd?: string,
    watchedPaths?: readonly string[],
    sourceIdentity?: string,
    sourceRoot?: string,
    watchDiscoveryLimited?: boolean,
  ): ThreadBrowserState {
    this.ensureSessionConfigured();
    const state = this.getOrCreateState(threadId);
    if (state.tabs.length === 0) {
      const initialTab = createBrowserTab(
        normalizeUrlInput(initialUrl),
        kind,
        displayUrl,
        allowedExternalUrls,
        previewCwd,
        0,
        sourceIdentity,
        sourceRoot,
      );
      this.configureTabSession(threadId, initialTab);
      state.tabs = [initialTab];
      state.activeTabId = initialTab.id;
      this.configureLocalHtmlSourceWatch(threadId, initialTab, watchedPaths, watchDiscoveryLimited);
    }

    if (!state.activeTabId || !state.tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }

    return state;
  }

  private resolveTab(state: ThreadBrowserState, tabId?: string): BrowserTabState {
    const resolvedTabId = tabId ?? state.activeTabId;
    const existing =
      (resolvedTabId ? state.tabs.find((tab) => tab.id === resolvedTabId) : undefined) ??
      state.tabs[0];
    if (existing) {
      return existing;
    }

    const fallback = createBrowserTab();
    state.tabs = [fallback];
    state.activeTabId = fallback.id;
    return fallback;
  }

  private getActiveTab(state: ThreadBrowserState): BrowserTabState | null {
    if (!state.activeTabId) {
      return state.tabs[0] ?? null;
    }
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  }

  private getTab(state: ThreadBrowserState, tabId: string): BrowserTabState | null {
    return state.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  // Resolves the most accurate URL for a tab, preferring the live page over cached state and
  // ignoring blank placeholders so the copy-link chord never yields "about:blank".
  private resolveCopyableTabUrl(
    threadId: ThreadId,
    tabId: string,
    runtime: LiveTabRuntime | undefined,
  ): string | null {
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    if (tab?.kind === "artifact" || tab?.kind === "local-html") {
      return null;
    }
    const liveUrl =
      runtime && !runtime.webContents.isDestroyed() ? runtime.webContents.getURL() : null;
    return resolveCopyableBrowserTabUrl(tab, liveUrl);
  }

  private copyTabLink(threadId: ThreadId, tabId: string): void {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    const url = this.resolveCopyableTabUrl(threadId, tabId, runtime);
    if (!url) {
      return;
    }
    clipboard.writeText(url);
    const event: BrowserCopyLinkEvent = { threadId, tabId, url };
    for (const listener of this.copyLinkListeners) {
      listener(event);
    }
  }

  private emitState(threadId: ThreadId): void {
    this.perfCounters.stateEmitCalls += 1;
    const state = this.getOrCreateState(threadId);
    const nextVersion = state.version;
    if (this.lastEmittedVersionByThreadId.get(threadId) === nextVersion) {
      this.perfCounters.stateEmitSkips += 1;
      return;
    }
    this.lastEmittedVersionByThreadId.set(threadId, nextVersion);
    const snapshot = this.snapshotThreadState(threadId, state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

// Applies spoofed request headers with one case-insensitive scan per request.
function withRequestHeadersCaseInsensitive(
  headers: Record<string, string>,
  replacements: Record<string, string>,
): Record<string, string> {
  const replacementNamesByLower = new Set(
    Object.keys(replacements).map((name) => name.toLowerCase()),
  );
  for (const existing of Object.keys(headers)) {
    if (replacementNamesByLower.has(existing.toLowerCase())) {
      delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(replacements)) {
    headers[name] = value;
  }
  return headers;
}

function setIfChanged<T>(current: T, next: T, apply: (value: T) => void): boolean {
  if (Object.is(current, next)) {
    return false;
  }
  apply(next);
  return true;
}

function suspendTabState(tab: BrowserTabState): boolean {
  let didChange = false;
  didChange =
    setIfChanged(tab.status, SUSPENDED_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, false, (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, false, (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, false, (value) => {
      tab.canGoForward = value;
    }) || didChange;
  return didChange;
}

function syncTabStateFromRuntime(
  state: ThreadBrowserState,
  tab: BrowserTabState,
  webContents: WebContents,
  faviconUrls?: string[],
): boolean {
  const currentUrl = webContents.getURL();
  const nextUrl = currentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  let didChange = false;
  didChange =
    setIfChanged(tab.status, LIVE_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.url, nextUrl, (value) => {
      tab.url = value;
    }) || didChange;
  const resolvedTitle =
    !nextTitle || nextTitle === ABOUT_BLANK_URL ? defaultTitleForUrl(nextUrl) : nextTitle;
  didChange =
    setIfChanged(tab.title, resolvedTitle, (value) => {
      tab.title = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, webContents.isLoading(), (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, canWebContentsGoBack(webContents), (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, canWebContentsGoForward(webContents), (value) => {
      tab.canGoForward = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.lastCommittedUrl, currentUrl || tab.lastCommittedUrl, (value) => {
      tab.lastCommittedUrl = value;
    }) || didChange;
  if (faviconUrls) {
    didChange =
      setIfChanged(tab.faviconUrl, faviconUrls[0] ?? tab.faviconUrl, (value) => {
        tab.faviconUrl = value;
      }) || didChange;
  }
  // Keep a terminal load failure visible after Electron emits
  // `did-stop-loading`. A later navigation's `did-start-loading` handler owns
  // clearing the error, so retry and successful navigation still recover.
  didChange = syncThreadLastError(state) || didChange;
  return didChange;
}

function canWebContentsGoBack(webContents: WebContents): boolean {
  return webContents.navigationHistory?.canGoBack() ?? webContents.canGoBack();
}

function canWebContentsGoForward(webContents: WebContents): boolean {
  return webContents.navigationHistory?.canGoForward() ?? webContents.canGoForward();
}

function syncThreadLastError(state: ThreadBrowserState): boolean {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  const nextLastError = activeTab?.lastError ?? null;
  if (state.lastError === nextLastError) {
    return false;
  }
  state.lastError = nextLastError;
  return true;
}
