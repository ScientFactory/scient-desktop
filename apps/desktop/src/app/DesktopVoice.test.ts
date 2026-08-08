import { describe, expect, it } from "vite-plus/test";

import { projectVoiceModelState } from "./DesktopVoice.ts";

describe("projectVoiceModelState", () => {
  it("never exposes the installed model path", () => {
    expect(
      projectVoiceModelState({
        state: "ready",
        modelPath: "/Users/example/private/voice/model.bin",
        byteSize: 190_085_487,
      }),
    ).toEqual({ state: "ready", byteSize: 190_085_487 });
  });

  it("never exposes a usable repair path while a download is active", () => {
    expect(
      projectVoiceModelState({
        state: "downloading",
        downloadedBytes: 10,
        totalBytes: 20,
        readyModelPath: "/Users/example/private/voice/model.bin",
      }),
    ).toEqual({ state: "downloading", downloadedBytes: 10, totalBytes: 20 });
  });
});
