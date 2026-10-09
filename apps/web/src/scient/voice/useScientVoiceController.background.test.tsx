// @vitest-environment happy-dom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type DesktopVoiceBridge,
  type VoiceModelsSnapshot,
  type VoiceTranscript,
  type VoiceTranscriptCorrectionResult,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore.ts";
import { toastManager } from "../../components/ui/toast.tsx";
import type { UseVoiceRecorderOptions } from "./useVoiceRecorder.ts";
import {
  registerVoiceDraftEndpoint,
  type VoiceDraftEndpoint,
  type VoiceDraftOrigin,
} from "./voiceDraftDelivery.ts";
import { resetVoiceProcessingForTests } from "./voiceProcessing.ts";
import type { VoiceTranscriptCorrectionClient } from "./voiceTranscriptCorrectionClient.ts";

const recorder = vi.hoisted(() => ({
  start: vi.fn(async () => true),
  stop: vi.fn(async () => ({ base64: "synthetic", sampleRateHz: 24000, durationMs: 1000 })),
  cancel: vi.fn(async () => {}),
  status: "idle" as const,
  errorKind: null,
  levels: [],
}));
const analytics = vi.hoisted(() => vi.fn());
vi.mock("./useVoiceRecorder.ts", () => ({
  useVoiceRecorder: (_options: UseVoiceRecorderOptions) => recorder,
}));
vi.mock("../analytics/client.ts", () => ({ useRecordScientAnalytics: () => analytics }));
import {
  useScientVoiceController,
  type ScientVoiceController,
} from "./useScientVoiceController.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const snapshot = {
  runtimeAvailable: true,
  selectedModelId: "whisper-small-multilingual-q5_1",
  recommendation: null,
  activeDownloadModelId: null,
  models: [
    {
      id: "whisper-small-multilingual-q5_1",
      displayName: "Small",
      description: "Test",
      byteSize: 1,
      state: { state: "ready", byteSize: 1 },
    },
  ],
} satisfies VoiceModelsSnapshot;

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const THREAD_A = scopeThreadRef(LOCAL, ThreadId.make("thread-a"));
const THREAD_B = scopeThreadRef(LOCAL, ThreadId.make("thread-b"));
const THREAD_A_REMOTE = scopeThreadRef(REMOTE, ThreadId.make("thread-a"));

function originFor(target: typeof THREAD_A): VoiceDraftOrigin {
  return { key: composerTargetKey(target), target, title: "Thread", open: vi.fn() };
}

// Frames run only when a test says so, so it can act between insert and submit.
const frames: Array<FrameRequestCallback> = [];
const nextFrame = () => {
  for (const frame of frames.splice(0)) frame(0);
};

describe("committed composer dictation outlives navigation", () => {
  let root: Root;
  let client: DesktopVoiceBridge;
  let pending: ReturnType<typeof deferred<VoiceTranscript>>;
  let correctionClient: VoiceTranscriptCorrectionClient | undefined;
  let control: ScientVoiceController;
  let now: number;
  const local = vi.fn();
  const composers = new Map<string, VoiceDraftEndpoint & { accepts: boolean; ready: boolean }>();
  const unregister = new Map<string, () => void>();

  /** Stands in for a mounted ChatComposer for `target`. */
  function mountComposer(target: typeof THREAD_A) {
    const key = composerTargetKey(target);
    const composer = {
      accepts: true,
      ready: true,
      acceptsDraftText: () => composer.accepts,
      insert: vi.fn((_text: string) => true),
      canSubmit: () => composer.ready,
      submit: vi.fn(),
    };
    composers.set(key, composer);
    unregister.set(key, registerVoiceDraftEndpoint(key, composer));
    return composer;
  }
  function unmountComposer(target: typeof THREAD_A) {
    unregister.get(composerTargetKey(target))?.();
  }

  function Probe({
    origin,
    field = null,
  }: {
    origin: VoiceDraftOrigin | null;
    field?: string | null;
  }) {
    const value = useScientVoiceController({
      client,
      draftOrigin: origin,
      localFieldKey: field,
      onTranscript: local,
      environmentId: LOCAL,
      correctionEnabled: !!correctionClient,
      ...(correctionClient ? { correctionClient } : {}),
    });
    useLayoutEffect(() => {
      control = value;
    });
    return null;
  }
  async function show(target: typeof THREAD_A | null) {
    await act(() =>
      root.render(
        target ? <Probe key={composerTargetKey(target)} origin={originFor(target)} /> : null,
      ),
    );
  }
  async function record() {
    await act(() => control.activate());
    now += 300;
  }
  async function stop(send: boolean) {
    let done!: Promise<void>;
    await act(async () => {
      done = control.stop(send);
    });
    // Wrapped: returning the promise itself from an async helper would await it.
    return { done };
  }
  async function transcribe(done: Promise<void>, text = "dictated words") {
    await act(async () => {
      pending.resolve({ text, engine: "local" });
      await done;
    });
  }
  const storedPrompt = (target: typeof THREAD_A) =>
    useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.clearAllMocks();
    vi.spyOn(toastManager, "add");
    correctionClient = undefined;
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    pending = deferred<VoiceTranscript>();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    client = {
      getModelsState: async () => snapshot,
      downloadModel: async () => snapshot,
      cancelModelDownload: vi.fn(),
      selectModel: async () => snapshot,
      removeModel: async () => snapshot,
      transcribe: vi.fn(() => pending.promise),
      cancelTranscription: vi.fn(async () => {}),
      cancelTranscriptionRequest: vi.fn(async () => {}),
      onModelDownloadProgress: () => () => {},
    };
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(() => root.unmount());
    for (const cleanup of unregister.values()) cleanup();
    unregister.clear();
    composers.clear();
    resetVoiceProcessingForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "A → B during transcription keeps the dictation for A's draft (send: %s)",
    async (send) => {
      mountComposer(THREAD_A);
      await show(THREAD_A);
      await record();
      const { done } = await stop(send);
      unmountComposer(THREAD_A);
      const b = mountComposer(THREAD_B);
      await show(THREAD_B);

      expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
      expect(control.phase).toBe("idle");
      await transcribe(done);
      await act(nextFrame);

      expect(storedPrompt(THREAD_A)).toBe("dictated words");
      expect(storedPrompt(THREAD_B)).toBe("");
      expect(b.insert).not.toHaveBeenCalled();
      expect(b.submit).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
      expect(toastManager.add).toHaveBeenCalledOnce();
      expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject(
        send
          ? { title: "Transcript saved to “Thread”", description: "Message not sent." }
          : { title: "Transcript added to “Thread”" },
      );
    },
  );

  it("staying on A sends through A's composer after inserting", async () => {
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(true);
    expect(control.phase).toBe("transcribing");
    await transcribe(done);
    expect(a.insert).toHaveBeenCalledExactlyOnceWith("dictated words");
    expect(a.submit).not.toHaveBeenCalled();
    await act(nextFrame);
    expect(a.submit).toHaveBeenCalledOnce();
    expect(control.phase).toBe("idle");
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("a question arriving before completion keeps the text in the ordinary draft, unsent", async () => {
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(true);
    a.accepts = false;
    await transcribe(done);
    await act(nextFrame);
    expect(a.insert).not.toHaveBeenCalled();
    expect(a.submit).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
  });

  it("navigating away between insertion and the scheduled submit does not send", async () => {
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(true);
    await transcribe(done);
    expect(a.insert).toHaveBeenCalledOnce();
    unmountComposer(THREAD_A);
    await act(nextFrame);
    expect(a.submit).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      description: "Message not sent.",
    });
  });

  it("A → B → A shows A's job again and can cancel exactly its request", async () => {
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    const requestId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    unmountComposer(THREAD_A);
    mountComposer(THREAD_B);
    await show(THREAD_B);
    expect(control.phase).toBe("idle");
    unmountComposer(THREAD_B);
    mountComposer(THREAD_A);
    await show(THREAD_A);
    expect(control.phase).toBe("transcribing");

    await act(() => control.cancel());
    expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({ requestId });
    await transcribe(done);
    expect(storedPrompt(THREAD_A)).toBe("");
    expect(composers.get(composerTargetKey(THREAD_A))!.insert).not.toHaveBeenCalled();
  });

  it("the same thread id in another environment neither shows nor receives the job", async () => {
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    unmountComposer(THREAD_A);
    const remote = mountComposer(THREAD_A_REMOTE);
    await show(THREAD_A_REMOTE);
    expect(control.phase).toBe("idle");
    await transcribe(done);
    expect(remote.insert).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A_REMOTE)).toBe("");
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
  });

  it("leaving during correction keeps correcting and delivers once", async () => {
    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    await act(async () => {
      pending.resolve({ text: "orignal words", engine: "local" });
    });
    expect(control.phase).toBe("correcting");
    unmountComposer(THREAD_A);
    await show(THREAD_B);
    const signal = vi.mocked(correctionClient.correct).mock.calls[0]![0].signal;
    expect(signal.aborted).toBe(false);
    await act(async () => {
      correction.resolve({ text: "original words", provider: "codex" } as never);
      await done;
    });
    expect(storedPrompt(THREAD_A)).toBe("original words");
  });

  it("Use original after returning completes once and ignores the late correction", async () => {
    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    await act(async () => {
      pending.resolve({ text: "local words", engine: "local" });
    });
    await show(THREAD_B);
    await show(THREAD_A);
    expect(control.phase).toBe("correcting");
    await act(() => control.useOriginal());
    expect(a.insert).toHaveBeenCalledExactlyOnceWith("local words");
    await act(async () => {
      correction.resolve({ text: "late words", provider: "codex" } as never);
      await done;
    });
    expect(a.insert).toHaveBeenCalledOnce();
  });

  it("a failure while away becomes a notice instead of a stale control error", async () => {
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    unmountComposer(THREAD_A);
    await show(THREAD_B);
    await act(async () => {
      pending.reject(new Error("Engine failed"));
      await done;
    });
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Voice transcription failed",
      description: "Engine failed",
    });
    mountComposer(THREAD_A);
    await show(THREAD_A);
    expect(control.errorMessage).toBeNull();
  });

  it("a failure on the visible origin shows in its control", async () => {
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    await act(async () => {
      pending.reject(new Error("Engine failed"));
      await done;
    });
    expect(control.errorMessage).toBe("Engine failed");
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("ownership is committed at the click, before the final audio flush resolves", async () => {
    const flush = deferred<{ base64: string; sampleRateHz: number; durationMs: number }>();
    recorder.stop.mockImplementationOnce(() => flush.promise);
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(false);
    unmountComposer(THREAD_A);
    const b = mountComposer(THREAD_B);
    await show(THREAD_B);
    expect(client.transcribe).not.toHaveBeenCalled();
    await act(async () => {
      flush.resolve({ base64: "synthetic", sampleRateHz: 24000, durationMs: 1000 });
    });
    expect(client.transcribe).toHaveBeenCalledOnce();
    await transcribe(done);
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
    expect(b.insert).not.toHaveBeenCalled();
  });

  it("A → B during correction with Send saves to A and sends nothing", async () => {
    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(true);
    await act(async () => {
      pending.resolve({ text: "local words", engine: "local" });
    });
    expect(control.phase).toBe("correcting");
    unmountComposer(THREAD_A);
    const b = mountComposer(THREAD_B);
    await show(THREAD_B);
    await act(async () => {
      correction.resolve({ text: "corrected words", provider: "codex" } as never);
      await done;
    });
    await act(nextFrame);
    expect(storedPrompt(THREAD_A)).toBe("corrected words");
    expect(a.submit).not.toHaveBeenCalled();
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.submit).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      description: "Message not sent.",
    });
  });

  it("staying on A whose composer cannot send right now inserts and says not sent", async () => {
    const a = mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    const { done } = await stop(true);
    a.ready = false;
    await transcribe(done);
    await act(nextFrame);
    expect(a.insert).toHaveBeenCalledOnce();
    expect(a.submit).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      description: "Message not sent.",
    });
  });

  it.each([
    ["another question", "request-1:question-2"],
    ["no question", null],
  ])("answer dictation ends when the field changes to %s first", async (_label, next) => {
    await act(() => root.render(<Probe origin={null} field="request-1:question-1" />));
    await record();
    const { done } = await stop(false);
    const requestId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    await act(() => root.render(<Probe origin={null} field={next} />));
    expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({ requestId });
    await transcribe(done);
    expect(local).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A)).toBe("");
  });

  it("answer dictation is delivered to its own unchanged field", async () => {
    await act(() => root.render(<Probe origin={null} field="request-1:question-1" />));
    await record();
    const { done } = await stop(false);
    await transcribe(done);
    expect(local).toHaveBeenCalledExactlyOnceWith("dictated words");
    expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
  });

  it("leaving while still recording cancels and keeps nothing", async () => {
    mountComposer(THREAD_A);
    await show(THREAD_A);
    await record();
    expect(control.phase).toBe("recording");
    unmountComposer(THREAD_A);
    await show(THREAD_B);
    expect(recorder.cancel).toHaveBeenCalled();
    expect(client.transcribe).not.toHaveBeenCalled();
  });
});
