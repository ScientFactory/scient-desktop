import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../ui/toast";
import {
  copyFilePathToClipboard,
  filePathCopyFormats,
  filePathCopyTitle,
  fileSurfacePath,
  resolveFilePathCopyValue,
} from "./filePathClipboard";

const workspace = (relativePath: string) => ({ kind: "workspace", relativePath }) as const;

describe("file path clipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses explicit labels for relative and full paths", () => {
    expect(filePathCopyTitle("relative")).toBe("Relative path");
    expect(filePathCopyTitle("full")).toBe("Full path");
  });

  it("selects the relative or workspace-resolved value requested by the menu", () => {
    expect(
      resolveFilePathCopyValue({
        path: workspace("src/main.ts"),
        workspaceRoot: "C:\\repo",
        format: "relative",
      }),
    ).toBe("src/main.ts");
    expect(
      resolveFilePathCopyValue({
        path: workspace("src/main.ts"),
        workspaceRoot: "C:\\repo",
        format: "full",
      }),
    ).toBe("C:\\repo\\src\\main.ts");
    expect(
      resolveFilePathCopyValue({
        path: workspace("src/main.ts"),
        workspaceRoot: null,
        format: "full",
      }),
    ).toBeNull();
  });

  it("treats workspace-relative names as paths rather than terminal-link syntax", () => {
    expect(
      resolveFilePathCopyValue({
        path: workspace("~/notes.md"),
        workspaceRoot: "/Users/alice/project",
        format: "full",
      }),
    ).toBe("/Users/alice/project/~/notes.md");
    expect(
      resolveFilePathCopyValue({
        path: workspace("C:/notes.md"),
        workspaceRoot: "/Users/alice/project",
        format: "full",
      }),
    ).toBe("/Users/alice/project/C:/notes.md");
    expect(
      resolveFilePathCopyValue({
        path: workspace("docs/notes.md"),
        workspaceRoot: "C:\\repo\\",
        format: "full",
      }),
    ).toBe("C:\\repo\\docs\\notes.md");
  });

  it("classifies file surfaces like the files panel", () => {
    expect(fileSurfacePath({ relativePath: "docs/report.md" })).toEqual(
      workspace("docs/report.md"),
    );
    expect(fileSurfacePath({ relativePath: "/tmp/report.md" })).toEqual({
      kind: "host",
      absolutePath: "/tmp/report.md",
    });
    expect(fileSurfacePath({ relativePath: "C:\\Users\\alice\\report.md" })).toEqual({
      kind: "host",
      absolutePath: "C:\\Users\\alice\\report.md",
    });
    expect(fileSurfacePath({ relativePath: "report.pdf", attachment: {} })).toBeNull();
  });

  it("offers only the path forms a surface actually has", () => {
    expect(filePathCopyFormats(workspace("docs/report.md"))).toEqual(["relative", "full"]);
    expect(filePathCopyFormats({ kind: "host", absolutePath: "/tmp/report.md" })).toEqual(["full"]);
    expect(filePathCopyFormats(null)).toEqual([]);
  });

  it("copies a host file's absolute path unchanged instead of joining it to the workspace", () => {
    for (const workspaceRoot of ["/workspace/project", "C:\\repo", null]) {
      expect(
        resolveFilePathCopyValue({
          path: { kind: "host", absolutePath: "/tmp/report.md" },
          workspaceRoot,
          format: "full",
        }),
      ).toBe("/tmp/report.md");
    }
    expect(
      resolveFilePathCopyValue({
        path: { kind: "host", absolutePath: "D:\\data\\run 1\\report.md" },
        workspaceRoot: "C:\\repo",
        format: "full",
      }),
    ).toBe("D:\\data\\run 1\\report.md");
    expect(
      resolveFilePathCopyValue({
        path: { kind: "host", absolutePath: "/tmp/report.md" },
        workspaceRoot: "/workspace/project",
        format: "relative",
      }),
    ).toBeNull();
  });

  it("copies the supplied path and reports the matching success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const addToast = vi.spyOn(toastManager, "add");

    await expect(
      copyFilePathToClipboard({ value: "C:\\repo\\src\\main.ts", format: "full" }),
    ).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("C:\\repo\\src\\main.ts");
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Full path copied",
        description: "C:\\repo\\src\\main.ts",
      }),
    );
  });

  it("preserves the shared unavailable-clipboard error behavior", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const addToast = vi.spyOn(toastManager, "add");
    const onError = vi.fn();

    await expect(
      copyFilePathToClipboard({ value: "src/main.ts", format: "relative", onError }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to copy relative path",
        description: "Clipboard API unavailable.",
      }),
    );
  });
});
