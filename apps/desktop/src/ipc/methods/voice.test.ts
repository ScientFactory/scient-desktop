import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { requestMicrophoneAccessForPlatform } from "./voice.ts";

describe("requestMicrophoneAccessForPlatform", () => {
  it("requests a fresh macOS grant exactly once", async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true);
    const result = await requestMicrophoneAccessForPlatform("darwin", {
      getMediaAccessStatus: () => "not-determined",
      askForMediaAccess,
    });

    assert.equal(result, "granted");
    assert.equal(askForMediaAccess.mock.calls.length, 1);
    assert.deepEqual(askForMediaAccess.mock.calls[0], ["microphone"]);
  });

  it("does not prompt again after macOS has recorded a decision", async () => {
    for (const status of ["granted", "denied", "restricted"] as const) {
      const askForMediaAccess = vi.fn().mockResolvedValue(true);
      const result = await requestMicrophoneAccessForPlatform("darwin", {
        getMediaAccessStatus: () => status,
        askForMediaAccess,
      });

      assert.equal(result, status);
      assert.equal(askForMediaAccess.mock.calls.length, 0);
    }
  });

  it("reports a rejected first prompt as denied", async () => {
    const statuses = ["not-determined", "denied"] as const;
    let read = 0;
    const result = await requestMicrophoneAccessForPlatform("darwin", {
      getMediaAccessStatus: () => statuses[Math.min(read++, statuses.length - 1)]!,
      askForMediaAccess: () => Promise.resolve(false),
    });

    assert.equal(result, "denied");
  });

  it("leaves non-macOS hosts on the existing browser permission path", async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true);
    const result = await requestMicrophoneAccessForPlatform("win32", {
      getMediaAccessStatus: () => "not-determined",
      askForMediaAccess,
    });

    assert.equal(result, "unavailable");
    assert.equal(askForMediaAccess.mock.calls.length, 0);
  });

  it("falls back to renderer capture when native permission APIs are unavailable", async () => {
    for (const preferences of [
      {
        getMediaAccessStatus: () => {
          throw new Error("unavailable");
        },
        askForMediaAccess: () => Promise.resolve(true),
      },
      {
        getMediaAccessStatus: () => "unknown" as const,
        askForMediaAccess: () => Promise.resolve(true),
      },
      {
        getMediaAccessStatus: () => "not-determined" as const,
        askForMediaAccess: () => Promise.reject(new Error("unavailable")),
      },
    ]) {
      assert.equal(await requestMicrophoneAccessForPlatform("darwin", preferences), "unavailable");
    }
  });
});
