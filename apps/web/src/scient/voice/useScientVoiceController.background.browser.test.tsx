import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  act,
} from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type DesktopVoiceBridge,
  type VoiceModelsSnapshot,
  type VoiceTranscript,
  type VoiceTranscriptCorrectionResult,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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
  return {
    key: composerTargetKey(target),
    target,
    environmentId: target.environmentId,
    title: "Thread",
    open: vi.fn(),
  };
}

// Frames run only when a test says so, so it can act between insert and submit.

const nextFrame = (_fixture: _Fixture) => {
  for (const frame of _fixture.frames.splice(0)) frame(0);
};

describe("committed composer dictation outlives navigation", () => {
  let client: DesktopVoiceBridge;
  let pending: ReturnType<typeof deferred<VoiceTranscript>>;
  let correctionClient: VoiceTranscriptCorrectionClient | undefined;

  let now: number;
  const local = vi.fn();

  /** Stands in for a mounted ChatComposer for `target`. */
  function mountComposer(_fixture: _Fixture, target: typeof THREAD_A) {
    const key = composerTargetKey(target);
    const composer = {
      accepts: true,
      ready: true,
      acceptsDraftText: () => composer.accepts,
      environmentId: () => target.environmentId,
      insert: vi.fn((_text: string) => true),
      canSubmit: () => composer.ready,
      submit: vi.fn(),
    };
    _fixture.composers.set(key, composer);
    _fixture.unregister.set(key, registerVoiceDraftEndpoint(key, composer));
    return composer;
  }
  function unmountComposer(_fixture: _Fixture, target: typeof THREAD_A) {
    _fixture.unregister.get(composerTargetKey(target))?.();
  }

  function Probe({
    _fixture,
    origin,
    field = null,
  }: {
    origin: VoiceDraftOrigin | null;
    field?: string | null;
  } & { _fixture: _Fixture }) {
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
      _fixture.publishControl(value);
    });
    return null;
  }
  async function show(_fixture: _Fixture, target: typeof THREAD_A | null) {
    await act(
      async () =>
        await _fixture.root0.rerender(
          target ? (
            <Probe _fixture={_fixture} key={composerTargetKey(target)} origin={originFor(target)} />
          ) : null,
        ),
    );
  }
  async function record(_fixture: _Fixture) {
    await act(() => _fixture.control.activate());
    now += 300;
  }
  async function stop(_fixture: _Fixture, send: boolean) {
    let done!: Promise<void>;
    await act(async () => {
      done = _fixture.control.stop(send);
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

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.frames.length = 0;
    _fixture.stack.use(
      _fixtureStubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        _fixture.frames.push(callback);
        return _fixture.frames.length;
      }),
    );
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
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    for (const cleanup of _fixture.unregister.values()) cleanup();
    _fixture.unregister.clear();
    _fixture.composers.clear();
    resetVoiceProcessingForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }

  it.each([false, true])(
    "A → B during transcription keeps the dictation for A's draft (send: %s)",
    async (send) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      mountComposer(_fixture, THREAD_A);
      await show(_fixture, THREAD_A);
      await record(_fixture);
      const { done } = await stop(_fixture, send);
      unmountComposer(_fixture, THREAD_A);
      const b = mountComposer(_fixture, THREAD_B);
      await show(_fixture, THREAD_B);

      expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
      expect(_fixture.control.phase).toBe("idle");
      await transcribe(done);
      await act(() => nextFrame(_fixture));

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, true);
    expect(_fixture.control.phase).toBe("transcribing");
    await transcribe(done);
    expect(a.insert).toHaveBeenCalledExactlyOnceWith("dictated words");
    expect(a.submit).not.toHaveBeenCalled();
    await act(() => nextFrame(_fixture));
    expect(a.submit).toHaveBeenCalledOnce();
    expect(_fixture.control.phase).toBe("idle");
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("a question arriving before completion keeps the text in the ordinary draft, unsent", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, true);
    a.accepts = false;
    await transcribe(done);
    await act(() => nextFrame(_fixture));
    expect(a.insert).not.toHaveBeenCalled();
    expect(a.submit).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
  });

  it("navigating away between insertion and the scheduled submit does not send", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, true);
    await transcribe(done);
    expect(a.insert).toHaveBeenCalledOnce();
    unmountComposer(_fixture, THREAD_A);
    await act(() => nextFrame(_fixture));
    expect(a.submit).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      description: "Message not sent.",
    });
  });

  it("A → B → A shows A's job again and can cancel exactly its request", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    const requestId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    unmountComposer(_fixture, THREAD_A);
    mountComposer(_fixture, THREAD_B);
    await show(_fixture, THREAD_B);
    expect(_fixture.control.phase).toBe("idle");
    unmountComposer(_fixture, THREAD_B);
    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    expect(_fixture.control.phase).toBe("transcribing");

    await act(() => _fixture.control.cancel());
    expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({ requestId });
    await transcribe(done);
    expect(storedPrompt(THREAD_A)).toBe("");
    expect(_fixture.composers.get(composerTargetKey(THREAD_A))!.insert).not.toHaveBeenCalled();
  });

  it("the same thread id in another environment neither shows nor receives the job", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    unmountComposer(_fixture, THREAD_A);
    const remote = mountComposer(_fixture, THREAD_A_REMOTE);
    await show(_fixture, THREAD_A_REMOTE);
    expect(_fixture.control.phase).toBe("idle");
    await transcribe(done);
    expect(remote.insert).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A_REMOTE)).toBe("");
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
  });

  it("leaving during correction keeps correcting and delivers once", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    await act(async () => {
      pending.resolve({ text: "orignal words", engine: "local" });
    });
    expect(_fixture.control.phase).toBe("correcting");
    unmountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_B);
    const signal = vi.mocked(correctionClient.correct).mock.calls[0]![0].signal;
    expect(signal.aborted).toBe(false);
    await act(async () => {
      correction.resolve({ text: "original words", provider: "codex" } as never);
      await done;
    });
    expect(storedPrompt(THREAD_A)).toBe("original words");
  });

  it("Use original after returning completes once and ignores the late correction", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    await act(async () => {
      pending.resolve({ text: "local words", engine: "local" });
    });
    await show(_fixture, THREAD_B);
    await show(_fixture, THREAD_A);
    expect(_fixture.control.phase).toBe("correcting");
    await act(() => _fixture.control.useOriginal());
    expect(a.insert).toHaveBeenCalledExactlyOnceWith("local words");
    await act(async () => {
      correction.resolve({ text: "late words", provider: "codex" } as never);
      await done;
    });
    expect(a.insert).toHaveBeenCalledOnce();
  });

  it("a failure while away becomes a notice instead of a stale control error", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    unmountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_B);
    await act(async () => {
      pending.reject(new Error("Engine failed"));
      await done;
    });
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Voice transcription failed",
      description: "Engine failed",
    });
    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    expect(_fixture.control.errorMessage).toBeNull();
  });

  it("a failure on the visible origin shows in its control", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    await act(async () => {
      pending.reject(new Error("Engine failed"));
      await done;
    });
    expect(_fixture.control.errorMessage).toBe("Engine failed");
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("ownership is committed at the click, before the final audio flush resolves", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const flush = deferred<{ base64: string; sampleRateHz: number; durationMs: number }>();
    recorder.stop.mockImplementationOnce(() => flush.promise);
    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    unmountComposer(_fixture, THREAD_A);
    const b = mountComposer(_fixture, THREAD_B);
    await show(_fixture, THREAD_B);
    expect(client.transcribe).not.toHaveBeenCalled();
    await act(async () => {
      flush.resolve({ base64: "synthetic", sampleRateHz: 24000, durationMs: 1000 });
    });
    expect(client.transcribe).toHaveBeenCalledOnce();
    await transcribe(done);
    expect(storedPrompt(THREAD_A)).toBe("dictated words");
    expect(b.insert).not.toHaveBeenCalled();
  });

  it("the stop click fixes the job and its origin before the flush resolves", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const flush = deferred<{ base64: string; sampleRateHz: number; durationMs: number }>();
    recorder.stop.mockImplementationOnce(() => flush.promise);
    mountComposer(_fixture, THREAD_A);
    // One control whose origin changes right after the click, before the flush.
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} key="same" origin={originFor(THREAD_A)} />,
        ),
    );
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    expect(_fixture.control.phase).toBe("transcribing");
    const b = mountComposer(_fixture, THREAD_B);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} key="same" origin={originFor(THREAD_B)} />,
        ),
    );
    expect(_fixture.control.phase).toBe("idle");
    await act(async () => {
      flush.resolve({ base64: "synthetic", sampleRateHz: 24000, durationMs: 1000 });
    });
    await transcribe(done);
    expect(storedPrompt(THREAD_B)).toBe("");
    expect(b.insert).not.toHaveBeenCalled();
    expect(
      _fixture.composers.get(composerTargetKey(THREAD_A))!.insert,
    ).toHaveBeenCalledExactlyOnceWith("dictated words");
  });

  it("A → B during correction with Send saves to A and sends nothing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const correction = deferred<VoiceTranscriptCorrectionResult>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, true);
    await act(async () => {
      pending.resolve({ text: "local words", engine: "local" });
    });
    expect(_fixture.control.phase).toBe("correcting");
    unmountComposer(_fixture, THREAD_A);
    const b = mountComposer(_fixture, THREAD_B);
    await show(_fixture, THREAD_B);
    await act(async () => {
      correction.resolve({ text: "corrected words", provider: "codex" } as never);
      await done;
    });
    await act(() => nextFrame(_fixture));
    expect(storedPrompt(THREAD_A)).toBe("corrected words");
    expect(a.submit).not.toHaveBeenCalled();
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.submit).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add).mock.calls[0]![0]).toMatchObject({
      description: "Message not sent.",
    });
  });

  it("staying on A whose composer cannot send right now inserts and says not sent", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const a = mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    const { done } = await stop(_fixture, true);
    a.ready = false;
    await transcribe(done);
    await act(() => nextFrame(_fixture));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} origin={null} field="request-1:question-1" />,
        ),
    );
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    const requestId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    await act(
      async () =>
        await _fixture.root0.rerender(<Probe _fixture={_fixture} origin={null} field={next} />),
    );
    expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({ requestId });
    await transcribe(done);
    expect(local).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A)).toBe("");
  });

  it.each([
    ["another question", "request-1:question-2"],
    ["no question", null],
  ])("a live answer recording is cancelled when the field changes to %s", async (_label, next) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} origin={null} field="request-1:question-1" />,
        ),
    );
    await record(_fixture);
    expect(_fixture.control.phase).toBe("recording");
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe
            _fixture={_fixture}
            origin={next === null ? originFor(THREAD_A) : null}
            field={next}
          />,
        ),
    );
    expect(recorder.cancel).toHaveBeenCalled();
    expect(_fixture.control.phase).toBe("idle");
    const { done } = await stop(_fixture, true);
    await transcribe(done);
    expect(client.transcribe).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(storedPrompt(THREAD_A)).toBe("");
  });

  it("a live draft recording is cancelled when a question takes over the composer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe
            _fixture={_fixture}
            key={composerTargetKey(THREAD_A)}
            origin={null}
            field="request-1:question-1"
          />,
        ),
    );
    expect(recorder.cancel).toHaveBeenCalled();
    expect(_fixture.control.phase).toBe("idle");
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it("re-rendering with the same destination keeps the recording", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    await show(_fixture, THREAD_A);
    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(_fixture.control.phase).toBe("recording");
  });

  it("answer dictation is delivered to its own unchanged field", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <Probe _fixture={_fixture} origin={null} field="request-1:question-1" />,
        ),
    );
    await record(_fixture);
    const { done } = await stop(_fixture, false);
    await transcribe(done);
    expect(local).toHaveBeenCalledExactlyOnceWith("dictated words");
    expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
  });

  it("leaving while still recording cancels and keeps nothing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_A);
    await record(_fixture);
    expect(_fixture.control.phase).toBe("recording");
    unmountComposer(_fixture, THREAD_A);
    await show(_fixture, THREAD_B);
    expect(recorder.cancel).toHaveBeenCalled();
    expect(client.transcribe).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const frames: Array<FrameRequestCallback> = [];
  let control: ScientVoiceController;
  const composers = new Map<string, VoiceDraftEndpoint & { accepts: boolean; ready: boolean }>();
  const unregister = new Map<string, () => void>();
  return {
    get frames() {
      return frames;
    },
    get control() {
      return control;
    },
    publishControl(value: ScientVoiceController) {
      control = value;
    },
    get composers() {
      return composers;
    },
    get unregister() {
      return unregister;
    },

    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
