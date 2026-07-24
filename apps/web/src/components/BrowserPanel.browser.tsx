// FILE: BrowserPanel.browser.tsx
// Purpose: Browser-level coverage for tab-scoped, local copy feedback.

import "../index.css";

import type { NativeApi, ThreadBrowserState, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverLocalServersQueryOptions: () => ({
    queryKey: ["browser-panel-test", "local-servers"],
    queryFn: async () => ({ servers: [] }),
    staleTime: Number.POSITIVE_INFINITY,
  }),
}));

const nativeApiTestState = vi.hoisted(() => ({
  api: undefined as NativeApi | undefined,
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => nativeApiTestState.api,
}));

import { useBrowserStateStore } from "../browserStateStore";
import { BrowserPanel } from "./BrowserPanel";
import { RecentViewSwitcher } from "./RecentViewSwitcher";
import { showUndoSnackbar, UndoSnackbarProvider } from "./ui/undoSnackbar";

const THREAD_ID = "thread-browser-copy" as ThreadId;

function browserState(activeTabId: string, lastError: string | null = null): ThreadBrowserState {
  return {
    threadId: THREAD_ID,
    version: activeTabId === "tab-1" ? 1 : 2,
    open: true,
    activeTabId,
    lastError,
    tabs: [
      {
        id: "tab-1",
        kind: "web",
        url: "https://scientfactory.com/",
        displayUrl: null,
        title: "ScientFactory",
        status: "suspended",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: "https://scientfactory.com/",
        lastError: activeTabId === "tab-1" ? lastError : null,
      },
      {
        id: "tab-2",
        kind: "web",
        url: "https://example.com/",
        displayUrl: null,
        title: "Example",
        status: "suspended",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: "https://example.com/",
        lastError: null,
      },
    ],
  };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserPanel
        mode="inline"
        threadId={THREAD_ID}
        runtimeMode="preview"
        onClosePanel={() => undefined}
      />
    </QueryClientProvider>,
  );
}

function renderLivePanel(
  onClosePanel: (options?: { restoreFocus?: boolean }) => void,
  options?: { showRecentViews?: boolean; withUndoSnackbar?: boolean },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (
    <QueryClientProvider client={queryClient}>
      <div className="w-[720px]" style={{ height: options?.withUndoSnackbar ? "100vh" : "640px" }}>
        <BrowserPanel
          mode="inline"
          threadId={THREAD_ID}
          runtimeMode="live"
          onClosePanel={onClosePanel}
        />
        {options?.showRecentViews ? (
          <RecentViewSwitcher
            selectedIndex={0}
            entries={[
              {
                key: "current-thread",
                view: { kind: "thread", threadId: THREAD_ID },
                kind: "thread",
                icon: { kind: "chat" },
                title: "Current browser thread",
                subtitle: "Recent view",
                isCurrent: true,
                isPinned: false,
                isSplit: false,
                isTerminal: false,
              },
            ]}
          />
        ) : null}
      </div>
    </QueryClientProvider>
  );
  return render(
    options?.withUndoSnackbar ? <UndoSnackbarProvider>{content}</UndoSnackbarProvider> : content,
  );
}

function PreviewToLivePanel() {
  const [runtimeMode, setRuntimeMode] = useState<"live" | "preview">("preview");
  return (
    <div className="h-[640px] w-[720px]">
      <BrowserPanel
        mode="inline"
        threadId={THREAD_ID}
        runtimeMode={runtimeMode}
        onRequestLive={() => setRuntimeMode("live")}
        onClosePanel={() => undefined}
      />
    </div>
  );
}

function renderPreviewToLivePanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewToLivePanel />
    </QueryClientProvider>,
  );
}

function liveBrowserApi(options?: {
  openState?: ThreadBrowserState;
  newTabState?: ThreadBrowserState;
  closeTabState?: ThreadBrowserState;
}) {
  const openState = options?.openState ?? browserState("tab-1");
  return {
    browser: {
      open: vi.fn(async () => openState),
      hide: vi.fn(async () => undefined),
      setPanelBounds: vi.fn(async () => undefined),
      attachWebview: vi.fn(async () => openState),
      detachWebview: vi.fn(async () => undefined),
      newTab: vi.fn(async () => options?.newTabState ?? openState),
      selectTab: vi.fn(async ({ tabId }) => browserState(tabId)),
      closeTab: vi.fn(async () => options?.closeTabState ?? openState),
      onState: vi.fn(() => () => undefined),
      onCopyLink: vi.fn(() => () => undefined),
    },
    projects: {
      revokeHtmlArtifactPreview: vi.fn(async () => ({ revoked: false })),
    },
  } as unknown as NativeApi;
}

describe("BrowserPanel interactions", () => {
  beforeEach(() => {
    useBrowserStateStore.getState().upsertThreadState(browserState("tab-1"));
  });

  afterEach(() => {
    nativeApiTestState.api = undefined;
    useBrowserStateStore.getState().removeThreadState(THREAD_ID);
    vi.restoreAllMocks();
    document
      .querySelectorAll("[data-browser-panel-test-fallback]")
      .forEach((element) => element.remove());
  });

  it("surfaces clipboard rejection locally", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Clipboard denied"));
    await renderPanel();

    (
      (await page.getByRole("button", { name: "Copy link" }).element()) as HTMLButtonElement
    ).click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("https://scientfactory.com/"));
    await vi.waitFor(() => {
      const localStatus = page
        .getByRole("status")
        .elements()
        .find((element) => element.tagName === "SPAN");
      expect(localStatus?.textContent).toBe("Couldn't complete that browser action.");
    });
  });

  it("does not show late copy success on a different active tab", async () => {
    let resolveCopy: (() => void) | undefined;
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () => new Promise<void>((resolve) => (resolveCopy = resolve)),
    );
    await renderPanel();
    (
      (await page.getByRole("button", { name: "Copy link" }).element()) as HTMLButtonElement
    ).click();

    useBrowserStateStore.getState().upsertThreadState(browserState("tab-2"));
    resolveCopy?.();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect.element(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    expect(page.getByText("Link copied").query()).toBeNull();
  });

  it("shows a full recoverable error instead of an empty dark viewport", async () => {
    useBrowserStateStore.getState().removeThreadState(THREAD_ID);
    useBrowserStateStore
      .getState()
      .upsertThreadState(browserState("tab-1", "The local page is unavailable."));

    await renderPanel();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This page could not be opened");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The local page is unavailable.");
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("closes the browser pane when its final tab closes", async () => {
    const openState = browserState("tab-1");
    openState.version = 10;
    openState.tabs = [openState.tabs[0]!];
    const closedState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      open: false,
      activeTabId: null,
      tabs: [],
    };
    const closeTab = vi.fn(async () => closedState);
    nativeApiTestState.api = {
      browser: {
        open: vi.fn(async () => openState),
        hide: vi.fn(async () => undefined),
        setPanelBounds: vi.fn(async () => undefined),
        closeTab,
        onState: vi.fn(() => () => undefined),
        onCopyLink: vi.fn(() => () => undefined),
      },
      projects: {
        revokeHtmlArtifactPreview: vi.fn(async () => ({ revoked: false })),
      },
    } as unknown as NativeApi;
    useBrowserStateStore.getState().upsertThreadState(openState);
    const fallback = document.createElement("button");
    fallback.textContent = "Open Browser";
    fallback.dataset.browserPanelTestFallback = "true";
    document.body.append(fallback);
    const onClosePanel = vi.fn((options?: { restoreFocus?: boolean }) => {
      if (options?.restoreFocus) {
        window.requestAnimationFrame(() => fallback.focus());
      }
    });

    await renderLivePanel(onClosePanel);
    const closeButton = await page.getByRole("button", { name: "Close Browser" }).element();
    (closeButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(closeTab).toHaveBeenCalledWith({ threadId: THREAD_ID, tabId: "tab-1" });
      expect(onClosePanel).toHaveBeenCalledWith({ restoreFocus: true });
      expect(document.activeElement).toBe(fallback);
    });
  });

  it("moves focus to the adjacent tab when its visible close button closes the active tab", async () => {
    const openState = browserState("tab-1");
    const closeTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-2",
      tabs: openState.tabs.slice(1),
    };
    const api = liveBrowserApi({ openState, closeTabState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderLivePanel(vi.fn());
    const secondTab = (await page
      .getByRole("tab", { name: "Example" })
      .element()) as HTMLButtonElement;
    const closeButton = (await page
      .getByRole("button", { name: "Close tab: ScientFactory" })
      .element()) as HTMLButtonElement;
    closeButton.click();

    await vi.waitFor(() => {
      expect(api.browser.closeTab).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        tabId: "tab-1",
      });
      expect(document.activeElement).toBe(secondTab);
    });
  });

  it("does not reclaim focus when an asynchronous tab close finishes after focus moved away", async () => {
    const openState = browserState("tab-1");
    const closeTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-2",
      tabs: openState.tabs.slice(1),
    };
    let resolveCloseTab: ((state: ThreadBrowserState) => void) | undefined;
    const closeTabResult = new Promise<ThreadBrowserState>((resolve) => {
      resolveCloseTab = resolve;
    });
    const api = liveBrowserApi({ openState, closeTabState });
    vi.mocked(api.browser.closeTab).mockImplementation(async () => closeTabResult);
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);
    const outsideControl = document.createElement("button");
    outsideControl.textContent = "Composer";
    outsideControl.dataset.browserPanelTestFallback = "true";
    document.body.append(outsideControl);

    await renderLivePanel(vi.fn());
    const closeButton = (await page
      .getByRole("button", { name: "Close tab: ScientFactory" })
      .element()) as HTMLButtonElement;
    closeButton.focus();
    closeButton.click();
    await vi.waitFor(() => expect(api.browser.closeTab).toHaveBeenCalledOnce());
    outsideControl.focus();
    resolveCloseTab?.(closeTabState);

    await vi.waitFor(() => {
      expect(useBrowserStateStore.getState().threadStatesByThreadId[THREAD_ID]?.activeTabId).toBe(
        "tab-2",
      );
    });
    expect(document.activeElement).toBe(outsideControl);
  });

  it("restores parent focus when the Browser actions menu closes the panel", async () => {
    const openState = browserState("tab-1");
    const api = liveBrowserApi({ openState });
    nativeApiTestState.api = api;
    const fallback = document.createElement("button");
    fallback.textContent = "Open Browser";
    fallback.dataset.browserPanelTestFallback = "true";
    document.body.append(fallback);
    const onClosePanel = vi.fn((options?: { restoreFocus?: boolean }) => {
      if (options?.restoreFocus) {
        window.requestAnimationFrame(() => fallback.focus());
      }
    });

    await renderLivePanel(onClosePanel);
    (
      (await page.getByRole("button", { name: "Browser actions" }).element()) as HTMLButtonElement
    ).click();
    const closePanelItemLocator = page.getByRole("menuitem", { name: "Close browser panel" });
    await expect.element(closePanelItemLocator).toBeVisible();
    const closePanelItem = (await closePanelItemLocator.element()) as HTMLElement;
    closePanelItem.focus();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => {
      expect(onClosePanel).toHaveBeenCalledWith({ restoreFocus: true });
      expect(document.activeElement).toBe(fallback);
    });
  });

  it("creates and activates a second tab from the visible tab-strip button", async () => {
    const openState = browserState("tab-1");
    openState.version = 20;
    openState.tabs = [openState.tabs[0]!];
    const secondTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-2",
      tabs: [
        openState.tabs[0]!,
        {
          ...browserState("tab-2").tabs[1]!,
          url: "about:blank",
          title: "New tab",
          lastCommittedUrl: "about:blank",
        },
      ],
    };
    const api = liveBrowserApi({ openState, newTabState: secondTabState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderLivePanel(vi.fn());
    const newTabButton = page.getByRole("button", { name: "New browser tab" });
    await expect.element(newTabButton).toBeVisible();
    const newTabElement = (await newTabButton.element()) as HTMLButtonElement;
    newTabElement.click();
    newTabElement.click();

    await vi.waitFor(() => {
      expect(api.browser.newTab).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        activate: true,
      });
      expect(api.browser.newTab).toHaveBeenCalledTimes(1);
      expect(useBrowserStateStore.getState().threadStatesByThreadId[THREAD_ID]?.activeTabId).toBe(
        "tab-2",
      );
    });
    await expect.element(page.getByText("New tab", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: /^Close tab:/ }).elements()).toHaveLength(2);
  });

  it("preserves a new-tab click while a sleeping browser pane wakes", async () => {
    const openState = browserState("tab-1");
    openState.version = 30;
    openState.tabs = [openState.tabs[0]!];
    const secondTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-2",
      tabs: [openState.tabs[0]!, browserState("tab-2").tabs[1]!],
    };
    const api = liveBrowserApi({ openState, newTabState: secondTabState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderPreviewToLivePanel();
    const newTabButton = page.getByRole("button", { name: "New browser tab" });
    ((await newTabButton.element()) as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(api.browser.open).toHaveBeenCalledOnce();
      expect(api.browser.newTab).toHaveBeenCalledOnce();
      expect(useBrowserStateStore.getState().threadStatesByThreadId[THREAD_ID]?.activeTabId).toBe(
        "tab-2",
      );
    });
  });

  it("exposes roving tab semantics and activates adjacent tabs from the keyboard", async () => {
    const openState = browserState("tab-1");
    const closeTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-1",
      tabs: [openState.tabs[0]!],
    };
    const api = liveBrowserApi({ openState, closeTabState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderLivePanel(vi.fn());
    const tablist = page.getByRole("tablist", { name: "Browser tabs" });
    await expect.element(tablist).toBeVisible();
    const firstTab = page.getByRole("tab", { name: "ScientFactory" });
    const secondTab = page.getByRole("tab", { name: "Example" });
    await expect.element(firstTab).toHaveAttribute("aria-selected", "true");
    await expect.element(firstTab).toHaveAttribute("tabindex", "0");
    await expect.element(secondTab).toHaveAttribute("aria-selected", "false");
    await expect.element(secondTab).toHaveAttribute("tabindex", "-1");
    const tablistElement = (await tablist.element()) as HTMLElement;
    expect(tablistElement.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    const firstTabElement = (await firstTab.element()) as HTMLButtonElement;
    const secondTabElement = (await secondTab.element()) as HTMLButtonElement;
    firstTabElement.focus();
    await userEvent.keyboard("{ArrowRight}");

    await vi.waitFor(() => {
      expect(api.browser.selectTab).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        tabId: "tab-2",
      });
      expect(document.activeElement).toBe(secondTabElement);
    });
    await expect.element(secondTab).toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("tabpanel"))
      .toHaveAttribute("aria-labelledby", secondTabElement.id);

    await userEvent.keyboard("{Delete}");
    await vi.waitFor(() => {
      expect(api.browser.closeTab).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        tabId: "tab-2",
      });
      expect(document.activeElement).toBe(firstTabElement);
    });
  });

  it("occludes the native surface for the real recent-view switcher", async () => {
    const openState = browserState("tab-1");
    const api = liveBrowserApi({ openState });
    nativeApiTestState.api = api;

    await renderLivePanel(vi.fn(), { showRecentViews: true });
    await expect.element(page.getByRole("listbox", { name: "Recent views" })).toBeVisible();
    await vi.waitFor(() => {
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview?.style.visibility).toBe("hidden");
      expect(vi.mocked(api.browser.setPanelBounds).mock.calls).not.toContainEqual([
        { threadId: THREAD_ID, bounds: null, surface: "renderer" },
      ]);
    });
  });

  it("occludes the native surface when the global Undo snackbar mounts", async () => {
    const openState = browserState("tab-1");
    const api = liveBrowserApi({ openState });
    nativeApiTestState.api = api;

    await renderLivePanel(vi.fn(), { withUndoSnackbar: true });
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("webview")?.style.visibility).toBe("visible");
    });

    showUndoSnackbar({ title: "Thread archived", onUndo: async () => true });
    await expect.element(page.getByRole("button", { name: "Undo" })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("webview")?.style.visibility).toBe("hidden");
      expect(vi.mocked(api.browser.setPanelBounds).mock.calls).not.toContainEqual([
        { threadId: THREAD_ID, bounds: null, surface: "renderer" },
      ]);
    });
    ((await page.getByRole("button", { name: "Dismiss" }).element()) as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(page.getByRole("button", { name: "Undo" }).query()).toBeNull();
      expect(document.querySelector<HTMLElement>("webview")?.style.visibility).toBe("visible");
    });
  });

  it("moves focus to the adjacent tab when deleting the first of three tabs", async () => {
    const openState = browserState("tab-1");
    openState.tabs = [
      ...openState.tabs,
      {
        ...openState.tabs[1]!,
        id: "tab-3",
        url: "https://third.example/",
        title: "Third",
        lastCommittedUrl: "https://third.example/",
      },
    ];
    const closeTabState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      activeTabId: "tab-2",
      tabs: openState.tabs.slice(1),
    };
    const api = liveBrowserApi({ openState, closeTabState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderLivePanel(vi.fn());
    const firstTab = (await page
      .getByRole("tab", { name: "ScientFactory" })
      .element()) as HTMLButtonElement;
    const secondTab = (await page
      .getByRole("tab", { name: "Example" })
      .element()) as HTMLButtonElement;
    firstTab.focus();
    await userEvent.keyboard("{Delete}");

    await vi.waitFor(() => {
      expect(api.browser.closeTab).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        tabId: "tab-1",
      });
      expect(document.activeElement).toBe(secondTab);
    });
  });

  it("requests a parent focus fallback when keyboard deletion closes the final tab", async () => {
    const openState = browserState("tab-1");
    openState.tabs = [openState.tabs[0]!];
    const closedState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      open: false,
      activeTabId: null,
      tabs: [],
    };
    const api = liveBrowserApi({ openState, closeTabState: closedState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);
    const fallback = document.createElement("button");
    fallback.textContent = "Open Browser";
    fallback.dataset.browserPanelTestFallback = "true";
    document.body.append(fallback);
    const onClosePanel = vi.fn((options?: { restoreFocus?: boolean }) => {
      if (options?.restoreFocus) fallback.focus();
    });

    await renderLivePanel(onClosePanel);
    const tab = (await page
      .getByRole("tab", { name: "ScientFactory" })
      .element()) as HTMLButtonElement;
    tab.focus();
    await userEvent.keyboard("{Delete}");

    await vi.waitFor(() => {
      expect(onClosePanel).toHaveBeenCalledWith({ restoreFocus: true });
      expect(document.activeElement).toBe(fallback);
    });
  });

  it("hides the native browser surface while an intersecting app menu is open", async () => {
    const openState = browserState("tab-1");
    const api = liveBrowserApi({ openState });
    nativeApiTestState.api = api;

    await renderLivePanel(vi.fn());
    await vi.waitFor(() => expect(api.browser.open).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview).not.toBeNull();
      expect(webview?.style.visibility).not.toBe("hidden");
    });

    const initialBoundsCalls = vi.mocked(api.browser.setPanelBounds).mock.calls.length;
    (
      (await page.getByRole("button", { name: "Browser actions" }).element()) as HTMLButtonElement
    ).click();
    await expect.element(page.getByRole("menuitem", { name: "New tab" })).toBeVisible();
    await vi.waitFor(() => {
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview?.style.visibility).toBe("hidden");
      expect(webview?.style.pointerEvents).toBe("none");
      expect(vi.mocked(api.browser.setPanelBounds).mock.calls.length).toBe(initialBoundsCalls);
      expect(vi.mocked(api.browser.setPanelBounds).mock.calls).not.toContainEqual([
        { threadId: THREAD_ID, bounds: null, surface: "renderer" },
      ]);
    });

    const browserViewport = document.querySelector<HTMLElement>("webview")?.parentElement;
    expect(browserViewport).not.toBeNull();
    Object.assign(browserViewport!.style, { width: "500px", right: "auto" });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(page.getByRole("menuitem", { name: "New tab" }).query()).toBeNull();
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview?.style.visibility).toBe("visible");
      expect(webview?.style.pointerEvents).toBe("auto");
      const latestBoundsCall = vi.mocked(api.browser.setPanelBounds).mock.calls.at(-1)?.[0];
      expect(latestBoundsCall?.bounds).toMatchObject({ width: 500 });
    });
  });

  it("reserves null bounds for the local home that genuinely hides the page surface", async () => {
    const openState = browserState("tab-1");
    openState.version = 50;
    openState.tabs = [
      {
        ...openState.tabs[0]!,
        url: "about:blank",
        lastCommittedUrl: "about:blank",
        title: "New tab",
      },
    ];
    const api = liveBrowserApi({ openState });
    nativeApiTestState.api = api;
    useBrowserStateStore.getState().upsertThreadState(openState);

    await renderLivePanel(vi.fn());

    await vi.waitFor(() => {
      expect(api.browser.setPanelBounds).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        bounds: null,
        surface: "renderer",
      });
    });
  });

  it("reconciles a local HTML grant returned by initial hydration before close", async () => {
    const previewUrl = "http://g-12345678-1234-4123-8123-123456789abc.preview.localhost:5000/";
    const openState = browserState("tab-1");
    openState.version = 20;
    openState.tabs = [
      {
        ...openState.tabs[0]!,
        kind: "local-html",
        url: previewUrl,
        displayUrl: "/tmp/report.html",
      },
    ];
    const closedState: ThreadBrowserState = {
      ...openState,
      version: openState.version + 1,
      open: false,
      activeTabId: null,
      tabs: [],
    };
    const revokeHtmlArtifactPreview = vi.fn(async () => ({ revoked: true }));
    const setPanelBounds = vi.fn(async () => undefined);
    nativeApiTestState.api = {
      browser: {
        open: vi.fn(async () => openState),
        hide: vi.fn(async () => undefined),
        setPanelBounds,
        closeTab: vi.fn(async () => closedState),
        onState: vi.fn(() => () => undefined),
        onCopyLink: vi.fn(() => () => undefined),
      },
      projects: { revokeHtmlArtifactPreview },
    } as unknown as NativeApi;
    useBrowserStateStore.getState().removeThreadState(THREAD_ID);

    await renderLivePanel(() => undefined);
    await vi.waitFor(() => {
      expect(setPanelBounds).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: THREAD_ID, surface: "native" }),
      );
      expect(document.querySelector("webview")).toBeNull();
    });
    const closeButton = await page.getByRole("button", { name: "Close Browser" }).element();
    (closeButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(revokeHtmlArtifactPreview).toHaveBeenCalledWith({ previewUrl });
    });
  });
});
