// FILE: localWhisperBackend.test.ts
// Purpose: Verifies offline model/runtime availability and safe local failure normalization.
// Layer: Desktop voice runtime tests

import type { NormalizedVoiceClip } from "@synara/shared/voiceTranscription";
import { describe, expect, it, vi } from "vitest";
import { LocalWhisperBackend, type LocalWhisperRuntimeLike } from "./localWhisperBackend";
import { LocalWhisperRuntimeError } from "./localWhisperRuntime";

const clip: NormalizedVoiceClip = {
  audioBytes: new Uint8Array([1]),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 100,
  cwd: "/workspace",
};

function modelManager(state: "missing" | "ready" | "downloading") {
  return {
    getStatus: vi.fn(async () =>
      state === "ready"
        ? ({ state: "ready", modelPath: "/models/small.bin", byteSize: 10 } as const)
        : state === "downloading"
          ? ({ state: "downloading", downloadedBytes: 1, totalBytes: 10 } as const)
          : ({ state: "missing" } as const),
    ),
  };
}

function runtime(overrides: Partial<LocalWhisperRuntimeLike> = {}): LocalWhisperRuntimeLike {
  return {
    isInstalled: vi.fn(async () => true),
    isBusy: vi.fn(() => false),
    stopIdle: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: "offline transcript" })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("LocalWhisperBackend", () => {
  it("requires setup when the model has not been installed", async () => {
    const backend = new LocalWhisperBackend(modelManager("missing") as never, runtime());
    await expect(backend.getAvailability()).resolves.toEqual({
      state: "requires-setup",
      reason: "model-not-installed",
    });
  });

  it("reports ready and transcribes with the verified model path", async () => {
    const whisperRuntime = runtime();
    const backend = new LocalWhisperBackend(modelManager("ready") as never, whisperRuntime);
    const signal = new AbortController().signal;

    await expect(backend.getAvailability()).resolves.toEqual({ state: "ready" });
    await expect(backend.transcribe(clip, { signal })).resolves.toEqual({
      text: "offline transcript",
    });
    expect(whisperRuntime.transcribe).toHaveBeenCalledWith("/models/small.bin", clip, signal);
  });

  it("normalizes runtime crashes as safe non-fallback local failures", async () => {
    const backend = new LocalWhisperBackend(
      modelManager("ready") as never,
      runtime({
        transcribe: vi.fn(async () => {
          throw new Error("native crash details");
        }),
      }),
    );

    await expect(
      backend.transcribe(clip, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind: "provider-error",
      fallbackAllowed: false,
      safeMessage: "Offline voice transcription failed.",
    });
  });

  it("preserves the typed inference timeout", async () => {
    const backend = new LocalWhisperBackend(
      modelManager("ready") as never,
      runtime({
        transcribe: vi.fn(async () => {
          throw new LocalWhisperRuntimeError("timeout", "timed out");
        }),
      }),
    );

    await expect(
      backend.transcribe(clip, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind: "timeout",
      safeMessage: "Offline voice transcription timed out.",
    });
  });
});
