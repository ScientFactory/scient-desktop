import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, type ScientAnalyticsUiEvent } from "@t3tools/contracts";
import {
  cancelVoiceJob,
  finishVoiceJobWithOriginal,
  resetVoiceProcessingForTests,
  startVoiceJob,
  type VoiceJobInput,
} from "./voiceProcessing.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const clip = {
  wavBytes: new Uint8Array(),
  base64: "synthetic",
  durationMs: 3000,
  sampleRateHz: 24_000 as const,
};
const fixture = (overrides: Partial<VoiceJobInput> = {}) => {
  const events: ScientAnalyticsUiEvent[] = [];
  const deliver = vi.fn();
  const fail = vi.fn();
  const input: VoiceJobInput = {
    ownerKey: "synthetic-owner",
    clip: Promise.resolve(clip),
    send: false,
    voiceBridge: {
      transcribe: async () => ({ text: "private synthetic transcript", engine: "local" }),
    },
    correction: null,
    language: undefined,
    recordAnalytics: (event) => events.push(event),
    deliver,
    fail,
    ...overrides,
  };
  return { input, events, deliver, fail };
};

afterEach(() => {
  resetVoiceProcessingForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("voice job analytics lifecycle", () => {
  it("closes cancellation during the final audio flush as preparing, without starting the engine", async () => {
    const pending = deferred<typeof clip | null>();
    const transcribe = vi.fn<VoiceJobInput["voiceBridge"]["transcribe"]>();
    const f = fixture({ clip: pending.promise, voiceBridge: { transcribe } });
    const job = startVoiceJob(f.input);
    await cancelVoiceJob(job.id);
    pending.resolve(null);
    await job.done;
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.cancelled",
    ]);
    expect(f.events[1]?.properties.stage).toBe("preparing");
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("does not let an analytics defect prevent delivery", async () => {
    const f = fixture({
      recordAnalytics: () => {
        throw new Error("synthetic analytics defect");
      },
    });
    await startVoiceJob(f.input).done;
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.fail).not.toHaveBeenCalled();
  });

  it("records a delivery failure instead of losing the terminal outcome", async () => {
    const f = fixture({
      deliver: () => {
        throw new Error("private delivery failure");
      },
    });
    await startVoiceJob(f.input).done;
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.failed",
    ]);
    expect(f.events[1]?.properties).toMatchObject({
      failureClass: "delivery",
      stage: "delivering",
    });
    expect(JSON.stringify(f.events)).not.toContain("private");
  });
  it.each(["engine", "silence"])("closes %s failure with a single terminal event", async (mode) => {
    const f = fixture({
      voiceBridge: {
        transcribe: async () => {
          if (mode === "engine") throw new Error("private engine details");
          return { engine: "local", text: "  " };
        },
      },
    });
    await startVoiceJob(f.input).done;
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.failed",
    ]);
    expect(f.events[1]?.properties).toMatchObject({
      stage: "transcribing",
      failureClass: mode === "engine" ? "engine" : "audio",
    });
    expect(JSON.stringify(f.events)).not.toContain("private");
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("cancels only its own in-flight transcription and ignores the late result", async () => {
    const result = deferred<{ text: string; engine: "local" }>();
    const started = deferred<void>();
    const cancel = vi.fn(async () => undefined);
    const f = fixture({
      voiceBridge: {
        transcribe: () => {
          started.resolve();
          return result.promise;
        },
        cancelTranscriptionRequest: cancel,
      },
    });
    const job = startVoiceJob(f.input);
    await started.promise;
    await cancelVoiceJob(job.id);
    result.resolve({ text: "private late result", engine: "local" });
    await job.done;
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.cancelled",
    ]);
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it.each(["empty", "rejected"])("closes a %s clip once", async (value) => {
    const f = fixture({
      clip:
        value === "empty"
          ? Promise.resolve(null)
          : Promise.reject(new Error("private flush error")),
    });
    const job = startVoiceJob(f.input);
    await job.done;
    await cancelVoiceJob(job.id);
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.failed",
    ]);
    expect(f.events[1]?.properties).toMatchObject({
      stage: "preparing",
      failureClass: "audio",
      voiceSchemaVersion: 2,
    });
    expect(f.fail).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events)).not.toMatch(/private|synthetic/u);
  });

  it("delivers once and does not count late cancellation as another result", async () => {
    const f = fixture();
    const job = startVoiceJob(f.input);
    await job.done;
    finishVoiceJobWithOriginal(job.id);
    await cancelVoiceJob(job.id);
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.events.map((event) => event.name)).toEqual([
      "voice.transcription.started",
      "voice.transcription.completed",
    ]);
    expect(f.events[1]?.properties).toMatchObject({
      correctionOutcome: "disabled",
      voiceSchemaVersion: 2,
    });
    expect(JSON.stringify(f.events)).not.toMatch(/private|synthetic/u);
  });

  it.each(["cancel", "bypass"] as const)(
    "closes correction exactly once on %s and ignores its late result",
    async (action) => {
      const result = deferred<{ text: string; provider: ProviderDriverKind }>();
      const started = deferred<void>();
      const f = fixture({
        correction: {
          environmentId: EnvironmentId.make("synthetic"),
          corrector: {
            correct: () => {
              started.resolve();
              return result.promise;
            },
          },
        },
      });
      const job = startVoiceJob(f.input);
      await started.promise;
      if (action === "cancel") await cancelVoiceJob(job.id);
      else finishVoiceJobWithOriginal(job.id);
      result.resolve({
        text: "private late correction",
        provider: ProviderDriverKind.make("codex"),
      });
      await job.done;
      expect(f.events.map((event) => event.name)).toEqual([
        "voice.transcription.started",
        action === "cancel" ? "voice.transcription.cancelled" : "voice.transcription.completed",
      ]);
      expect(f.events[1]?.properties).toMatchObject({
        correctionOutcome: action === "cancel" ? "cancelled" : "bypassed",
      });
      if (action === "cancel") {
        expect(f.events[1]?.properties.stage).toBe("correcting");
        expect(f.deliver).not.toHaveBeenCalled();
      } else expect(f.deliver).toHaveBeenCalledWith("private synthetic transcript", false);
    },
  );

  it("measures transcription and correction separately and reports fallback", async () => {
    vi.useFakeTimers();
    const engine = deferred<{ text: string; engine: "local" }>();
    const correction = deferred<{ text: string; provider: ProviderDriverKind }>();
    const engineStarted = deferred<void>();
    const correctionStarted = deferred<void>();
    const f = fixture({
      voiceBridge: {
        transcribe: () => {
          engineStarted.resolve();
          return engine.promise;
        },
      },
      correction: {
        environmentId: EnvironmentId.make("synthetic"),
        corrector: {
          correct: () => {
            correctionStarted.resolve();
            return correction.promise;
          },
        },
      },
    });
    const job = startVoiceJob(f.input);
    await engineStarted.promise;
    vi.advanceTimersByTime(200);
    engine.resolve({ text: "private local transcript", engine: "local" });
    await correctionStarted.promise;
    vi.advanceTimersByTime(500);
    // A provider's empty correction intentionally falls back to the local transcript.
    const fallback = { text: "", provider: ProviderDriverKind.make("codex") };
    correction.resolve(fallback);
    await job.done;
    expect(f.events[1]?.properties).toMatchObject({
      durationMs: 700,
      transcriptionDurationMs: 200,
      correctionDurationMs: 500,
      correctionOutcome: "fallback",
    });
    expect(f.deliver).toHaveBeenCalledWith("private local transcript", false);
  });
});
