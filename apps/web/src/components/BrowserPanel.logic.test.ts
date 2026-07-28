import { describe, expect, it } from "vitest";

import {
  browserAddressDisplayValue,
  browserCopyFeedbackMatches,
  buildBrowserAddressSuggestions,
  normalizeBrowserAddressInput,
  localHtmlSourceKey,
  localHtmlTabsShareSource,
  pruneConsumedLocalHtmlSourceGenerations,
  reconcileHtmlPreviewGrants,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
  shouldCloseBrowserPanelAfterTabClose,
} from "./BrowserPanel.logic";

describe("local HTML source authority", () => {
  it("keeps retargeted canonical sources distinct despite one display path", () => {
    const first = {
      kind: "local-html" as const,
      displayUrl: "/workspace/current/report.html",
      previewCwd: "/workspace",
      sourceIdentity: "/workspace/source-a/report.html",
      sourceRoot: "/workspace/source-a",
    };
    const second = {
      ...first,
      sourceIdentity: "/workspace/source-b/report.html",
      sourceRoot: "/workspace/source-b",
    };

    expect(localHtmlSourceKey("thread-a", first)).not.toBe(localHtmlSourceKey("thread-a", second));
    expect(localHtmlTabsShareSource(first, second)).toBe(false);
    expect(localHtmlTabsShareSource(first, { ...first })).toBe(true);
    expect(
      localHtmlTabsShareSource(first, {
        kind: "local-html",
        displayUrl: first.displayUrl,
        previewCwd: first.previewCwd,
      }),
    ).toBe(false);
  });
});

describe("pruneConsumedLocalHtmlSourceGenerations", () => {
  it("bounds bookkeeping across replacement tab ids and clears it after close", () => {
    const consumed = new Map<string, number>(
      Array.from({ length: 100 }, (_, index) => [`thread-a\0retired-${index}`, index] as const),
    );
    consumed.set("thread-a\0current", 100);
    consumed.set("thread-b\0old-owner", 5);

    pruneConsumedLocalHtmlSourceGenerations(consumed, "thread-a", [
      { id: "current", kind: "local-html" },
      { id: "web", kind: "web" },
    ]);

    expect([...consumed]).toEqual([["thread-a\0current", 100]]);

    pruneConsumedLocalHtmlSourceGenerations(consumed, "thread-a", []);
    expect(consumed.size).toBe(0);
  });
});

describe("reconcileHtmlPreviewGrants", () => {
  it("keeps the original grant while its local HTML tab navigates", () => {
    const previous = new Map([["tab-local", "http://g-preview.preview.localhost:5000/index.html"]]);

    const result = reconcileHtmlPreviewGrants(previous, [
      {
        id: "tab-local",
        kind: "local-html",
        url: "http://g-preview.preview.localhost:5000/details/page.html",
      },
    ]);

    expect(result.revoked).toEqual([]);
    expect(result.active.get("tab-local")).toBe(
      "http://g-preview.preview.localhost:5000/index.html",
    );
  });

  it("revokes the original grant after its preview tab closes", () => {
    const previewUrl = "http://g-preview.preview.localhost:5000/index.html";
    const result = reconcileHtmlPreviewGrants(new Map([["tab-local", previewUrl]]), []);

    expect(result.revoked).toEqual([previewUrl]);
    expect(result.active.size).toBe(0);
  });

  it("rotates grant ownership when a refreshed capability keeps the logical tab id", () => {
    const previousUrl = "http://g-old.preview.localhost:5000/index.html";
    const replacementUrl = "http://g-new.preview.localhost:5000/index.html";
    const result = reconcileHtmlPreviewGrants(new Map([["tab-local", previousUrl]]), [
      { id: "tab-local", kind: "local-html", url: replacementUrl },
    ]);

    expect(result.active.get("tab-local")).toBe(replacementUrl);
    expect(result.revoked).toEqual([previousUrl]);

    const closed = reconcileHtmlPreviewGrants(result.active, []);
    expect(closed.revoked).toEqual([replacementUrl]);
  });

  it("keeps the original preview grant when its tab navigates onto the web", () => {
    const previousUrl = "http://g-preview.preview.localhost:5000/index.html";
    const result = reconcileHtmlPreviewGrants(new Map([["tab-local", previousUrl]]), [
      {
        id: "tab-local",
        kind: "local-html",
        url: "https://example.com/details",
      },
    ]);

    expect(result.active.get("tab-local")).toBe(previousUrl);
    expect(result.revoked).toEqual([]);
  });

  it("keeps a shared local-site grant until its final tab closes", () => {
    const previewUrl = "http://g-preview.preview.localhost:5000/index.html";
    const result = reconcileHtmlPreviewGrants(
      new Map([
        ["tab-one", previewUrl],
        ["tab-two", "http://g-preview.preview.localhost:5000/details.html"],
      ]),
      [
        {
          id: "tab-two",
          kind: "local-html",
          url: "http://g-preview.preview.localhost:5000/details.html",
        },
      ],
    );

    expect(result.revoked).toEqual([]);
    expect(result.active.get("tab-two")).toContain("g-preview.preview.localhost");
  });
});

describe("shouldCloseBrowserPanelAfterTabClose", () => {
  it("closes the dock pane only after the browser session has fully closed", () => {
    expect(shouldCloseBrowserPanelAfterTabClose({ open: false, tabs: [] })).toBe(true);
    expect(shouldCloseBrowserPanelAfterTabClose({ open: true, tabs: [] })).toBe(false);
    expect(shouldCloseBrowserPanelAfterTabClose({ open: false, tabs: [{}] })).toBe(false);
  });
});

describe("browserCopyFeedbackMatches", () => {
  const feedback = {
    item: "link" as const,
    tabId: "tab-1",
    url: "https://scientfactory.com/",
    tone: "success" as const,
    message: "Link copied",
  };

  it("keeps feedback scoped to the exact tab and URL that was copied", () => {
    expect(
      browserCopyFeedbackMatches(feedback, {
        tabId: "tab-1",
        url: "https://scientfactory.com/",
      }),
    ).toBe(true);
    expect(
      browserCopyFeedbackMatches(feedback, {
        tabId: "tab-2",
        url: "https://scientfactory.com/",
      }),
    ).toBe(false);
    expect(
      browserCopyFeedbackMatches(feedback, {
        tabId: "tab-1",
        url: "https://scientfactory.com/docs",
      }),
    ).toBe(false);
  });
});

describe("browserAddressDisplayValue", () => {
  it("hides about:blank for new tabs", () => {
    expect(browserAddressDisplayValue({ url: "about:blank" })).toBe("");
  });

  it("keeps real urls visible", () => {
    expect(browserAddressDisplayValue({ url: "https://x.com/" })).toBe("https://x.com/");
  });

  it("shows an artifact source path instead of its capability URL", () => {
    expect(
      browserAddressDisplayValue({
        url: "http://g-secret.preview.localhost:5000/",
        displayUrl: "/workspace/report.html",
      }),
    ).toBe("/workspace/report.html");
  });
});

describe("resolveBrowserAddressSync", () => {
  it("restores a saved draft when switching to another tab", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-1",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "x.com",
      syncedValue: "",
    });
  });

  it("keeps the typed value while the active tab is still being edited", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: true,
      }),
    ).toEqual({
      type: "keep",
    });
  });

  it("updates the input when a submitted navigation resolves to a new url", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "https://x.com/",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "https://x.com/",
      syncedValue: "https://x.com/",
    });
  });
});

describe("normalizeBrowserAddressInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserAddressInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserAddressInput("how to bake bread")).toContain(
      "https://www.google.com/search?q=how%20to%20bake%20bread",
    );
  });
});

describe("buildBrowserAddressSuggestions", () => {
  it("hides blank tabs and surfaces direct navigation", () => {
    const suggestions = buildBrowserAddressSuggestions({
      query: "open",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "New tab",
          url: "about:blank",
          faviconUrl: null,
          lastCommittedUrl: null,
        },
        {
          id: "tab-2",
          title: "OpenAI",
          url: "https://openai.com/",
          faviconUrl: null,
          lastCommittedUrl: "https://openai.com/",
        },
      ],
      recentHistory: [
        {
          url: "about:blank",
          title: "Blank",
          tabId: "tab-1",
        },
        {
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          tabId: "tab-3",
        },
      ],
    });

    expect(suggestions[0]).toMatchObject({
      kind: "navigate",
      url: "https://www.google.com/search?q=open",
    });
    expect(suggestions.some((suggestion) => suggestion.url === "about:blank")).toBe(false);
    expect(suggestions.some((suggestion) => suggestion.url === "https://openai.com/")).toBe(true);
  });
});

describe("resolveBrowserChromeStatus", () => {
  it("surfaces recoverable browser errors ahead of idle state", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: "Couldn't complete that browser action.",
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toEqual({
      tone: "error",
      label: "Couldn't complete that browser action.",
    });
  });

  it("does not duplicate the current url when a page is loaded", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toBeNull();
  });

  it("surfaces bounded automatic-refresh degradation without treating the page as failed", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        localNotice: "Automatic refresh is limited. Use Reload after dependency changes.",
        threadLastError: null,
        activeTabStatus: "live",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toEqual({
      tone: "default",
      label: "Automatic refresh is limited. Use Reload after dependency changes.",
    });
  });

  it("keeps onboarding copy for empty browser states", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "suspended",
        hasActiveTab: false,
        workspaceReady: false,
      }),
    ).toEqual({
      tone: "default",
      label: "Starting browser...",
    });
  });
});
