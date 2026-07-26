// FILE: browserManager.reliability.test.ts
// Purpose: Verifies browser session closure and recovery from destroyed Electron runtimes.
// Layer: Desktop unit test
// Depends on: DesktopBrowserManager with a minimal Electron session mock

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = vi.hoisted(() => {
  const createdWebContents: Array<{
    id: number;
    loadURL: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destroy: () => void;
    setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>;
    handlers: Map<string, Array<(...args: any[]) => void>>;
    windowOpenHandler: ((details: any) => { action: string }) | null;
  }> = [];
  const createdWebContentsViewPreferences: Array<Record<string, unknown>> = [];
  const createdViews: Array<{
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
  }> = [];
  const sessions = new Map<
    string,
    {
      setUserAgent: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      removeAllListeners: ReturnType<typeof vi.fn>;
      clearStorageData: ReturnType<typeof vi.fn>;
      clearCache: ReturnType<typeof vi.fn>;
      setProxy: ReturnType<typeof vi.fn>;
      resolveHost: ReturnType<typeof vi.fn>;
      webRequest: {
        onBeforeSendHeaders: ReturnType<typeof vi.fn>;
        onBeforeRequest: ReturnType<typeof vi.fn>;
        onCompleted: ReturnType<typeof vi.fn>;
      };
    }
  >();
  let nextWebContentsId = 1;
  let setProxyImplementation = async (): Promise<void> => {
    void nextWebContentsId;
  };
  let loadURLImplementation = async (_url: string, _webContentsId: number): Promise<void> => {
    void nextWebContentsId;
  };
  let holdWebContentsDestruction = false;

  function createWebContents() {
    let currentUrl = "about:blank";
    let destroyed = false;
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const webContents = {
      id: nextWebContentsId++,
      debugger: {
        isAttached: () => false,
        detach: vi.fn(),
      },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
      isDestroyed: () => destroyed,
      getURL: () => currentUrl,
      getTitle: () => currentUrl,
      isLoading: () => false,
      getProcessId: () => 42,
      loadURL: vi.fn(async (url: string) => {
        currentUrl = url;
        await loadURLImplementation(url, webContents.id);
      }),
      setUserAgent: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      handlers,
      windowOpenHandler: null as ((details: any) => { action: string }) | null,
      setWindowOpenHandler: vi.fn((handler: (details: any) => { action: string }) => {
        webContents.windowOpenHandler = handler;
      }),
      on: vi.fn((name: string, handler: (...args: any[]) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      }),
      removeListener: vi.fn((name: string, handler: (...args: any[]) => void) => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((candidate) => candidate !== handler),
        );
      }),
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        for (const handler of handlers.get("destroyed") ?? []) {
          handler();
        }
      },
      close: vi.fn(() => {
        if (!holdWebContentsDestruction) {
          webContents.destroy();
        }
      }),
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      openDevTools: vi.fn(),
    };
    createdWebContents.push(webContents);
    return webContents;
  }

  function sessionFor(partition: string) {
    let existing = sessions.get(partition);
    if (existing) return existing;
    existing = {
      setUserAgent: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      setProxy: vi.fn(() => setProxyImplementation()),
      resolveHost: vi.fn(async (hostname: string) => ({
        endpoints: [
          {
            address:
              hostname === "private.example" || hostname.endsWith(".nip.io")
                ? "127.0.0.1"
                : "93.184.216.34",
            family: "ipv4",
          },
        ],
      })),
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
      },
    };
    sessions.set(partition, existing);
    return existing;
  }

  return {
    createdWebContents,
    createdWebContentsViewPreferences,
    createdViews,
    sessions,
    createWebContents,
    setProxyImplementation: (implementation: () => Promise<void>) => {
      setProxyImplementation = implementation;
    },
    setLoadURLImplementation: (
      implementation: (url: string, webContentsId: number) => Promise<void>,
    ) => {
      loadURLImplementation = implementation;
    },
    setHoldWebContentsDestruction: (hold: boolean) => {
      holdWebContentsDestruction = hold;
    },
    sessionFor,
  };
});

vi.mock("electron", () => ({
  app: {
    userAgentFallback: "Mozilla/5.0 Chrome/124.0.0.0 Electron/40.0.0 Scient/0.5.12 Safari/537.36",
    getName: () => "Scient",
    getPreferredSystemLanguages: () => ["en-US"],
  },
  BrowserWindow: class {
    readonly mocked = true;
  },
  clipboard: {
    writeImage: vi.fn(),
    writeText: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
  session: {
    fromPartition: (partition: string) => electron.sessionFor(partition),
  },
  shell: {
    openExternal: vi.fn(),
  },
  webContents: {
    fromId: vi.fn(),
  },
  WebContentsView: class {
    readonly webContents = electron.createWebContents();
    readonly setBounds = vi.fn();
    readonly setBackgroundColor = vi.fn();
    readonly setVisible = vi.fn();

    constructor(options: { webPreferences?: Record<string, unknown> }) {
      electron.createdWebContentsViewPreferences.push(options.webPreferences ?? {});
      electron.createdViews.push(this);
    }
  },
}));

import type { ThreadId } from "@synara/contracts";

import { DesktopBrowserManager } from "./browserManager";

const THREAD_ID = "thread-close-tab" as ThreadId;

describe("DesktopBrowserManager reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.createdWebContents.splice(0);
    electron.createdWebContentsViewPreferences.splice(0);
    electron.createdViews.splice(0);
    electron.sessions.clear();
    electron.setProxyImplementation(async () => undefined);
    electron.setLoadURLImplementation(async () => undefined);
    electron.setHoldWebContentsDestruction(false);
  });

  it("closes the browser session when its final tab closes", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;

    expect(tabId).toBeTruthy();
    const closed = manager.closeTab({
      threadId: THREAD_ID,
      tabId: tabId ?? "",
    });

    expect(closed.open).toBe(false);
    expect(closed.tabs).toEqual([]);
    expect(closed.activeTabId).toBeNull();
    manager.dispose();
  });

  it("keeps the browser open while another tab remains", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const firstTabId = opened.activeTabId;
    const withSecondTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://example.com/",
    });

    const next = manager.closeTab({
      threadId: THREAD_ID,
      tabId: firstTabId ?? "",
    });

    expect(next.open).toBe(true);
    expect(next.tabs).toHaveLength(1);
    expect(next.activeTabId).toBe(withSecondTab.activeTabId);
    manager.dispose();
  });

  it("selects the adjacent tab when the active tab closes", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const firstTabId = opened.activeTabId;
    const withSecondTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example/",
    });
    const secondTabId = withSecondTab.activeTabId;
    const withThirdTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://third.example/",
    });

    manager.selectTab({ threadId: THREAD_ID, tabId: firstTabId ?? "" });
    const afterClosingFirst = manager.closeTab({
      threadId: THREAD_ID,
      tabId: firstTabId ?? "",
    });
    expect(afterClosingFirst.activeTabId).toBe(secondTabId);

    manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId ?? "" });
    const afterClosingSecond = manager.closeTab({
      threadId: THREAD_ID,
      tabId: secondTabId ?? "",
    });
    expect(afterClosingSecond.activeTabId).toBe(withThirdTab.activeTabId);
    manager.dispose();
  });

  it("replaces a destroyed tracked runtime before navigating", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    expect(tabId).toBeTruthy();

    const runtimeKey = `${THREAD_ID}:${tabId}`;
    const internals = manager as unknown as {
      runtimes: Map<
        string,
        {
          key: string;
          threadId: ThreadId;
          tabId: string;
          webContents: { isDestroyed: () => boolean };
          view: null;
          ownsWebContents: boolean;
          listenerDisposers: Array<() => void>;
        }
      >;
    };
    internals.runtimes.set(runtimeKey, {
      key: runtimeKey,
      threadId: THREAD_ID,
      tabId: tabId ?? "",
      webContents: { isDestroyed: () => true },
      view: null,
      ownsWebContents: true,
      listenerDisposers: [],
    });

    expect(() =>
      manager.navigate({
        threadId: THREAD_ID,
        tabId: tabId ?? "",
        url: "https://example.com/",
      }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(electron.createdWebContents).toHaveLength(1);
      expect(electron.createdWebContents[0]?.loadURL).toHaveBeenCalledWith("https://example.com/");
    });
    expect(manager.getState({ threadId: THREAD_ID }).lastError).toBeNull();
    manager.dispose();
  });

  it("hides and restores a native local HTML view without suspending or resurrecting it", () => {
    const manager = new DesktopBrowserManager();
    const contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    manager.setWindow({ contentView } as never);
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    manager.open({
      threadId: THREAD_ID,
      initialUrl: previewUrl,
      kind: "local-html",
    });
    const bounds = { x: 10, y: 20, width: 640, height: 480 };

    manager.setPanelBounds({ threadId: THREAD_ID, bounds, surface: "native", occluded: false });
    const view = electron.createdViews.at(-1);
    expect(view).toBeDefined();
    if (!view) throw new Error("Expected a native local HTML view.");
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds);

    manager.setPanelBounds({ threadId: THREAD_ID, bounds, surface: "native", occluded: true });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    const internals = manager as unknown as {
      activeThreadId: ThreadId | null;
      suspendTimers: Map<ThreadId, unknown>;
    };
    expect(internals.activeThreadId).toBe(THREAD_ID);
    expect(internals.suspendTimers.has(THREAD_ID)).toBe(false);

    manager.setPanelBounds({ threadId: THREAD_ID, bounds, surface: "native", occluded: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds).toHaveBeenLastCalledWith(bounds);

    manager.setPanelBounds({ threadId: THREAD_ID, bounds, surface: "native", occluded: true });
    const visibleCallsBeforeClose = view.setVisible.mock.calls.filter(
      ([visible]) => visible,
    ).length;
    manager.close({ threadId: THREAD_ID });
    manager.setPanelBounds({ threadId: THREAD_ID, bounds, surface: "native", occluded: false });
    expect(view.setVisible.mock.calls.filter(([visible]) => visible)).toHaveLength(
      visibleCallsBeforeClose,
    );
    manager.dispose();
  });

  it("isolates local HTML requests in a per-tab session and clears it on close", async () => {
    const manager = new DesktopBrowserManager();
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previewUrl,
      kind: "local-html",
      allowedExternalUrls: [
        "https://cdn.example/app.js",
        "https://private.example/declared.js",
        "https://127.0.0.1.nip.io/asset.js",
      ],
    });
    const tabId = opened.activeTabId;
    expect(tabId).toBeTruthy();

    const partition = `scient-local-html-preview-${THREAD_ID}-${tabId}`;
    const previewSession = electron.sessions.get(partition);
    expect(previewSession).toBeDefined();
    expect(partition.startsWith("persist:")).toBe(false);

    const beforeRequest = previewSession?.webRequest.onBeforeRequest.mock.calls[0]?.[0];
    expect(beforeRequest).toBeTypeOf("function");
    const exactOriginResult = vi.fn();
    beforeRequest(
      { url: `${previewUrl}app.js`, method: "GET", resourceType: "script" },
      exactOriginResult,
    );
    expect(exactOriginResult).toHaveBeenCalledWith({ cancel: false });
    const publicResult = vi.fn();
    beforeRequest(
      {
        url: "https://cdn.example/app.js",
        method: "GET",
        resourceType: "script",
      },
      publicResult,
    );
    await vi.waitFor(() => expect(publicResult).toHaveBeenCalledWith({ cancel: false }));
    const dnsPrivateResult = vi.fn();
    beforeRequest(
      {
        url: "https://private.example/declared.js",
        method: "GET",
        resourceType: "script",
      },
      dnsPrivateResult,
    );
    await vi.waitFor(() => expect(dnsPrivateResult).toHaveBeenCalledWith({ cancel: true }));
    const rebindingResult = vi.fn();
    beforeRequest(
      {
        url: "https://127.0.0.1.nip.io/asset.js",
        method: "GET",
        resourceType: "script",
      },
      rebindingResult,
    );
    await vi.waitFor(() => expect(rebindingResult).toHaveBeenCalledWith({ cancel: true }));
    const privateResult = vi.fn();
    beforeRequest(
      {
        url: "http://127.0.0.1:8080/private",
        method: "GET",
        resourceType: "xhr",
      },
      privateResult,
    );
    expect(privateResult).toHaveBeenCalledWith({ cancel: true });
    const fileResult = vi.fn();
    beforeRequest({ url: "file:///etc/passwd", method: "GET", resourceType: "other" }, fileResult);
    expect(fileResult).toHaveBeenCalledWith({ cancel: true });

    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, tabId ?? "");
    const contents = electron.createdWebContents.at(-1);
    expect(electron.createdWebContentsViewPreferences.at(-1)).toMatchObject({
      nodeIntegration: false,
      sandbox: true,
    });
    expect(contents?.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
    expect(previewSession?.setProxy).not.toHaveBeenCalled();
    const completed = previewSession?.webRequest.onCompleted.mock.calls[0]?.[0];
    expect(completed).toBeTypeOf("function");
    completed({
      resourceType: "mainFrame",
      statusCode: 404,
      webContentsId: contents?.id,
      url: `${previewUrl}missing.html`,
    });
    expect(manager.getState({ threadId: THREAD_ID }).lastError).toContain("HTTP 404");

    manager.close({ threadId: THREAD_ID });
    await vi.waitFor(() => {
      expect(previewSession?.clearStorageData).toHaveBeenCalledOnce();
      expect(previewSession?.clearCache).toHaveBeenCalledOnce();
      expect(previewSession?.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    });
    expect(previewSession?.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(previewSession?.webRequest.onCompleted).toHaveBeenLastCalledWith(null);
    expect(previewSession?.setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(previewSession?.setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
    expect(previewSession?.removeAllListeners).toHaveBeenCalledWith("will-download");
    manager.dispose();
  });

  it("atomically replaces a local HTML runtime only after the fresh capability loads", async () => {
    const manager = new DesktopBrowserManager();
    const previousUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const nextUrl = "http://g-22345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previousUrl,
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
    });
    const previousTabId = opened.activeTabId ?? "";
    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, previousTabId);
    const previousContents = electron.createdWebContents.at(-1);
    electron.setHoldWebContentsDestruction(true);

    const replaced = await manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: previousTabId,
      url: nextUrl,
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html", "/missing/theme.css"],
      activate: true,
    });

    expect(replaced.tabs).toHaveLength(1);
    expect(replaced.activeTabId).not.toBe(previousTabId);
    expect(replaced.tabs[0]).toMatchObject({
      kind: "local-html",
      url: nextUrl,
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      lastError: null,
    });
    expect(replaced.tabs[0]?.sourceChanged).toBeUndefined();
    expect(electron.createdWebContents.at(-1)?.loadURL).toHaveBeenCalledWith(nextUrl);
    expect(previousContents?.close).toHaveBeenCalledOnce();
    const previousPartition = `scient-local-html-preview-${THREAD_ID}-${previousTabId}`;
    const previousSession = electron.sessions.get(previousPartition);
    expect(previousSession?.clearStorageData).not.toHaveBeenCalled();
    expect(previousSession?.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(
      expect.any(Function),
    );
    expect(previousSession?.setPermissionCheckHandler).toHaveBeenLastCalledWith(
      expect.any(Function),
    );
    expect(previousSession?.setPermissionRequestHandler).toHaveBeenLastCalledWith(
      expect.any(Function),
    );
    expect(previousSession?.removeAllListeners).not.toHaveBeenCalled();
    expect(previousSession?.setProxy).not.toHaveBeenCalledWith({ mode: "direct" });
    const closingRequestGuard = previousSession?.webRequest.onBeforeRequest.mock.calls.at(-1)?.[0];
    const closingRequestResult = vi.fn();
    closingRequestGuard(
      { url: "https://attacker.example/x.js", method: "GET", resourceType: "script" },
      closingRequestResult,
    );
    expect(closingRequestResult).toHaveBeenCalledWith({ cancel: true });
    const closingPermissionCheck =
      previousSession?.setPermissionCheckHandler.mock.calls.at(-1)?.[0];
    expect(closingPermissionCheck()).toBe(false);
    const closingPermissionRequest =
      previousSession?.setPermissionRequestHandler.mock.calls.at(-1)?.[0];
    const permissionResult = vi.fn();
    closingPermissionRequest(undefined, "media", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
    const closingDownloadGuard = previousSession?.on.mock.calls.find(
      ([eventName]) => eventName === "will-download",
    )?.[1];
    const downloadEvent = { preventDefault: vi.fn() };
    closingDownloadGuard(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    previousContents?.destroy();
    await vi.waitFor(() => {
      expect(previousSession?.clearStorageData).toHaveBeenCalledOnce();
      expect(previousSession?.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    });
    expect(previousSession?.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(previousSession?.webRequest.onCompleted).toHaveBeenLastCalledWith(null);
    expect(previousSession?.setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(previousSession?.setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
    expect(previousSession?.removeAllListeners).toHaveBeenCalledWith("will-download");
    manager.dispose();
  });

  it("keeps the working local HTML runtime when a prepared replacement cannot load", async () => {
    const manager = new DesktopBrowserManager();
    const previousUrl = "http://g-32345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previousUrl,
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const previousTabId = opened.activeTabId ?? "";
    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, previousTabId);
    const previousContents = electron.createdWebContents.at(-1);
    electron.setLoadURLImplementation(async () => {
      throw new Error("ERR_CONNECTION_REFUSED");
    });

    await expect(
      manager.replaceLocalHtmlPreview({
        threadId: THREAD_ID,
        tabId: previousTabId,
        url: "http://g-42345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
        displayUrl: "/missing/report.html",
        previewCwd: "/missing",
        watchedPaths: ["/missing/report.html"],
      }),
    ).rejects.toThrow("could not be loaded");

    const preserved = manager.getState({ threadId: THREAD_ID });
    expect(preserved.tabs).toHaveLength(1);
    expect(preserved.activeTabId).toBe(previousTabId);
    expect(preserved.tabs[0]?.url).toBe(previousUrl);
    expect(previousContents?.close).not.toHaveBeenCalled();
    expect(electron.createdWebContents.at(-1)?.close).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("rejects an HTTP-error replacement without discarding the previous page", async () => {
    const manager = new DesktopBrowserManager();
    const previousUrl = "http://g-a2345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previousUrl,
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const previousTabId = opened.activeTabId ?? "";
    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, previousTabId);
    const previousContents = electron.createdWebContents.at(-1);
    electron.setLoadURLImplementation(async (url, webContentsId) => {
      const newestSession = [...electron.sessions.values()].at(-1);
      const onCompleted = newestSession?.webRequest.onCompleted.mock.calls[0]?.[0];
      onCompleted?.({
        resourceType: "mainFrame",
        statusCode: 404,
        webContentsId,
        url,
      });
    });

    await expect(
      manager.replaceLocalHtmlPreview({
        threadId: THREAD_ID,
        tabId: previousTabId,
        url: "http://g-b2345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
        displayUrl: "/missing/report.html",
        previewCwd: "/missing",
        watchedPaths: ["/missing/report.html"],
      }),
    ).rejects.toThrow("HTTP 404");

    const preserved = manager.getState({ threadId: THREAD_ID });
    expect(preserved.activeTabId).toBe(previousTabId);
    expect(preserved.tabs[0]?.url).toBe(previousUrl);
    expect(previousContents?.close).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("refreshes a background local HTML tab without stealing focus", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-82345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const sourceTabId = opened.activeTabId ?? "";
    const withWebTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://example.com/",
      kind: "web",
      activate: true,
    });
    const activeWebTabId = withWebTab.activeTabId;

    const replaced = await manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: sourceTabId,
      url: "http://g-92345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
      activate: false,
    });

    expect(replaced.tabs).toHaveLength(2);
    expect(replaced.activeTabId).toBe(activeWebTabId);
    expect(replaced.tabs.some((tab) => tab.id === sourceTabId)).toBe(false);
    expect(replaced.tabs.find((tab) => tab.kind === "local-html")?.displayUrl).toBe(
      "/missing/report.html",
    );
    manager.dispose();
  });

  it("does not reactivate a local HTML tab after the user switches away during refresh", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-c2345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    let releaseLoad: (() => void) | undefined;
    electron.setLoadURLImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const replacement = manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: opened.activeTabId ?? "",
      url: "http://g-d2345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
      activate: true,
    });
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"));
    const withWebTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://example.com/",
      kind: "web",
      activate: true,
    });
    const selectedWebTabId = withWebTab.activeTabId;
    releaseLoad?.();

    const replaced = await replacement;
    expect(replaced.activeTabId).toBe(selectedWebTabId);
    expect(replaced.tabs.find((tab) => tab.kind === "local-html")?.url).toContain("g-d2345678");
    manager.dispose();
  });

  it("reuses one tab when concurrent callers open the same local HTML source", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-e2345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const deduplicated = manager.newTab({
      threadId: THREAD_ID,
      url: "http://g-f2345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      activate: true,
    });

    expect(deduplicated.tabs).toHaveLength(1);
    expect(deduplicated.activeTabId).toBe(opened.activeTabId);
    expect(deduplicated.tabs[0]?.url).toContain("g-e2345678");
    manager.dispose();
  });

  it("coalesces concurrent replacement requests for the same source tab", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-52345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    let releaseLoad: (() => void) | undefined;
    electron.setLoadURLImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );
    const input = {
      threadId: THREAD_ID,
      tabId: opened.activeTabId ?? "",
      url: "http://g-62345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
    };

    const first = manager.replaceLocalHtmlPreview(input);
    const second = manager.replaceLocalHtmlPreview(input);
    expect(second).toBe(first);
    expect(electron.createdWebContents).toHaveLength(1);
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"));
    releaseLoad?.();
    await expect(first).resolves.toMatchObject({ tabs: [{ url: input.url }] });
    manager.dispose();
  });

  it("destroys a provisional local HTML runtime and session when the browser closes", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-10345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    let releaseLoad: (() => void) | undefined;
    electron.setLoadURLImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const replacement = manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: opened.activeTabId ?? "",
      url: "http://g-11345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
    });
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"));
    const provisionalContents = electron.createdWebContents.at(-1);
    const provisionalSession = [...electron.sessions.values()].at(-1);
    electron.setHoldWebContentsDestruction(true);

    manager.close({ threadId: THREAD_ID });

    expect(provisionalContents?.close).toHaveBeenCalledOnce();
    expect(provisionalSession?.clearStorageData).not.toHaveBeenCalled();
    expect(provisionalSession?.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(
      expect.any(Function),
    );
    provisionalContents?.destroy();
    await vi.waitFor(() => {
      expect(provisionalSession?.clearStorageData).toHaveBeenCalledOnce();
      expect(provisionalSession?.clearCache).toHaveBeenCalledOnce();
      expect(provisionalSession?.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    });
    releaseLoad?.();
    await expect(replacement).rejects.toThrow("could not be loaded");
    manager.dispose();
  });

  it("destroys a provisional local HTML runtime when the final source tab closes", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-12345678-2234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const sourceTabId = opened.activeTabId ?? "";
    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, sourceTabId);
    const sourceContents = electron.createdWebContents.at(-1);
    const sourceSession = electron.sessions.get(
      `scient-local-html-preview-${THREAD_ID}-${sourceTabId}`,
    );
    let releaseLoad: (() => void) | undefined;
    electron.setLoadURLImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const replacement = manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: sourceTabId,
      url: "http://g-13345678-2234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
    });
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"));
    const provisionalContents = electron.createdWebContents.at(-1);
    const provisionalSession = [...electron.sessions.values()].at(-1);
    electron.setHoldWebContentsDestruction(true);

    const closed = manager.closeTab({
      threadId: THREAD_ID,
      tabId: sourceTabId,
    });

    expect(closed).toMatchObject({ open: false, activeTabId: null, tabs: [] });
    expect(sourceContents?.close).toHaveBeenCalledOnce();
    expect(provisionalContents?.close).toHaveBeenCalledOnce();
    expect(sourceSession?.clearStorageData).not.toHaveBeenCalled();
    expect(provisionalSession?.clearStorageData).not.toHaveBeenCalled();
    sourceContents?.destroy();
    provisionalContents?.destroy();
    await vi.waitFor(() => {
      expect(sourceSession?.clearStorageData).toHaveBeenCalledOnce();
      expect(provisionalSession?.clearStorageData).toHaveBeenCalledOnce();
    });
    releaseLoad?.();
    await expect(replacement).rejects.toThrow("could not be loaded");
    manager.dispose();
  });

  it("destroys a provisional replacement when its source tab closes beside another tab", async () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: "http://g-1a345678-2234-4123-8123-123456789abc.preview.localhost:43123/",
      kind: "local-html",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
    });
    const sourceTabId = opened.activeTabId ?? "";
    manager.newTab({
      threadId: THREAD_ID,
      url: "https://example.com/",
      kind: "web",
      activate: true,
    });
    let releaseLoad: (() => void) | undefined;
    electron.setLoadURLImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const replacement = manager.replaceLocalHtmlPreview({
      threadId: THREAD_ID,
      tabId: sourceTabId,
      url: "http://g-1b345678-2234-4123-8123-123456789abc.preview.localhost:43123/",
      displayUrl: "/missing/report.html",
      previewCwd: "/missing",
      watchedPaths: ["/missing/report.html"],
    });
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"));
    const provisionalContents = electron.createdWebContents.at(-1);

    const remaining = manager.closeTab({ threadId: THREAD_ID, tabId: sourceTabId });

    expect(remaining.open).toBe(true);
    expect(remaining.tabs).toHaveLength(1);
    expect(remaining.tabs[0]?.kind).toBe("web");
    expect(provisionalContents?.close).toHaveBeenCalledOnce();
    releaseLoad?.();
    await expect(replacement).rejects.toThrow("could not be loaded");
    manager.dispose();
  });

  it("keeps one logical-source queue after a replacement changes the tab id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scient-html-queued-refresh-"));
    const assetDirectory = join(directory, "assets");
    await mkdir(assetDirectory);
    const sourcePath = join(directory, "report.html");
    const assetPath = join(assetDirectory, "theme.css");
    await writeFile(sourcePath, "<p>first</p>", "utf8");
    await writeFile(assetPath, "body {}", "utf8");
    const manager = new DesktopBrowserManager();
    try {
      const opened = manager.open({
        threadId: THREAD_ID,
        initialUrl: "http://g-14345678-2234-4123-8123-123456789abc.preview.localhost:43123/",
        kind: "local-html",
        displayUrl: sourcePath,
        previewCwd: directory,
      });
      const sourceTabId = opened.activeTabId ?? "";
      const withWebTab = manager.newTab({
        threadId: THREAD_ID,
        url: "https://example.com/",
        kind: "web",
        activate: true,
      });
      const webTabId = withWebTab.activeTabId;
      let releaseFirstLoad: (() => void) | undefined;
      let releaseSecondLoad: (() => void) | undefined;
      let loadCount = 0;
      electron.setLoadURLImplementation(async () => {
        loadCount += 1;
        if (loadCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstLoad = resolve;
          });
        } else if (loadCount === 2) {
          await new Promise<void>((resolve) => {
            releaseSecondLoad = resolve;
          });
        }
      });
      const firstUrl = "http://g-15345678-2234-4123-8123-123456789abc.preview.localhost:43123/";
      const secondUrl = "http://g-16345678-2234-4123-8123-123456789abc.preview.localhost:43123/";
      const newestUrl = "http://g-17345678-2234-4123-8123-123456789abc.preview.localhost:43123/";

      const first = manager.replaceLocalHtmlPreview({
        threadId: THREAD_ID,
        tabId: sourceTabId,
        url: firstUrl,
        displayUrl: sourcePath,
        previewCwd: directory,
        watchedPaths: [sourcePath],
        allowedExternalUrls: ["https://cdn.example/first.js"],
        activate: false,
      });
      await vi.waitFor(() => expect(releaseFirstLoad).toBeTypeOf("function"));
      const second = manager.replaceLocalHtmlPreview({
        threadId: THREAD_ID,
        tabId: sourceTabId,
        url: secondUrl,
        displayUrl: sourcePath,
        previewCwd: directory,
        watchedPaths: [sourcePath],
        allowedExternalUrls: ["https://cdn.example/second.js"],
        activate: false,
      });
      expect(second).toBe(first);
      expect(manager.getState({ threadId: THREAD_ID }).activeTabId).toBe(webTabId);
      releaseFirstLoad?.();
      await vi.waitFor(() => expect(releaseSecondLoad).toBeTypeOf("function"));

      const installedFirstTab = manager
        .getState({ threadId: THREAD_ID })
        .tabs.find((tab) => tab.kind === "local-html");
      expect(installedFirstTab).toMatchObject({ url: firstUrl });
      expect(installedFirstTab?.id).not.toBe(sourceTabId);
      const newest = manager.replaceLocalHtmlPreview({
        threadId: THREAD_ID,
        tabId: installedFirstTab?.id ?? "",
        url: newestUrl,
        displayUrl: sourcePath,
        previewCwd: directory,
        watchedPaths: [sourcePath, assetPath],
        allowedExternalUrls: ["https://cdn.example/newest.js"],
        activate: true,
      });
      expect(newest).toBe(first);
      releaseSecondLoad?.();

      const finalState = await newest;
      const finalTab = finalState.tabs.find((tab) => tab.kind === "local-html");
      expect(
        electron.createdWebContents.map((contents) => contents.loadURL.mock.calls[0]?.[0]),
      ).toEqual([firstUrl, secondUrl, newestUrl]);
      expect(finalTab).toMatchObject({
        url: newestUrl,
        allowedExternalUrls: ["https://cdn.example/newest.js"],
      });
      expect(finalState.activeTabId).toBe(finalTab?.id);
      const internals = manager as unknown as {
        localHtmlSourceWatches: Map<string, { watchers: unknown[] }>;
      };
      expect([...internals.localHtmlSourceWatches.values()].at(-1)?.watchers).toHaveLength(2);
    } finally {
      manager.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects an atomic replacement of a watched HTML source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scient-html-watch-"));
    const sourcePath = join(directory, "report.html");
    const replacementPath = join(directory, "report.next.html");
    await writeFile(sourcePath, "<p>before</p>", "utf8");
    const manager = new DesktopBrowserManager();
    try {
      const opened = manager.open({
        threadId: THREAD_ID,
        initialUrl: "http://g-72345678-1234-4123-8123-123456789abc.preview.localhost:43123/",
        kind: "local-html",
        displayUrl: sourcePath,
        previewCwd: directory,
        watchedPaths: [sourcePath],
      });
      await writeFile(replacementPath, "<p>after</p>", "utf8");
      await rename(replacementPath, sourcePath);

      await vi.waitFor(
        () => {
          const current = manager.getState({ threadId: THREAD_ID });
          expect(current.tabs.find((tab) => tab.id === opened.activeTabId)?.sourceChanged).toBe(
            true,
          );
        },
        { timeout: 2_000 },
      );
    } finally {
      manager.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps same-origin local navigation and denies cross-origin navigation", () => {
    const manager = new DesktopBrowserManager();
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previewUrl,
      kind: "local-html",
    });
    const tabId = opened.activeTabId;
    expect(tabId).toBeTruthy();
    const partition = `scient-local-html-preview-${THREAD_ID}-${tabId}`;
    expect(electron.sessions.get(partition)?.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:1;https=127.0.0.1:1;socks=127.0.0.1:1",
      proxyBypassRules:
        "<-loopback>;g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123",
    });

    const internals = manager as unknown as {
      ensureLiveRuntime: (threadId: ThreadId, tabId: string) => unknown;
    };
    internals.ensureLiveRuntime(THREAD_ID, tabId ?? "");
    const contents = electron.createdWebContents.at(-1);
    const navigate = contents?.handlers.get("will-frame-navigate")?.[0];
    expect(navigate).toBeTypeOf("function");
    if (!navigate) throw new Error("Expected local HTML navigation policy listener.");

    const sameOriginEvent = {
      url: `${previewUrl}linked.html`,
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    navigate(sameOriginEvent);
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();

    const privateEvent = {
      url: "http://localhost:9000/admin",
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    navigate(privateEvent);
    expect(privateEvent.preventDefault).toHaveBeenCalledOnce();
    expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);

    const publicEvent = {
      url: "https://example.com/reference",
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    navigate(publicEvent);
    expect(publicEvent.preventDefault).toHaveBeenCalledOnce();
    expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(1);
    manager.dispose();
  });

  it("waits for the interactive preview network boundary before loading", async () => {
    let releaseProxy: () => void = () => undefined;
    const proxyReady = new Promise<void>((resolve) => {
      releaseProxy = resolve;
    });
    electron.setProxyImplementation(() => proxyReady);
    const manager = new DesktopBrowserManager();
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previewUrl,
      kind: "local-html",
    });
    const tabId = opened.activeTabId;
    expect(tabId).toBeTruthy();

    const internals = manager as unknown as {
      loadTab: (threadId: ThreadId, tabId: string, options: { force: boolean }) => Promise<void>;
    };
    const load = internals.loadTab(THREAD_ID, tabId ?? "", { force: true });
    await Promise.resolve();
    expect(electron.createdWebContents.at(-1)?.loadURL).not.toHaveBeenCalled();

    releaseProxy();
    await load;
    expect(electron.createdWebContents.at(-1)?.loadURL).toHaveBeenCalledWith(previewUrl);
    manager.dispose();
  });

  it("deduplicates interactive preview retries before reloading the original URL", async () => {
    let proxyAttempts = 0;
    let releaseRetry: () => void = () => undefined;
    const retryReady = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    electron.setProxyImplementation(() => {
      proxyAttempts += 1;
      if (proxyAttempts === 1) {
        return Promise.reject(new Error("proxy setup failed"));
      }
      return retryReady;
    });
    const manager = new DesktopBrowserManager();
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:43123/";
    const opened = manager.open({
      threadId: THREAD_ID,
      initialUrl: previewUrl,
      kind: "local-html",
    });
    const tabId = opened.activeTabId;
    expect(tabId).toBeTruthy();

    const internals = manager as unknown as {
      loadTab: (threadId: ThreadId, tabId: string, options: { force: boolean }) => Promise<void>;
    };
    await internals.loadTab(THREAD_ID, tabId ?? "", { force: true });
    const contents = electron.createdWebContents.at(-1);
    expect(contents?.loadURL).not.toHaveBeenCalled();
    expect(manager.getState({ threadId: THREAD_ID }).lastError).toBe("Couldn't open this page.");

    manager.reload({ threadId: THREAD_ID, tabId: tabId ?? "" });
    const pending = manager.reload({ threadId: THREAD_ID, tabId: tabId ?? "" });
    expect(pending.lastError).toBeNull();
    expect(pending.tabs.find((tab) => tab.id === tabId)?.isLoading).toBe(true);
    expect(proxyAttempts).toBe(2);
    expect(contents?.loadURL).not.toHaveBeenCalled();

    releaseRetry();
    await vi.waitFor(() => expect(contents?.loadURL).toHaveBeenCalledWith(previewUrl));
    expect(manager.getState({ threadId: THREAD_ID }).lastError).toBeNull();
    expect(contents?.reload).not.toHaveBeenCalled();
    manager.dispose();
  });
});
