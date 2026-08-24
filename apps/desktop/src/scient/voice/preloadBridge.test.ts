import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { VOICE_CANCEL_MODEL_DOWNLOAD_CHANNEL } from "../../ipc/channels.ts";
import { makeDesktopVoiceBridge } from "./preloadBridge.ts";

afterEach(() => vi.useRealTimers());

describe("makeDesktopVoiceBridge", () => {
  it("cancels model setup through its dedicated IPC method", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = makeDesktopVoiceBridge({ invoke });

    await bridge.cancelModelDownload({ modelId: "whisper-small-multilingual-q5_1" });

    expect(invoke).toHaveBeenCalledWith(VOICE_CANCEL_MODEL_DOWNLOAD_CHANNEL, {
      modelId: "whisper-small-multilingual-q5_1",
    });
  });

  it("projects download polling into progress and stops after unsubscribe", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue({
      runtimeAvailable: true,
      selectedModelId: null,
      recommendation: null,
      activeDownloadModelId: "whisper-small-multilingual-q5_1",
      models: [
        {
          id: "whisper-small-multilingual-q5_1",
          displayName: "Multilingual Small",
          description: "Compact local multilingual transcription.",
          byteSize: 100,
          state: { state: "downloading", downloadedBytes: 25, totalBytes: 100 },
        },
        {
          id: "whisper-medium-multilingual-q5_0",
          displayName: "Multilingual Medium",
          description: "Higher-accuracy local multilingual transcription.",
          byteSize: 200,
          state: { state: "missing" },
        },
        {
          id: "whisper-large-v3-turbo-multilingual-q5_0",
          displayName: "Multilingual Turbo",
          description: "Most capable local multilingual transcription.",
          byteSize: 300,
          state: { state: "missing" },
        },
      ],
    });
    const listener = vi.fn();
    const bridge = makeDesktopVoiceBridge({ invoke });

    const unsubscribe = bridge.onModelDownloadProgress(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith({
      modelId: "whisper-small-multilingual-q5_1",
      downloadedBytes: 25,
      totalBytes: 100,
    });

    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
