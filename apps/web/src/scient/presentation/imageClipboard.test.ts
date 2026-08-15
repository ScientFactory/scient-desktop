import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { copyPngBlobToClipboard } from "./imageClipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PNG image clipboard", () => {
  it("prefers the native desktop bridge and sends the encoded bytes", async () => {
    const copyPngToClipboard = vi.fn().mockResolvedValue(undefined);
    const browserWrite = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { copyPngToClipboard } });
    vi.stubGlobal("navigator", { clipboard: { write: browserWrite } });

    await copyPngBlobToClipboard(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
    );

    expect(copyPngToClipboard).toHaveBeenCalledOnce();
    expect(copyPngToClipboard).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]));
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("uses the browser clipboard when the desktop capability is absent", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const items: Array<Record<string, Blob>> = [];
    function TestClipboardItem(data: Record<string, Blob>) {
      items.push(data);
    }
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    const png = new Blob(["png"], { type: "image/png" });

    await copyPngBlobToClipboard(png);

    expect(items).toEqual([{ "image/png": png }]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("does not hide a native clipboard failure behind the browser fallback", async () => {
    const cause = new Error("native copy failed");
    const browserWrite = vi.fn();
    vi.stubGlobal("window", {
      desktopBridge: { copyPngToClipboard: vi.fn().mockRejectedValue(cause) },
    });
    vi.stubGlobal("navigator", { clipboard: { write: browserWrite } });

    await expect(copyPngBlobToClipboard(new Blob(["png"], { type: "image/png" }))).rejects.toBe(
      cause,
    );
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("rejects non-PNG data and unavailable clipboard environments", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(
      copyPngBlobToClipboard(new Blob(["svg"], { type: "image/svg+xml" })),
    ).rejects.toThrow("requires an encoded PNG");
    await expect(copyPngBlobToClipboard(new Blob(["png"], { type: "image/png" }))).rejects.toThrow(
      "unavailable",
    );
  });
});
