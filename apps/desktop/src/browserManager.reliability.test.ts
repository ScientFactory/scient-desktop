// FILE: browserManager.reliability.test.ts
// Purpose: Verifies browser session closure and recovery from destroyed Electron runtimes.
// Layer: Desktop unit test
// Depends on: DesktopBrowserManager with a minimal Electron session mock

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const createdWebContents: Array<{ loadURL: ReturnType<typeof vi.fn> }> = [];
  let nextWebContentsId = 1;

  function createWebContents() {
    let currentUrl = "about:blank";
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
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      openDevTools: vi.fn(),
    };
    createdWebContents.push(webContents);
    return webContents;
  }

  return {
    setUserAgent: vi.fn(),
    onBeforeSendHeaders: vi.fn(),
    createdWebContents,
    createWebContents,
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
    fromPartition: () => ({
      setUserAgent: electron.setUserAgent,
      webRequest: {
        onBeforeSendHeaders: electron.onBeforeSendHeaders,
      },
    }),
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
  },
}));

import type { ThreadId } from "@synara/contracts";

import { DesktopBrowserManager } from "./browserManager";

const THREAD_ID = "thread-close-tab" as ThreadId;

describe("DesktopBrowserManager reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.createdWebContents.splice(0);
  });

  it("closes the browser session when its final tab closes", () => {
    const manager = new DesktopBrowserManager();
    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;

    expect(tabId).toBeTruthy();
    const closed = manager.closeTab({ threadId: THREAD_ID, tabId: tabId ?? "" });

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

    const next = manager.closeTab({ threadId: THREAD_ID, tabId: firstTabId ?? "" });

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
});
