import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { htmlPdfSourceEventRequiresUpdate } from "./HtmlPdfLifecycleHost";
import { isTrackedDocumentUrl } from "./htmlPdfNavigationGuard";
import type { HtmlPdfSourceRelation } from "./htmlPdfSourceStore";

const relation: HtmlPdfSourceRelation = {
  id: "relation-1",
  threadRef: scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1")),
  tabId: "tab-1",
  source: {
    _tag: "workspace-html",
    environmentId: EnvironmentId.make("environment-1"),
    workspaceRoot: "/workspace",
    relativePath: "reports/result.html",
    absolutePath: "/workspace/reports/result.html",
  },
  logicalDocumentKey: "browser-export:fixture",
  artifactId: "artifact-1",
  authorizedUrl: "http://127.0.0.1:16491/api/assets/token/result.html",
  updatePhase: "idle",
  updateMessage: null,
  manualRequestId: 0,
};

describe("HTML PDF lifecycle navigation guard", () => {
  it("accepts the exact tracked page while ignoring document fragments", () => {
    expect(isTrackedDocumentUrl(relation, `${relation.authorizedUrl}#section-2`)).toBe(true);
  });

  it("does not redirect a Browser tab that navigated elsewhere", () => {
    expect(
      isTrackedDocumentUrl(relation, "http://127.0.0.1:16491/api/assets/other-token/result.html"),
    ).toBe(false);
  });

  it("requires manual confirmation after restart when the capability URL was not persisted", () => {
    expect(
      isTrackedDocumentUrl({ ...relation, authorizedUrl: null }, relation.authorizedUrl!),
    ).toBe(false);
  });
});

describe("HTML PDF source synchronization policy", () => {
  it("synchronizes an existing PDF when the watcher becomes ready or reports a change", () => {
    expect(
      htmlPdfSourceEventRequiresUpdate(
        { _tag: "watch-ready", relativePath: "reports/result.html" },
        "artifact-1",
      ),
    ).toBe(true);
    expect(
      htmlPdfSourceEventRequiresUpdate(
        { _tag: "file-changed", relativePath: "reports/result.html" },
        "artifact-1",
      ),
    ).toBe(true);
  });

  it("does not generate a PDF before the user has exported the document once", () => {
    expect(
      htmlPdfSourceEventRequiresUpdate(
        { _tag: "watch-ready", relativePath: "reports/result.html" },
        null,
      ),
    ).toBe(false);
  });
});
