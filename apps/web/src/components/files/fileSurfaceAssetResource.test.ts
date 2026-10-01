import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileSurfaceAssetResource } from "./fileSurfaceAssetResource";

const threadId = ThreadId.make("thread-1");

describe("fileSurfaceAssetResource", () => {
  it("loads a workspace file through its rooted workspace locator", () => {
    expect(
      fileSurfaceAssetResource({
        absolutePath: "/repo/figures/plot.png",
        workspaceRoot: "/repo",
        relativePath: "figures/plot.png",
        threadId,
      }),
    ).toEqual({
      _tag: "workspace-file",
      cwd: "/repo",
      relativePath: "figures/plot.png",
      threadId,
      path: "/repo/figures/plot.png",
    });
  });

  it("serves a host file outside the workspace on its own", () => {
    // The files panel hands a host file over by its absolute path.
    expect(
      fileSurfaceAssetResource({
        absolutePath: "/tmp/plot.png",
        workspaceRoot: "/repo",
        relativePath: "/tmp/plot.png",
        threadId,
      }),
    ).toEqual({ _tag: "media-file", threadId, path: "/tmp/plot.png" });
  });

  it("serves a host HTML page as a document, so the files beside it load", () => {
    expect(
      fileSurfaceAssetResource({
        absolutePath: "/tmp/report/index.html",
        workspaceRoot: "/repo",
        relativePath: "/tmp/report/index.html",
        threadId,
        htmlDocument: true,
      }),
    ).toEqual({
      _tag: "environment-file",
      path: "/tmp/report/index.html",
      access: "html-document",
    });
    // A workspace page already loads its siblings through its rooted locator.
    expect(
      fileSurfaceAssetResource({
        absolutePath: "/repo/site/index.html",
        workspaceRoot: "/repo",
        relativePath: "site/index.html",
        threadId,
        htmlDocument: true,
      })._tag,
    ).toBe("workspace-file");
  });

  it("keeps a workspace file rooted even when the joined path cannot round-trip the root", () => {
    // On POSIX this workspace folder's name ends in a backslash, which the
    // lexical join drops from the absolute path.
    expect(
      fileSurfaceAssetResource({
        absolutePath: "/tmp/project/plot.png",
        workspaceRoot: "/tmp/project\\",
        relativePath: "plot.png",
        threadId,
      }),
    ).toMatchObject({ _tag: "workspace-file", cwd: "/tmp/project\\", relativePath: "plot.png" });
  });
});
