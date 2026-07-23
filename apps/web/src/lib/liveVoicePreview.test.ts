import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceRecordingPayload } from "./voiceRecorder";
import { LiveVoicePreviewSession } from "./liveVoicePreview";

const payload: VoiceRecordingPayload = {
  audioBase64: "UklGRg==",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 2_000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveVoicePreviewSession", () => {
  it("runs snapshots sequentially and publishes corrected full previews", async () => {
    vi.useFakeTimers();
    const transcribeSnapshot = vi
      .fn<(input: VoiceRecordingPayload) => Promise<string>>()
      .mockResolvedValueOnce("hello wor")
      .mockResolvedValueOnce("hello world.");
    const onPreview = vi.fn();
    const session = new LiveVoicePreviewSession();

    session.start({
      captureSnapshot: vi.fn(async () => payload),
      transcribeSnapshot,
      cancelActiveTranscription: vi.fn(async () => undefined),
      onPreview,
      initialDelayMs: 10,
      intervalMs: 20,
      maximumIntervalMs: 20,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(onPreview).toHaveBeenLastCalledWith("hello wor");
    await vi.advanceTimersByTimeAsync(20);
    expect(onPreview).toHaveBeenLastCalledWith("hello world.");
    expect(transcribeSnapshot).toHaveBeenCalledTimes(2);
    await session.stop();
  });

  it("cancels and drains an active preview before Stop or Send continues", async () => {
    vi.useFakeTimers();
    let rejectTranscription!: (error: Error) => void;
    const transcribeSnapshot = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectTranscription = reject;
        }),
    );
    const cancelActiveTranscription = vi.fn(async () => {
      rejectTranscription(new Error("cancelled"));
    });
    const session = new LiveVoicePreviewSession();
    session.start({
      captureSnapshot: vi.fn(async () => payload),
      transcribeSnapshot,
      cancelActiveTranscription,
      onPreview: vi.fn(),
      initialDelayMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    await session.stop();

    expect(cancelActiveTranscription).toHaveBeenCalledOnce();
  });

  it("stops previewing quietly when the local backend is unavailable", async () => {
    vi.useFakeTimers();
    const captureSnapshot = vi.fn(async () => payload);
    const session = new LiveVoicePreviewSession();
    session.start({
      captureSnapshot,
      transcribeSnapshot: vi.fn(async () => {
        throw new Error("model missing");
      }),
      cancelActiveTranscription: vi.fn(async () => undefined),
      onPreview: vi.fn(),
      initialDelayMs: 1,
      intervalMs: 1,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(captureSnapshot).toHaveBeenCalledOnce();
    await session.stop();
  });

  it("backs off full-recording previews as a dictation grows", async () => {
    vi.useFakeTimers();
    const captureSnapshot = vi.fn(async () => ({ ...payload, durationMs: 30_000 }));
    const session = new LiveVoicePreviewSession();
    session.start({
      captureSnapshot,
      transcribeSnapshot: vi.fn(async () => "preview"),
      cancelActiveTranscription: vi.fn(async () => undefined),
      onPreview: vi.fn(),
      initialDelayMs: 1,
      intervalMs: 20,
      maximumIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(captureSnapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    await session.stop();
  });
});
