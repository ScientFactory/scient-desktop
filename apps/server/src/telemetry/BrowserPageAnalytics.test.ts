import type { PreviewEvent, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createBrowserPageMapper } from "./BrowserPageAnalytics.ts";
import { browserSite } from "./BrowserSite.ts";

const base = {
  threadId: "thread",
  tabId: "tab",
  createdAt: "2026-11-17T00:00:00.000Z",
  serverEpoch: "epoch",
  revision: 1,
} as const;

const snapshot = (
  navStatus: PreviewSessionSnapshot["navStatus"],
  extra: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot =>
  ({
    threadId: "thread",
    tabId: "tab",
    navStatus,
    canGoBack: false,
    canGoForward: false,
    updatedAt: base.createdAt,
    ...extra,
  }) as PreviewSessionSnapshot;

const navigated = (
  navStatus: PreviewSessionSnapshot["navStatus"],
  extra?: Partial<PreviewSessionSnapshot>,
) => ({ ...base, type: "navigated", snapshot: snapshot(navStatus, extra) }) as PreviewEvent;

describe("browserSite", () => {
  it("keeps a public host only and folds local and non-web addresses", () => {
    expect(browserSite("https://Accounts.Google.com/signin?continue=private")).toBe(
      "accounts.google.com",
    );
    for (const local of [
      "http://localhost:3000/",
      "http://127.0.0.1:8080/x",
      "http://192.168.1.4/",
      "http://[::1]:5173/",
      "http://devbox/",
      "http://printer.local/",
    ])
      expect(browserSite(local)).toBe("local");
    expect(browserSite("file:///Users/someone/report.html")).toBe("file");
    expect(browserSite("about:blank")).toBe("internal");
    expect(browserSite("not a url")).toBeUndefined();
  });
});

describe("createBrowserPageMapper", () => {
  it("reports each finished load once, failures with the browser's error, and the tab's life", () => {
    const mapper = createBrowserPageMapper();
    const page = { url: "https://example.org/private", title: "Private title" };
    expect(
      mapper.observe(
        {
          ...base,
          type: "opened",
          snapshot: snapshot({ _tag: "Loading", ...page }, { automationOwner: "agent-1" }),
        } as PreviewEvent,
        1_000,
      ),
    ).toEqual([]);
    const loaded = mapper.observe(
      navigated({ _tag: "Success", ...page }, { automationOwner: "agent-1" }),
      1_250,
    );
    // A later title update reports Success again without a new load.
    expect(mapper.observe(navigated({ _tag: "Success", ...page, title: "New" }), 1_300)).toEqual(
      [],
    );
    mapper.observe(navigated({ _tag: "Loading", url: "https://nowhere.test/", title: "" }), 2_000);
    const failed = mapper.observe(
      {
        ...base,
        type: "failed",
        url: "https://nowhere.test/",
        title: "",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      } as PreviewEvent,
      2_400,
    );
    // The desktop repeats a failed load on later status reports; it is still one failure.
    expect(
      mapper.observe(
        {
          ...base,
          type: "failed",
          url: "https://nowhere.test/",
          title: "",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        } as PreviewEvent,
        2_500,
      ),
    ).toEqual([]);
    const closed = mapper.observe({ ...base, type: "closed" } as PreviewEvent, 5_000);
    expect([...loaded, ...failed, ...closed]).toEqual([
      {
        name: "browser.page.loaded",
        properties: {
          owner: "agent",
          runtime: "desktop",
          headless: false,
          profile: "main",
          site: "example.org",
          loadMs: 250,
          outcome: "loaded",
        },
      },
      {
        name: "browser.page.loaded",
        properties: {
          owner: "user",
          runtime: "desktop",
          headless: false,
          profile: "main",
          site: "nowhere.test",
          loadMs: 400,
          outcome: "failed",
          errorCode: -105,
          errorName: "ERR_NAME_NOT_RESOLVED",
        },
      },
      {
        name: "browser.tab.closed",
        properties: {
          owner: "user",
          runtime: "desktop",
          headless: false,
          profile: "main",
          lifetimeMs: 4_000,
          pageLoads: 1,
          pageFailures: 1,
          siteCount: 2,
        },
      },
    ]);
    expect(JSON.stringify([loaded, failed, closed])).not.toMatch(/private|title/iu);
  });
});
