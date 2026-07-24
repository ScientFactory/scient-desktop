// FILE: BrowserPanel.browser.tsx
// Purpose: Browser-level coverage for tab-scoped, local copy feedback.

import "../index.css";

import type { NativeApi, ThreadBrowserState, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
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
      <BrowserPanel
        mode="inline"
        threadId={THREAD_ID}
        runtimeMode="live"
        onClosePanel={onClosePanel}
      />
    </QueryClientProvider>,
  );
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
});
