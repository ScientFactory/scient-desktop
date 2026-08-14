import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  isBrowserPreviewFile,
  resolveWorkspaceFileLinkOpenTarget,
  workspaceFilePreviewAssetResource,
} from "./openFileInPreview";

describe("workspace file link routing", () => {
  it.each(["paper.pdf", "sources/PAPER.PDF", "paper.pdf?download=1", "paper.pdf#page=4"])(
    "routes PDF link %s to the Scient file surface",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(true);
      expect(resolveWorkspaceFileLinkOpenTarget(path)).toBe("file");
    },
  );

  it.each(["report.html", "preview.HTM?mode=full"])(
    "preserves T3 browser-first behavior for %s",
    (path) => {
      expect(resolveWorkspaceFileLinkOpenTarget(path)).toBe("browser");
    },
  );

  it("keeps ordinary workspace files on the file surface", () => {
    expect(resolveWorkspaceFileLinkOpenTarget("notes.md")).toBe("file");
  });

  it("roots browser assets independently of the compatibility thread", () => {
    expect(
      workspaceFilePreviewAssetResource({
        workspaceRoot: "/workspace",
        relativePath: "reports/demo.html",
        threadRef: scopeThreadRef(
          EnvironmentId.make("environment-1"),
          ThreadId.make("draft-thread"),
        ),
        filePath: "/workspace/reports/demo.html",
      }),
    ).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/demo.html",
      threadId: "draft-thread",
      path: "/workspace/reports/demo.html",
    });
  });
});
