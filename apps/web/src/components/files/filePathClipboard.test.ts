import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../ui/toast";
import {
  copyFilePathToClipboard,
  filePathCopyTitle,
  resolveFilePathCopyValue,
} from "./filePathClipboard";

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
        relativePath: "src/main.ts",
        workspaceRoot: "C:\\repo",
        format: "relative",
      }),
    ).toBe("src/main.ts");
    expect(
      resolveFilePathCopyValue({
        relativePath: "src/main.ts",
        workspaceRoot: "C:\\repo",
        format: "full",
      }),
    ).toBe("C:\\repo\\src\\main.ts");
    expect(
      resolveFilePathCopyValue({
        relativePath: "src/main.ts",
        workspaceRoot: null,
        format: "full",
      }),
    ).toBeNull();
  });

  it("treats workspace-relative names as paths rather than terminal-link syntax", () => {
    expect(
      resolveFilePathCopyValue({
        relativePath: "~/notes.md",
        workspaceRoot: "/Users/alice/project",
        format: "full",
      }),
    ).toBe("/Users/alice/project/~/notes.md");
    expect(
      resolveFilePathCopyValue({
        relativePath: "C:/notes.md",
        workspaceRoot: "/Users/alice/project",
        format: "full",
      }),
    ).toBe("/Users/alice/project/C:/notes.md");
    expect(
      resolveFilePathCopyValue({
        relativePath: "docs/notes.md",
        workspaceRoot: "C:\\repo\\",
        format: "full",
      }),
    ).toBe("C:\\repo\\docs\\notes.md");
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
