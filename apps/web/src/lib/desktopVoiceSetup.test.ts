// FILE: desktopVoiceSetup.test.ts
// Purpose: Verifies first-use local setup without making automatic cloud voice brittle.
// Layer: Web voice UX tests

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDesktopVoiceReady } from "./desktopVoiceSetup";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function installBridge(input: {
  state: "missing" | "downloading";
  confirm?: boolean;
  downloadFails?: boolean;
}) {
  const getState = vi.fn(async () => ({
    runtimeAvailable: true,
    model:
      input.state === "missing"
        ? ({ state: "missing" } as const)
        : ({ state: "downloading", downloadedBytes: 10, totalBytes: 100 } as const),
    modelName: "Multilingual Small",
    modelByteSize: 190_085_487,
  }));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: {
        confirm: vi.fn(async () => input.confirm ?? false),
        voice: {
          getState,
          downloadModel: vi.fn(async () => {
            if (input.downloadFails) throw new Error("network details");
            return {
              ...(await getState()),
              model: { state: "ready", byteSize: 190_085_487 },
            };
          }),
        },
      },
    },
  });
}

describe("ensureDesktopVoiceReady", () => {
  it("allows automatic ChatGPT voice when local setup is declined", async () => {
    installBridge({ state: "missing", confirm: false });
    await expect(ensureDesktopVoiceReady("automatic", vi.fn())).resolves.toBe(true);
  });

  it("blocks offline-only voice until the local model is ready", async () => {
    installBridge({ state: "missing", confirm: false });
    await expect(ensureDesktopVoiceReady("offline-only", vi.fn())).resolves.toBe(false);
  });

  it("explains that automatic mode continues remotely during a download", async () => {
    installBridge({ state: "downloading" });
    const feedback = vi.fn();
    await expect(ensureDesktopVoiceReady("automatic", feedback)).resolves.toBe(true);
    expect(feedback).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Continuing with ChatGPT") }),
    );
  });

  it("warns but continues automatically after a local download failure", async () => {
    installBridge({ state: "missing", confirm: true, downloadFails: true });
    const feedback = vi.fn();
    await expect(ensureDesktopVoiceReady("automatic", feedback)).resolves.toBe(true);
    expect(feedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Offline fallback isn't ready; trying ChatGPT",
      }),
    );
  });

  it("warns but still lets automatic mode try ChatGPT when local state cannot be read", async () => {
    installBridge({ state: "missing" });
    const voice = globalThis.window.desktopBridge?.voice;
    if (!voice) throw new Error("voice bridge missing");
    vi.mocked(voice.getState).mockRejectedValueOnce(new Error("IPC unavailable"));
    const feedback = vi.fn();

    await expect(ensureDesktopVoiceReady("automatic", feedback)).resolves.toBe(true);
    expect(feedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: expect.stringContaining("Trying ChatGPT"),
      }),
    );
  });

  it("blocks offline-only mode when local state cannot be read", async () => {
    installBridge({ state: "missing" });
    const voice = globalThis.window.desktopBridge?.voice;
    if (!voice) throw new Error("voice bridge missing");
    vi.mocked(voice.getState).mockRejectedValueOnce(new Error("IPC unavailable"));

    await expect(ensureDesktopVoiceReady("offline-only", vi.fn())).resolves.toBe(false);
  });
});
