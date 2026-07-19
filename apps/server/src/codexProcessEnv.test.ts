import { describe, expect, it, vi } from "vitest";

import {
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  serializeCodexOverlayPreparation,
} from "./codexProcessEnv";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("serializeCodexOverlayPreparation", () => {
  it("serializes work for the same overlay path", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeCodexOverlayPreparation("/overlay/shared", async () => {
      started.push("first");
      await firstGate;
      return 1;
    });
    const second = serializeCodexOverlayPreparation("/overlay/shared", async () => {
      started.push("second");
      return 2;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["first"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(started).toEqual(["first", "second"]);
  });

  it("releases the overlay queue after a failed preparation", async () => {
    await expect(
      serializeCodexOverlayPreparation("/overlay/retry", async () => {
        throw new Error("preparation failed");
      }),
    ).rejects.toThrow("preparation failed");

    await expect(
      serializeCodexOverlayPreparation("/overlay/retry", async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("allows different overlay paths to prepare concurrently", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = serializeCodexOverlayPreparation("/overlay/a", async () => {
      started.push("a");
      await gate;
    });
    const second = serializeCodexOverlayPreparation("/overlay/b", async () => {
      started.push("b");
      await gate;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    release?.();
    await Promise.all([first, second]);
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});
