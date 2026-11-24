import { describe, expect, it, vi } from "vite-plus/test";
import {
  VOICE_REQUEST_MICROPHONE_ACCESS_CHANNEL,
  VOICE_HAS_LEGACY_MODELS_CHANNEL,
  VOICE_REMOVE_LEGACY_MODELS_CHANNEL,
  VOICE_HAD_LEGACY_SELECTION_CHANNEL,
} from "../../ipc/channels.ts";
import { makeDesktopVoiceBridge } from "./preloadBridge.ts";

describe("makeDesktopVoiceBridge", () => {
  // regression: cb2164c119 fix(voice): restore first-run macOS microphone access (#319)
  it("requests native microphone access through its dedicated IPC method", async () => {
    const invoke = vi.fn().mockResolvedValue("granted");
    const bridge = makeDesktopVoiceBridge({ invoke });

    await expect(bridge.requestMicrophoneAccess?.()).resolves.toBe("granted");
    expect(invoke).toHaveBeenCalledWith(VOICE_REQUEST_MICROPHONE_ACCESS_CHANNEL);
  });
  it("uses the dedicated migration and cleanup methods", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined);
    const bridge = makeDesktopVoiceBridge({ invoke });
    await expect(bridge.hadLegacySelection?.()).resolves.toBe(true);
    await expect(bridge.hasLegacyModels?.()).resolves.toBe(false);
    await expect(bridge.removeLegacyModels?.()).resolves.toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      [VOICE_HAD_LEGACY_SELECTION_CHANNEL],
      [VOICE_HAS_LEGACY_MODELS_CHANNEL],
      [VOICE_REMOVE_LEGACY_MODELS_CHANNEL],
    ]);
  });
});
