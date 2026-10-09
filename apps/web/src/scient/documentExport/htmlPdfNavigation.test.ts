import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { navigateLinkedHtmlPdfSource } from "./htmlPdfNavigation";
import { runHtmlPdfUpdateTransaction } from "./htmlPdfUpdateTransaction";
import { updateServerBrowserDocumentControl } from "./serverBrowserDocumentControl";

const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("document-thread"),
};
const target = {
  threadRef,
  tabId: "remote-tab",
  runtimeTabId: "remote-runtime",
  lease: {
    owner: "server" as const,
    serverEpoch: "remote-process",
    pageUrl: "https://remote.test/old-token/report.html",
  },
  authorizedUrl: "https://remote.test/new-token/report.html",
};

describe("linked HTML/PDF navigation owner", () => {
  it("renews an existing remote document under its live viewer lease before committing/exporting", async () => {
    const mount = Symbol();
    updateServerBrowserDocumentControl(target.runtimeTabId, mount, {
      canOperate: true,
      controller: "you",
      generation: 7,
      controllingViewerId: "own-viewer",
      dialog: null,
    });
    const events: string[] = [];
    const navigateNative = vi.fn(async () => {});
    const navigateServer = vi.fn(async () => {
      events.push("remote-navigate-ready");
      return AsyncResult.success(undefined);
    });
    await runHtmlPdfUpdateTransaction({
      renewAuthorizedUrl: async () => {
        events.push("renew");
        return target.authorizedUrl;
      },
      navigate: (authorizedUrl) =>
        navigateLinkedHtmlPdfSource({ ...target, authorizedUrl, navigateNative, navigateServer }),
      commitAuthorizedUrl: () => events.push("commit"),
      waitForReadiness: async () => {
        events.push("observe-ready");
      },
      isNavigationTargetCurrent: () => true,
      isCurrent: () => true,
      hasArtifact: () => true,
      exportPdf: async (url) => {
        expect(url).toBe(target.authorizedUrl);
        events.push("publish-revision");
      },
    });
    expect(navigateServer).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId: target.tabId,
        expectedServerEpoch: "remote-process",
        expectedSourceUrl: target.lease.pageUrl,
        authorizedUrl: target.authorizedUrl,
        controllingViewerId: "own-viewer",
        expectedControlGeneration: 7,
      },
    });
    expect(navigateNative).not.toHaveBeenCalled();
    expect(events).toEqual([
      "renew",
      "remote-navigate-ready",
      "commit",
      "observe-ready",
      "publish-revision",
    ]);
    updateServerBrowserDocumentControl(target.runtimeTabId, mount, null);
  });
  it("keeps a native primary document on the existing bridge", async () => {
    const navigateNative = vi.fn(async () => {});
    const navigateServer = vi.fn();
    await navigateLinkedHtmlPdfSource({
      ...target,
      lease: { ...target.lease, owner: "desktop" },
      navigateNative,
      navigateServer,
    });
    expect(navigateNative).toHaveBeenCalledExactlyOnceWith(
      target.runtimeTabId,
      target.authorizedUrl,
    );
    expect(navigateServer).not.toHaveBeenCalled();
  });
  it("does not commit or export when remote navigation loses ownership", async () => {
    const commit = vi.fn();
    const exportPdf = vi.fn(async () => {});
    const denied = new Error("The viewer no longer controls this page.");
    await expect(
      runHtmlPdfUpdateTransaction({
        renewAuthorizedUrl: async () => target.authorizedUrl,
        navigate: (authorizedUrl) =>
          navigateLinkedHtmlPdfSource({
            ...target,
            authorizedUrl,
            navigateNative: vi.fn(),
            navigateServer: async () => {
              throw denied;
            },
          }),
        commitAuthorizedUrl: commit,
        waitForReadiness: async () => {},
        isNavigationTargetCurrent: () => true,
        isCurrent: () => true,
        hasArtifact: () => true,
        exportPdf,
      }),
    ).rejects.toBe(denied);
    expect(commit).not.toHaveBeenCalled();
    expect(exportPdf).not.toHaveBeenCalled();
  });
});
