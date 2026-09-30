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
    for (const [absolutePath, relativePath] of [
      ["/tmp/plot.png", "/tmp/plot.png"],
      ["/repo/../shared/plot.png", "../shared/plot.png"],
    ] as const) {
      expect(
        fileSurfaceAssetResource({ absolutePath, workspaceRoot: "/repo", relativePath, threadId }),
      ).toEqual({ _tag: "media-file", threadId, path: absolutePath });
    }
  });
});
