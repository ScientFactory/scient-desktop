import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AssetCreateUrlResult, AssetResource } from "./assets.ts";

const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);
const decodeAssetCreateUrlResult = Schema.decodeUnknownSync(AssetCreateUrlResult);
const decodeLegacyWorkspaceFile = Schema.decodeUnknownSync(
  Schema.TaggedStruct("workspace-file", {
    threadId: Schema.String,
    path: Schema.String,
  }),
);

describe("AssetResource", () => {
  it("accepts a workspace-rooted file without a thread", () => {
    expect(
      decodeAssetResource({
        _tag: "workspace-file",
        cwd: "/workspace",
        relativePath: "reports/דוח.pdf",
      }),
    ).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/דוח.pdf",
    });
  });

  it("retains the legacy thread locator for version compatibility", () => {
    expect(
      decodeAssetResource({
        _tag: "workspace-file",
        threadId: "thread-1",
        path: "/workspace/reports/paper.pdf",
      }),
    ).toMatchObject({ threadId: "thread-1", path: "/workspace/reports/paper.pdf" });
  });

  it("accepts both locators during a rolling client/server upgrade", () => {
    const resource = decodeAssetResource({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/paper.pdf",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });

    expect(resource).toMatchObject({ cwd: "/workspace", relativePath: "reports/paper.pdf" });
    expect(decodeLegacyWorkspaceFile(resource)).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });
  });

  it.each([
    { _tag: "workspace-file" },
    { _tag: "workspace-file", cwd: "/workspace" },
    { _tag: "workspace-file", relativePath: "paper.pdf" },
    { _tag: "workspace-file", threadId: "thread-1" },
    { _tag: "workspace-file", path: "/workspace/paper.pdf" },
  ])("rejects an incomplete workspace locator: %j", (resource) => {
    expect(() => decodeAssetResource(resource)).toThrow();
  });

  it("accepts exact and HTML-document environment capabilities", () => {
    expect(
      decodeAssetResource({
        _tag: "environment-file",
        path: "/Users/researcher/report.html",
        access: "html-document",
      }),
    ).toMatchObject({ access: "html-document" });
    expect(
      decodeAssetResource({
        _tag: "environment-file",
        path: "C:\\Research\\paper.pdf",
        access: "exact",
      }),
    ).toMatchObject({ access: "exact" });
  });

  it("rejects incomplete or unsafe environment capabilities", () => {
    expect(() =>
      decodeAssetResource({ _tag: "environment-file", path: "/tmp/file.txt" }),
    ).toThrow();
    expect(() =>
      decodeAssetResource({
        _tag: "environment-file",
        path: "/tmp/file\0.txt",
        access: "exact",
      }),
    ).toThrow();
  });

  it("allows signed URLs large enough to carry a maximum environment path", () => {
    const relativeUrl = `/api/assets/${"a".repeat(7_000)}/paper.pdf`;
    expect(
      decodeAssetCreateUrlResult({
        relativeUrl,
        expiresAt: 1,
        sourcePath: `/${"p".repeat(4_000)}`,
      }).relativeUrl,
    ).toBe(relativeUrl);
  });
});
