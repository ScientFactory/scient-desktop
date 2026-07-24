// FILE: desktopVoiceService.test.ts
// Purpose: Verifies desktop composition, provider-neutral routing, model setup, and safe errors.
// Layer: Desktop voice tests

import { describe, expect, it, vi } from "vitest";
import type { VoiceTranscriptionBackend } from "@synara/shared/voiceTranscription";
import { VoiceTranscriptionBackendError } from "@synara/shared/voiceTranscription";
import { DesktopVoiceService } from "./desktopVoiceService";

function wavBase64(): string {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  return bytes.toString("base64");
}

const request = {
  provider: "grok",
  cwd: "/workspace",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1,
  audioBase64: wavBase64(),
} as const;

function manager(state: "missing" | "ready" = "ready") {
  let current = state;
  return {
    getStatus: vi.fn(async () =>
      current === "ready"
        ? ({ state: "ready", modelPath: "/model.bin", byteSize: 190 } as const)
        : ({ state: "missing" } as const),
    ),
    ensureInstalled: vi.fn(async () => {
      current = "ready";
      return "/model.bin";
    }),
    isDownloading: vi.fn(() => false),
    repair: vi.fn(async () => "/model.bin"),
    remove: vi.fn(async () => {
      current = "missing";
    }),
  };
}

function runtime() {
  return {
    isInstalled: vi.fn(async () => true),
    isBusy: vi.fn(() => false),
    stopIdle: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: "local text" })),
    dispose: vi.fn(async () => undefined),
  };
}

function remote(
  transcribe: VoiceTranscriptionBackend["transcribe"] = vi.fn(async () => ({ text: "cloud text" })),
): VoiceTranscriptionBackend {
  return {
    id: "chatgpt",
    getAvailability: vi.fn(async () => ({ state: "ready" as const })),
    transcribe,
  };
}

describe("DesktopVoiceService", () => {
  it("routes independently of the active text provider and prefers ChatGPT", async () => {
    const service = new DesktopVoiceService({
      modelManager: manager() as never,
      runtime: runtime(),
      createRemoteBackend: () => remote(),
    });

    await expect(service.transcribe(request)).resolves.toMatchObject({
      text: "cloud text",
      engine: "chatgpt",
      fallbackUsed: false,
    });
  });

  it("quietly falls back locally after a recoverable ChatGPT failure", async () => {
    const service = new DesktopVoiceService({
      modelManager: manager() as never,
      runtime: runtime(),
      createRemoteBackend: () =>
        remote(async () => {
          throw new VoiceTranscriptionBackendError({
            kind: "network",
            fallbackAllowed: true,
            safeMessage: "Network failed.",
          });
        }),
    });

    await expect(service.transcribe(request)).resolves.toMatchObject({
      text: "local text",
      engine: "local",
      fallbackUsed: true,
      fallbackReason: "network",
    });
  });

  it("keeps automatic ChatGPT voice available while the offline model downloads", async () => {
    let finishDownload!: () => void;
    const modelManager = manager("missing");
    modelManager.ensureInstalled.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishDownload = () => resolve("/model.bin");
        }),
    );
    const service = new DesktopVoiceService({
      modelManager: modelManager as never,
      runtime: runtime(),
      createRemoteBackend: () => remote(),
    });

    const download = service.downloadModel();
    await vi.waitFor(() => expect(modelManager.ensureInstalled).toHaveBeenCalledOnce());
    await expect(service.transcribe({ ...request, mode: "automatic" })).resolves.toMatchObject({
      text: "cloud text",
      engine: "chatgpt",
    });
    await expect(service.transcribe({ ...request, mode: "offline-only" })).rejects.toThrow(
      /maintenance/i,
    );
    finishDownload();
    await expect(download).resolves.toMatchObject({ model: { state: "missing" } });
  });

  it("propagates user cancellation to an active backend request", async () => {
    let observedSignal: AbortSignal | null = null;
    const service = new DesktopVoiceService({
      modelManager: manager() as never,
      runtime: runtime(),
      createRemoteBackend: () =>
        remote(
          (_clip, { signal }) =>
            new Promise((_resolve, reject) => {
              observedSignal = signal;
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ),
    });

    const transcription = service.transcribe(request);
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    service.cancelActiveTranscriptions();

    await expect(transcription).rejects.toThrow(/cancelled/i);
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("aborts and drains active transcription before disposal completes", async () => {
    let backendFinished = false;
    const whisperRuntime = runtime();
    const service = new DesktopVoiceService({
      modelManager: manager() as never,
      runtime: whisperRuntime,
      createRemoteBackend: () =>
        remote(
          (_clip, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  backendFinished = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        ),
    });

    const transcription = service.transcribe(request);
    await Promise.resolve();
    await service.dispose();

    await expect(transcription).rejects.toThrow(/cancelled/i);
    expect(backendFinished).toBe(true);
    expect(whisperRuntime.dispose).toHaveBeenCalledOnce();
  });

  it("exposes download/removal lifecycle and disposes the runtime", async () => {
    const modelManager = manager("missing");
    const whisperRuntime = runtime();
    const service = new DesktopVoiceService({
      modelManager: modelManager as never,
      runtime: whisperRuntime,
      createRemoteBackend: () => remote(),
    });

    await expect(service.getState()).resolves.toMatchObject({ model: { state: "missing" } });
    await expect(service.downloadModel()).resolves.toMatchObject({ model: { state: "ready" } });
    await expect(service.removeModel()).resolves.toMatchObject({ model: { state: "missing" } });
    await service.dispose();
    expect(whisperRuntime.dispose).toHaveBeenCalledOnce();
  });

  it("repairs without removing the installed model first", async () => {
    const modelManager = manager();
    const whisperRuntime = runtime();
    const service = new DesktopVoiceService({
      modelManager: modelManager as never,
      runtime: whisperRuntime,
      createRemoteBackend: () => remote(),
    });

    await expect(service.repairModel()).resolves.toMatchObject({ model: { state: "ready" } });
    expect(whisperRuntime.stopIdle).toHaveBeenCalledOnce();
    expect(modelManager.repair).toHaveBeenCalledOnce();
    expect(whisperRuntime.stopIdle.mock.invocationCallOrder[0]).toBeLessThan(
      modelManager.repair.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(modelManager.remove).not.toHaveBeenCalled();
  });

  it("does not remove the model during active local inference", async () => {
    const modelManager = manager();
    const whisperRuntime = runtime();
    whisperRuntime.isBusy.mockReturnValue(true);
    const service = new DesktopVoiceService({
      modelManager: modelManager as never,
      runtime: whisperRuntime,
      createRemoteBackend: () => remote(),
    });

    await expect(service.removeModel()).rejects.toThrow(/current voice transcription/i);
    expect(modelManager.remove).not.toHaveBeenCalled();
  });

  it("does not remove or repair the model while a download is active", async () => {
    const modelManager = manager();
    modelManager.isDownloading.mockReturnValue(true);
    const service = new DesktopVoiceService({
      modelManager: modelManager as never,
      runtime: runtime(),
      createRemoteBackend: () => remote(),
    });

    await expect(service.removeModel()).rejects.toThrow(/wait for/i);
    await expect(service.repairModel()).rejects.toThrow(/wait for/i);
    expect(modelManager.remove).not.toHaveBeenCalled();
    expect(modelManager.repair).not.toHaveBeenCalled();
  });
});
