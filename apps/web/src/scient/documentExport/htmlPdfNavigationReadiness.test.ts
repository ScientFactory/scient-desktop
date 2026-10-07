import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("~/previewStateStore", () => ({ readThreadPreviewState: mocks.read }));
import { waitForNavigationReadiness } from "./htmlPdfNavigationReadiness";

const threadRef = {
  environmentId: EnvironmentId.make("remote-env"),
  threadId: ThreadId.make("html-thread"),
};
const tabId = "html-tab";
const runtimeTabId = previewRuntimeTabId(threadRef, "remote-epoch", tabId);
const url = "https://remote.test/authorized/report.html";
const state = (runtime: "server" | "desktop" = "server") => ({
  serverEpoch: "remote-epoch",
  sessions: { [tabId]: { runtime, navStatus: { _tag: "Success", url } } },
  desktopByTabId: {},
});
beforeEach(() => mocks.read.mockReset());

describe("linked document renderer readiness", () => {
  it("accepts an open remote server page at the renewed URL without a desktop overlay", async () => {
    mocks.read.mockReturnValue(state());
    await expect(
      waitForNavigationReadiness(threadRef, tabId, runtimeTabId, "server", url, 100),
    ).resolves.toBeUndefined();
  });
  it("still requires actual native webcontents to finish loading for the desktop owner", async () => {
    mocks.read.mockReturnValue({
      ...state("desktop"),
      desktopByTabId: { [tabId]: { hasWebContents: true, loading: false } },
    });
    await expect(
      waitForNavigationReadiness(threadRef, tabId, runtimeTabId, "desktop", url, 100),
    ).resolves.toBeUndefined();
    mocks.read.mockReturnValue(state("desktop"));
    vi.useFakeTimers();
    try {
      const rejected = expect(
        waitForNavigationReadiness(threadRef, tabId, runtimeTabId, "desktop", url, 100),
      ).rejects.toThrow("did not finish loading");
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a replaced remote process or a page that navigated elsewhere before exporting", async () => {
    mocks.read.mockReturnValue({ ...state(), serverEpoch: "replacement-epoch" });
    await expect(
      waitForNavigationReadiness(threadRef, tabId, runtimeTabId, "server", url, 100),
    ).rejects.toThrow("tab was replaced");
    mocks.read.mockReturnValue(state());
    await expect(
      waitForNavigationReadiness(
        threadRef,
        tabId,
        runtimeTabId,
        "server",
        "https://remote.test/different",
        100,
      ),
    ).rejects.toThrow("navigated elsewhere");
  });
});
