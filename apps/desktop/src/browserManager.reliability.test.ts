// FILE: browserManager.reliability.test.ts
// Purpose: Verifies browser session closure and recovery from destroyed Electron runtimes.
// Layer: Desktop unit test
// Depends on: DesktopBrowserManager with a minimal Electron session mock

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const createdWebContents: Array<{
    id: number;
    loadURL: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>;
    handlers: Map<string, Array<(...args: any[]) => void>>;
    windowOpenHandler: ((details: any) => { action: string }) | null;
  }> = [];
  const createdWebContentsViewPreferences: Array<Record<string, unknown>> = [];
  const sessions = new Map<
    string,
    {
      setUserAgent: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
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
  let setProxyImplementation = async (): Promise<void> => undefined;

  function createWebContents() {
    let currentUrl = "about:blank";
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
      isDestroyed: () => false,
      getURL: () => currentUrl,
      getTitle: () => currentUrl,
      isLoading: () => false,
      getProcessId: () => 42,
      loadURL: vi.fn(async (url: string) => {
        currentUrl = url;
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
      close: vi.fn(),
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
    sessions,
    createWebContents,
    setProxyImplementation: (implementation: () => Promise<void>) => {
      setProxyImplementation = implementation;
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

    constructor(options: { webPreferences?: Record<string, unknown> }) {
      electron.createdWebContentsViewPreferences.push(options.webPreferences ?? {});
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
    electron.sessions.clear();
    electron.setProxyImplementation(async () => undefined);
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
    });
    manager.dispose();
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
