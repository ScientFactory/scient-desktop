import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentFilePath, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sameTrackedHtmlSource,
  trackedHtmlAssetResource,
  trackedHtmlLogicalDocumentKey,
  type TrackedHtmlSource,
} from "./htmlPdfSource";

const environmentId = EnvironmentId.make("environment-1");

describe("tracked HTML source identity", () => {
  it("keeps access threads out of workspace-document identity", () => {
    const source: TrackedHtmlSource = {
      _tag: "workspace-html",
      environmentId,
      workspaceRoot: "/workspace",
      relativePath: "reports/result.html",
      absolutePath: "/workspace/reports/result.html",
    };
    const draft = scopeThreadRef(environmentId, ThreadId.make("draft-thread"));
    const fork = scopeThreadRef(environmentId, ThreadId.make("fork-thread"));

    expect(trackedHtmlLogicalDocumentKey(source)).toBe(trackedHtmlLogicalDocumentKey(source));
    expect(
      trackedHtmlLogicalDocumentKey({
        ...source,
        workspaceRoot: "/workspace/reports/..",
        relativePath: "./reports/result.html",
      }),
    ).toBe(trackedHtmlLogicalDocumentKey(source));
    expect(trackedHtmlAssetResource(source, draft)).toMatchObject({ threadId: "draft-thread" });
    expect(trackedHtmlAssetResource(source, fork)).toMatchObject({ threadId: "fork-thread" });
  });

  it("isolates identical paths in different environment authorities", () => {
    const first: TrackedHtmlSource = {
      _tag: "environment-html",
      environmentId,
      canonicalPath: EnvironmentFilePath.make("/tmp/result.html"),
    };
    const second: TrackedHtmlSource = {
      ...first,
      environmentId: EnvironmentId.make("environment-2"),
    };

    expect(sameTrackedHtmlSource(first, second)).toBe(false);
    expect(trackedHtmlLogicalDocumentKey(first)).not.toBe(trackedHtmlLogicalDocumentKey(second));
  });

  it("does not collide for same-named files in different directories", () => {
    const first: TrackedHtmlSource = {
      _tag: "workspace-html",
      environmentId,
      workspaceRoot: "/workspace",
      relativePath: "one/report.html",
      absolutePath: "/workspace/one/report.html",
    };
    const second: TrackedHtmlSource = {
      ...first,
      relativePath: "two/report.html",
      absolutePath: "/workspace/two/report.html",
    };

    expect(trackedHtmlLogicalDocumentKey(first)).not.toBe(trackedHtmlLogicalDocumentKey(second));
  });
});
