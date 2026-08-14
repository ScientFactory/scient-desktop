import type {
  DiscoveredLocalServer,
  PreviewSessionSnapshot,
  ProjectScript,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  captureProjectScriptPreviewWaitBaseline,
  findReusableProjectScriptPreviewTab,
  isCurrentProjectScriptPreviewLaunch,
  isProjectScriptPreviewServerReady,
  openProjectScriptPreview,
  planProjectScriptAutoPreview,
  resolveProjectScriptPreviewRequest,
  shouldCancelProjectScriptPreviewWait,
  type ProjectScriptPreviewRequest,
} from "./projectScriptAutoPreview";

const mocks = vi.hoisted(() => ({
  openPreviewSession: vi.fn(),
  openBrowser: vi.fn(),
  recordVisitForThread: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://100.64.0.2:3773" })),
}));

vi.mock("./openPreviewSession", () => ({
  openPreviewSession: mocks.openPreviewSession,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: mocks.openBrowser }),
  },
}));

vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: mocks.recordVisitForThread,
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));

const threadRef = {
  environmentId: "environment-1",
  threadId: "thread-1",
} as ScopedThreadRef;

const enabledScript = {
  previewUrl: "http://localhost:5173/app",
  autoOpenPreview: true,
} satisfies Pick<ProjectScript, "previewUrl" | "autoOpenPreview">;

const localRequest: ProjectScriptPreviewRequest = {
  requestedUrl: "http://localhost:5173/app",
  resolvedUrl: "http://100.64.0.2:5173/app",
  localServerKey: "loopback:5173",
};

const snapshot = (
  tabId: string,
  navStatus: PreviewSessionSnapshot["navStatus"],
): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-14T12:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planProjectScriptAutoPreview", () => {
  it.each([
    { previewSupported: false, script: enabledScript },
    { previewSupported: true, script: { ...enabledScript, autoOpenPreview: false } },
    { previewSupported: true, script: { ...enabledScript, previewUrl: undefined } },
  ])("ignores unsupported or disabled launches", ({ previewSupported, script }) => {
    const resolveRequest = vi.fn(() => localRequest);

    expect(
      planProjectScriptAutoPreview({
        script,
        previewSupported,
        sessions: {},
        resolveRequest,
      }),
    ).toEqual({ kind: "ignore" });
    expect(resolveRequest).not.toHaveBeenCalled();
  });

  it("waits for a configured local server without navigating to an error page", () => {
    expect(
      planProjectScriptAutoPreview({
        script: enabledScript,
        previewSupported: true,
        sessions: {},
        resolveRequest: () => localRequest,
      }),
    ).toEqual({ kind: "wait", request: localRequest });
  });

  it("opens non-local URLs immediately", () => {
    const request = {
      requestedUrl: "https://example.com/app",
      resolvedUrl: "https://example.com/app",
      localServerKey: null,
    };

    expect(
      planProjectScriptAutoPreview({
        script: { ...enabledScript, previewUrl: request.requestedUrl },
        previewSupported: true,
        sessions: {},
        resolveRequest: () => request,
      }),
    ).toEqual({ kind: "open", request });
  });

  it.each(["Loading", "Success"] as const)(
    "focuses a matching healthy %s tab instead of duplicating it",
    (tag) => {
      const existing = snapshot("tab-existing", {
        _tag: tag,
        url: localRequest.resolvedUrl,
        title: "App",
      });

      expect(
        planProjectScriptAutoPreview({
          script: enabledScript,
          previewSupported: true,
          sessions: { [existing.tabId]: existing },
          resolveRequest: () => localRequest,
        }),
      ).toEqual({ kind: "focus", tabId: existing.tabId });
    },
  );

  it("does not reuse a failed tab as if the app were ready", () => {
    const failed = snapshot("tab-failed", {
      _tag: "LoadFailed",
      url: localRequest.resolvedUrl,
      title: "",
      code: -102,
      description: "Connection refused",
    });

    expect(
      planProjectScriptAutoPreview({
        script: enabledScript,
        previewSupported: true,
        sessions: { [failed.tabId]: failed },
        resolveRequest: () => localRequest,
      }),
    ).toEqual({ kind: "wait", request: localRequest });
  });
});

describe("project script preview readiness", () => {
  it("keeps a delayed launch bound to its original environment and thread", () => {
    expect(isCurrentProjectScriptPreviewLaunch(threadRef, { ...threadRef })).toBe(true);
    expect(
      isCurrentProjectScriptPreviewLaunch(
        { ...threadRef, threadId: "thread-2" } as ScopedThreadRef,
        threadRef,
      ),
    ).toBe(false);
    expect(
      isCurrentProjectScriptPreviewLaunch(
        { ...threadRef, environmentId: "environment-2" } as ScopedThreadRef,
        threadRef,
      ),
    ).toBe(false);
    expect(isCurrentProjectScriptPreviewLaunch(null, threadRef)).toBe(false);
  });

  it("matches equivalent loopback hosts by port", () => {
    const server: DiscoveredLocalServer = {
      host: "127.0.0.1",
      port: 5173,
      url: "http://127.0.0.1:5173/",
      processName: "node",
      pid: 123,
      terminal: null,
    };

    expect(isProjectScriptPreviewServerReady(localRequest, [server])).toBe(true);
    expect(
      isProjectScriptPreviewServerReady({ ...localRequest, localServerKey: "loopback:3000" }, [
        server,
      ]),
    ).toBe(false);
  });

  it("ignores unrelated runtime updates while a launch is waiting", () => {
    const existing = snapshot("tab-existing", {
      _tag: "Success",
      url: "https://example.com/",
      title: "Example",
    });
    const background = snapshot("tab-background", {
      _tag: "Success",
      url: "https://background.example/",
      title: "Background",
    });
    const sessions = { [existing.tabId]: existing, [background.tabId]: background };
    const baseline = captureProjectScriptPreviewWaitBaseline(sessions, existing.tabId);

    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: {
          [existing.tabId]: {
            ...existing,
            updatedAt: "2026-08-14T12:00:01.000Z",
            navStatus: {
              _tag: "Success",
              url: "https://example.com/",
              title: "Renamed",
            },
          },
          [background.tabId]: {
            ...background,
            updatedAt: "2026-08-14T12:00:02.000Z",
            navStatus: {
              _tag: "Success",
              url: "https://background.example/redirected",
              title: "Redirected",
            },
          },
        },
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(false);
  });

  it("cancels when the visible Browser intent changes", () => {
    const existing = snapshot("tab-existing", {
      _tag: "Loading",
      url: "https://example.com/",
      title: "",
    });
    const sessions = { [existing.tabId]: existing };
    const baseline = captureProjectScriptPreviewWaitBaseline(sessions, existing.tabId);
    const manual = snapshot("tab-manual", {
      _tag: "Success",
      url: "https://manual.example/",
      title: "Manual",
    });

    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: { [existing.tabId]: existing },
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(false);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: {
          [existing.tabId]: {
            ...existing,
            updatedAt: "2026-08-14T12:00:01.000Z",
            navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
          },
        },
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(false);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: { [existing.tabId]: existing, [manual.tabId]: manual },
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(true);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: {},
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(true);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions: {
          [existing.tabId]: {
            ...existing,
            navStatus: { _tag: "Success", url: "https://example.com/next", title: "Next" },
          },
        },
        activePreviewTabId: existing.tabId,
      }),
    ).toBe(true);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions,
        activePreviewTabId: undefined,
      }),
    ).toBe(true);
    expect(
      shouldCancelProjectScriptPreviewWait({
        baseline,
        sessions,
        activePreviewTabId: "tab-other",
      }),
    ).toBe(true);
  });

  it("uses the active Browser tab as the stable waiting surface", () => {
    const first = snapshot("tab-first", { _tag: "Idle" });
    const active = snapshot("tab-active", {
      _tag: "Success",
      url: "https://example.com/",
      title: "Example",
    });

    expect(
      captureProjectScriptPreviewWaitBaseline(
        { [first.tabId]: first, [active.tabId]: active },
        active.tabId,
      ),
    ).toEqual({
      sessionIds: [active.tabId, first.tabId].toSorted(),
      visibleTabId: active.tabId,
      visibleTabUrl: "https://example.com/",
    });
    expect(captureProjectScriptPreviewWaitBaseline({}, null)).toEqual({
      sessionIds: [],
      visibleTabId: null,
      visibleTabUrl: null,
    });
  });
});

describe("project script preview navigation", () => {
  it("resolves a loopback URL through the active remote environment", () => {
    expect(resolveProjectScriptPreviewRequest(threadRef, "localhost:5173/app")).toEqual(
      localRequest,
    );
  });

  it("rejects unsupported preview URL protocols before opening a browser tab", () => {
    expect(() => resolveProjectScriptPreviewRequest(threadRef, "file:///tmp/app.html")).toThrow(
      "Invalid preview URL",
    );
  });

  it("records the requested URL and focuses the opened browser tab", async () => {
    const opened = snapshot("tab-opened", {
      _tag: "Loading",
      url: localRequest.resolvedUrl,
      title: "",
    });
    mocks.openPreviewSession.mockResolvedValue(AsyncResult.success(opened));

    const result = await openProjectScriptPreview({
      threadRef,
      request: localRequest,
      openPreview: vi.fn(),
    });

    expect(result._tag).toBe("Success");
    expect(mocks.openPreviewSession).toHaveBeenCalledWith({
      threadRef,
      url: localRequest.resolvedUrl,
      openPreview: expect.any(Function),
    });
    expect(mocks.recordVisitForThread).toHaveBeenCalledWith(threadRef, localRequest.requestedUrl);
    expect(mocks.openBrowser).toHaveBeenCalledWith(threadRef, opened.tabId);
  });

  it("does not record or focus a tab when opening fails", async () => {
    mocks.openPreviewSession.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("preview unavailable"))),
    );

    const result = await openProjectScriptPreview({
      threadRef,
      request: localRequest,
      openPreview: vi.fn(),
    });

    expect(result._tag).toBe("Failure");
    expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
  });
});

describe("findReusableProjectScriptPreviewTab", () => {
  it("normalizes harmless URL and loopback-host spelling differences", () => {
    const existing = snapshot("tab-existing", {
      _tag: "Success",
      url: "http://127.0.0.1:5173/app",
      title: "App",
    });

    expect(
      findReusableProjectScriptPreviewTab(
        { [existing.tabId]: existing },
        "http://localhost:5173/app",
      ),
    ).toBe(existing.tabId);
  });

  it("keeps distinct application paths in distinct tabs", () => {
    const existing = snapshot("tab-existing", {
      _tag: "Success",
      url: "http://localhost:5173/app",
      title: "App",
    });

    expect(
      findReusableProjectScriptPreviewTab(
        { [existing.tabId]: existing },
        "http://localhost:5173/dashboard",
      ),
    ).toBeNull();
  });
});
