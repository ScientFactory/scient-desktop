// FILE: BrowserPanel.browser.tsx
// Purpose: Browser-level coverage for tab-scoped, local copy feedback.

import "../index.css";

import type { ThreadBrowserState, ThreadId } from "@synara/contracts";
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

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => undefined,
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
        url: "https://scientfactory.com/",
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
        url: "https://example.com/",
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

describe("BrowserPanel copy feedback", () => {
  beforeEach(() => {
    useBrowserStateStore.getState().upsertThreadState(browserState("tab-1"));
  });

  afterEach(() => {
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
});
