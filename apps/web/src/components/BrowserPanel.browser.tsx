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

const THREAD_ID = "thread-browser-copy" as ThreadId;

function browserState(activeTabId: string): ThreadBrowserState {
  return {
    threadId: THREAD_ID,
    version: activeTabId === "tab-1" ? 1 : 2,
    open: true,
    activeTabId,
    lastError: null,
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
        lastError: null,
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

function renderLivePanel(onClosePanel: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <div className="h-[640px] w-[720px]">
        <BrowserPanel
          mode="inline"
          threadId={THREAD_ID}
          runtimeMode="live"
          onClosePanel={onClosePanel}
        />
      </div>
    </QueryClientProvider>,
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
      closeTab: vi.fn(async () => openState),
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
    document.body.innerHTML = "";
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
    const onClosePanel = vi.fn();

    await renderLivePanel(onClosePanel);
    const closeButton = await page.getByRole("button", { name: "Close Browser" }).element();
    (closeButton as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(closeTab).toHaveBeenCalledWith({ threadId: THREAD_ID, tabId: "tab-1" });
      expect(onClosePanel).toHaveBeenCalledOnce();
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
    expect(page.getByRole("button", { name: "Close tab" }).elements()).toHaveLength(2);
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

    (
      (await page.getByRole("button", { name: "Browser actions" }).element()) as HTMLButtonElement
    ).click();
    await expect.element(page.getByRole("menuitem", { name: "New tab" })).toBeVisible();
    await vi.waitFor(() => {
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview?.style.visibility).toBe("hidden");
      expect(webview?.style.pointerEvents).toBe("none");
      expect(api.browser.setPanelBounds).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        bounds: null,
        surface: "renderer",
      });
    });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(page.getByRole("menuitem", { name: "New tab" }).query()).toBeNull();
      const webview = document.querySelector<HTMLElement>("webview");
      expect(webview?.style.visibility).toBe("visible");
      expect(webview?.style.pointerEvents).toBe("auto");
    });
  });
});
