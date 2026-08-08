import { describe, expect, it } from "vite-plus/test";

import { projectVoiceModelState, toVoiceModelRequestError } from "./DesktopVoice.ts";

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

describe("toVoiceModelRequestError", () => {
  it("reports cancellation without exposing internal errors", () => {
    const cause = new Error("private path");
    cause.name = "AbortError";
    expect(toVoiceModelRequestError(cause, "download")).toMatchObject({
      kind: "cancelled",
      safeMessage: "Offline voice setup was cancelled.",
    });
  });

  it("uses operation-specific safe messages", () => {
    expect(toVoiceModelRequestError(new Error("/private/model.bin"), "download")).toMatchObject({
      kind: "provider-error",
      safeMessage: "Offline voice setup failed. Please try again.",
    });
    expect(toVoiceModelRequestError(new Error("/private/model.bin"), "remove")).toMatchObject({
      kind: "provider-error",
      safeMessage: "The offline voice model could not be removed. Please try again.",
    });
  });
});
