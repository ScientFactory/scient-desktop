// @effect-diagnostics nodeBuiltinImport:off -- Tests verify real atomic filesystem behavior in an isolated temp directory.
import { DesktopAssetCopyRequestSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { copyAssetToPath, revealSavedAsset, saveAssetCopy } from "./AssetCopy.ts";

const { fetchMock, showItemInFolderMock, showSaveDialogMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showSaveDialog: showSaveDialogMock },
  net: { fetch: fetchMock },
  shell: { showItemInFolder: showItemInFolderMock },
}));

const request = DesktopAssetCopyRequestSchema.make({
  url: "https://assets.scient.test/report.pdf?token=fixture",
  suggestedFileName: "report.pdf",
});

describe("AssetCopy", () => {
  let temporaryDirectory = "";

  beforeEach(async () => {
    fetchMock.mockReset();
    showItemInFolderMock.mockReset();
    showSaveDialogMock.mockReset();
    temporaryDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-asset-copy-"),
    );
  });

  afterEach(async () => {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("streams exact bytes and atomically replaces an existing destination", async () => {
    const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");
    await NodeFSP.writeFile(destinationPath, "old copy");
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x25, 0x50, 0x44]));
            controller.enqueue(new Uint8Array([0x46, 0x2d, 0x31]));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const result = await copyAssetToPath(request, destinationPath);

    expect(result).toEqual({ _tag: "saved", path: destinationPath });
    expect([...new Uint8Array(await NodeFSP.readFile(destinationPath))]).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31,
    ]);
    expect(await NodeFSP.readdir(temporaryDirectory)).toEqual(["report.pdf"]);
  });

  it.each([
    [404, "source-unavailable"],
    [410, "source-unavailable"],
    [409, "source-changed"],
    [503, "network-failed"],
  ] as const)("maps HTTP %s without touching the destination", async (status, reason) => {
    const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(copyAssetToPath(request, destinationPath)).resolves.toEqual({
      _tag: "failed",
      reason,
    });
    await expect(NodeFSP.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its temporary file when the response stream fails", async () => {
    const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
            controller.error(new Error("connection dropped"));
          },
        }),
        { status: 200 },
      ),
    );

    await expect(copyAssetToPath(request, destinationPath)).resolves.toEqual({
      _tag: "failed",
      reason: "network-failed",
    });
    expect(await NodeFSP.readdir(temporaryDirectory)).toEqual([]);
  });

  it("preserves the existing destination when publication fails", async () => {
    const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");
    await NodeFSP.mkdir(destinationPath);
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46])));

    await expect(copyAssetToPath(request, destinationPath)).resolves.toEqual({
      _tag: "failed",
      reason: "write-failed",
    });
    expect((await NodeFSP.stat(destinationPath)).isDirectory()).toBe(true);
    expect(await NodeFSP.readdir(temporaryDirectory)).toEqual(["report.pdf"]);
  });

  it("reports transport failures and rejects non-HTTP sources", async () => {
    const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(copyAssetToPath(request, destinationPath)).resolves.toEqual({
      _tag: "failed",
      reason: "network-failed",
    });
    await expect(
      copyAssetToPath({ ...request, url: "file:///tmp/report.pdf" }, destinationPath),
    ).resolves.toEqual({ _tag: "failed", reason: "source-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.effect("treats native dialog cancellation as a normal result", () => {
    const owner = { id: 11 } as BrowserWindow;
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: "" });
    const windowLayer = Layer.succeed(
      ElectronWindow.ElectronWindow,
      ElectronWindow.ElectronWindow.of({
        focusedMainOrFirst: Effect.succeed(Option.some(owner)),
      } as ElectronWindow.ElectronWindow["Service"]),
    );

    return Effect.gen(function* () {
      const result = yield* saveAssetCopy(request);
      assert.deepStrictEqual(result, { _tag: "cancelled" });
      expect(showSaveDialogMock).toHaveBeenCalledWith(owner, {
        defaultPath: "report.pdf",
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(windowLayer));
  });

  it.effect("returns a typed failure when the native dialog cannot open", () => {
    showSaveDialogMock.mockRejectedValue(new Error("dialog unavailable"));
    const windowLayer = Layer.succeed(
      ElectronWindow.ElectronWindow,
      ElectronWindow.ElectronWindow.of({
        focusedMainOrFirst: Effect.succeed(Option.none()),
      } as ElectronWindow.ElectronWindow["Service"]),
    );

    return Effect.gen(function* () {
      const result = yield* saveAssetCopy(request);
      assert.deepStrictEqual(result, { _tag: "failed", reason: "dialog-failed" });
      expect(fetchMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(windowLayer));
  });

  it.effect("reveals the exact saved destination with the native file manager", () =>
    Effect.gen(function* () {
      const destinationPath = NodePath.join(temporaryDirectory, "report.pdf");

      yield* revealSavedAsset(destinationPath);

      expect(showItemInFolderMock).toHaveBeenCalledWith(destinationPath);
    }),
  );
});
