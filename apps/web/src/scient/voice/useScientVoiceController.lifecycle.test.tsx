// @vitest-environment happy-dom
import {
  EnvironmentId,
  type DesktopVoiceBridge,
  type VoiceModelsSnapshot,
  type VoiceTranscript,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { UseVoiceRecorderOptions } from "./useVoiceRecorder.ts";
import type { VoiceTranscriptCorrectionClient } from "./voiceTranscriptCorrectionClient.ts";

const recorder = vi.hoisted(() => ({
  start: vi.fn(async () => true),
  stop: vi.fn(async () => ({ base64: "synthetic", sampleRateHz: 24000, durationMs: 1000 })),
  cancel: vi.fn(async () => {}),
  status: "idle" as const,
  errorKind: null,
  levels: [],
}));
const callbacks = vi.hoisted(() => ({ current: undefined as UseVoiceRecorderOptions | undefined }));
const analytics = vi.hoisted(() => vi.fn());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
vi.mock("./useVoiceRecorder.ts", () => ({
  useVoiceRecorder: (options: UseVoiceRecorderOptions) => {
    callbacks.current = options;
    return recorder;
  },
}));
vi.mock("../analytics/client.ts", () => ({ useRecordScientAnalytics: () => analytics }));
import {
  useScientVoiceController,
  type ScientVoiceController,
} from "./useScientVoiceController.ts";

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

describe("voice operation ownership", () => {
  let root: Root;
  let client: DesktopVoiceBridge;
  let pending: ReturnType<typeof deferred<VoiceTranscript>>;
  let controls: Map<string, ScientVoiceController>;
  let delivered = vi.fn<(owner: string, text: string) => void>();
  let correctionClient: VoiceTranscriptCorrectionClient | undefined;
  let now: number;
  function Probe({ owner }: { owner: string }) {
    const control = useScientVoiceController({
      client,
      onTranscript: (text) => delivered(owner, text),
      environmentId: EnvironmentId.make("test"),
      correctionEnabled: !!correctionClient,
      ...(correctionClient ? { correctionClient } : {}),
    });
    useLayoutEffect(() => {
      controls.set(owner, control);
    });
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    callbacks.current = undefined;
    correctionClient = undefined;
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    pending = deferred<VoiceTranscript>();
    controls = new Map();
    delivered = vi.fn();
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const control = (owner = "owner") => controls.get(owner)!;
  async function start(owner = "owner") {
    await act(() => control(owner).activate());
    now += 300;
  }
  async function stop(owner = "owner") {
    let completion!: Promise<void>;
    await act(async () => {
      completion = control(owner).stop(false);
    });
    return { completion };
  }
  async function finish(completion: Promise<void>, text = "dictation") {
    await act(async () => {
      pending.resolve({ text, engine: "local" });
      await completion;
    });
  }

  it.each(["composer", "comment"])(
    "unmounting an idle control preserves the %s result",
    async (owner) => {
      await act(() =>
        root.render(
          <>
            <Probe key="owner" owner={owner} />
            <Probe key="idle" owner="idle" />
          </>,
        ),
      );
      await start(owner);
      const { completion } = await stop(owner);
      await act(() =>
        root.render(
          <>
            <Probe key="owner" owner={owner} />
          </>,
        ),
      );
      expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
      expect(client.cancelTranscription).not.toHaveBeenCalled();
      await finish(completion);
      expect(delivered).toHaveBeenCalledWith(owner, "dictation");
    },
  );

  it.each(["cancel", "unmount"])(
    "%s cancels only its immutable request and ignores late results",
    async (action) => {
      await act(() => root.render(<Probe owner="owner" />));
      await start();
      const { completion } = await stop();
      const request = vi.mocked(client.transcribe).mock.calls[0]![0];
      expect(request.requestId).toBeTruthy();
      await act(() => (action === "cancel" ? control().cancel() : root.render(null)));
      expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({
        requestId: request.requestId,
      });
      expect(client.cancelTranscription).not.toHaveBeenCalled();
      await finish(completion);
      expect(delivered).not.toHaveBeenCalled();
    },
  );

  it("never sends unsafe global cancellation to an older host", async () => {
    delete client.cancelTranscriptionRequest;
    await act(() => root.render(<Probe owner="owner" />));
    await start();
    const { completion } = await stop();
    await act(() => control().cancel());
    await finish(completion);
    expect(client.cancelTranscription).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it("does not cancel completed host work while correcting", async () => {
    const correction = deferred<never>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    await act(() => root.render(<Probe owner="owner" />));
    await start();
    await stop();
    await act(() => {
      pending.resolve({ text: "original", engine: "local" });
    });
    expect(control().phase).toBe("correcting");
    await act(() => root.render(null));
    expect(vi.mocked(correctionClient.correct).mock.calls[0]![0].signal.aborted).toBe(true);
    expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
    await act(() => correction.reject(new Error("cancelled")));
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount"])("ignores automatic-stop delivery after %s", async (action) => {
    await act(() => root.render(<Probe owner="owner" />));
    await start();
    const autoStop = callbacks.current!.onAutoStop!;
    await act(() => (action === "cancel" ? control().cancel() : root.render(null)));
    await act(() =>
      autoStop({
        base64: "synthetic",
        wavBytes: new Uint8Array(),
        sampleRateHz: 24000,
        durationMs: 180000,
      }),
    );
    expect(client.transcribe).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it("late completion of a cancelled request cannot clear ownership of a replacement", async () => {
    await act(() => root.render(<Probe owner="owner" />));
    await start();
    const first = await stop();
    const oldPending = pending;
    const firstId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    await act(() => control().cancel());
    pending = deferred<VoiceTranscript>();
    await start();
    const second = await stop();
    const secondId = vi.mocked(client.transcribe).mock.calls[1]![0].requestId;
    expect(secondId).not.toBe(firstId);
    await act(async () => {
      oldPending.resolve({ text: "stale", engine: "local" });
      await first.completion;
    });
    await act(() => control().cancel());
    expect(client.cancelTranscriptionRequest).toHaveBeenLastCalledWith({ requestId: secondId });
    await finish(second.completion);
    expect(delivered).not.toHaveBeenCalled();
  });
});
