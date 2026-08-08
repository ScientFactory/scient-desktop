import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeDesktopVoiceBridge } from "./preloadBridge.ts";

afterEach(() => vi.useRealTimers());

describe("makeDesktopVoiceBridge", () => {
  it("projects download polling into progress and stops after unsubscribe", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue({
      state: "downloading",
      downloadedBytes: 25,
      totalBytes: 100,
    });
    const listener = vi.fn();
    const bridge = makeDesktopVoiceBridge({ invoke });

    const unsubscribe = bridge.onModelDownloadProgress(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith({ downloadedBytes: 25, totalBytes: 100 });

    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
