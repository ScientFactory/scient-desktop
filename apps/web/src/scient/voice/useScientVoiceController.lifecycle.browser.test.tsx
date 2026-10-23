import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  type DesktopVoiceBridge,
  type VoiceModelsSnapshot,
  type VoiceTranscript,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
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
  let client: DesktopVoiceBridge;
  let pending: ReturnType<typeof deferred<VoiceTranscript>>;

  let delivered = vi.fn<(owner: string, text: string) => void>();
  let correctionClient: VoiceTranscriptCorrectionClient | undefined;
  let now: number;
  function Probe({ _fixture, owner }: { owner: string } & { _fixture: _Fixture }) {
    const control = useScientVoiceController({
      client,
      onTranscript: (text) => delivered(owner, text),
      environmentId: EnvironmentId.make("test"),
      correctionEnabled: !!correctionClient,
      ...(correctionClient ? { correctionClient } : {}),
    });
    useLayoutEffect(() => {
      _fixture.publishControl(owner, control);
    });
    return null;
  }
  async function _setupFixture0(_fixture: _Fixture) {
    vi.clearAllMocks();
    callbacks.current = undefined;
    _fixture.stack.defer(() => {
      callbacks.current = undefined;
    });
    correctionClient = undefined;
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    pending = deferred<VoiceTranscript>();
    _fixture.resetControls();
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
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  const control = (_fixture: _Fixture, owner = "owner") => _fixture.controls.get(owner)!;
  async function start(_fixture: _Fixture, owner = "owner") {
    await act(() => control(_fixture, owner).activate());
    now += 300;
  }
  async function stop(_fixture: _Fixture, owner = "owner") {
    let completion!: Promise<void>;
    await act(async () => {
      completion = control(_fixture, owner).stop(false);
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await act(
        async () =>
          await _fixture.root0.rerender(
            <>
              <Probe _fixture={_fixture} key="owner" owner={owner} />
              <Probe _fixture={_fixture} key="idle" owner="idle" />
            </>,
          ),
      );
      await start(_fixture, owner);
      const { completion } = await stop(_fixture, owner);
      await act(
        async () =>
          await _fixture.root0.rerender(
            <>
              <Probe _fixture={_fixture} key="owner" owner={owner} />
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await act(
        async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} owner="owner" />),
      );
      await start(_fixture);
      const { completion } = await stop(_fixture);
      const request = vi.mocked(client.transcribe).mock.calls[0]![0];
      expect(request.requestId).toBeTruthy();
      await act(async () =>
        action === "cancel" ? control(_fixture).cancel() : await _fixture.root0.rerender(null),
      );
      expect(client.cancelTranscriptionRequest).toHaveBeenCalledExactlyOnceWith({
        requestId: request.requestId,
      });
      expect(client.cancelTranscription).not.toHaveBeenCalled();
      await finish(completion);
      expect(delivered).not.toHaveBeenCalled();
    },
  );

  it("never sends unsafe global cancellation to an older host", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    delete client.cancelTranscriptionRequest;
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} owner="owner" />),
    );
    await start(_fixture);
    const { completion } = await stop(_fixture);
    await act(() => control(_fixture).cancel());
    await finish(completion);
    expect(client.cancelTranscription).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it("does not cancel completed host work while correcting", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const correction = deferred<never>();
    correctionClient = { correct: vi.fn(() => correction.promise) };
    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} owner="owner" />),
    );
    await start(_fixture);
    await stop(_fixture);
    await act(() => {
      pending.resolve({ text: "original", engine: "local" });
    });
    expect(control(_fixture).phase).toBe("correcting");
    await act(async () => await _fixture.root0.rerender(null));
    expect(vi.mocked(correctionClient.correct).mock.calls[0]![0].signal.aborted).toBe(true);
    expect(client.cancelTranscriptionRequest).not.toHaveBeenCalled();
    await act(() => correction.reject(new Error("cancelled")));
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount"])("ignores automatic-stop delivery after %s", async (action) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} owner="owner" />),
    );
    await start(_fixture);
    const autoStop = callbacks.current!.onAutoStop!;
    await act(async () =>
      action === "cancel" ? control(_fixture).cancel() : await _fixture.root0.rerender(null),
    );
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} owner="owner" />),
    );
    await start(_fixture);
    const first = await stop(_fixture);
    const oldPending = pending;
    const firstId = vi.mocked(client.transcribe).mock.calls[0]![0].requestId;
    await act(() => control(_fixture).cancel());
    pending = deferred<VoiceTranscript>();
    await start(_fixture);
    const second = await stop(_fixture);
    const secondId = vi.mocked(client.transcribe).mock.calls[1]![0].requestId;
    expect(secondId).not.toBe(firstId);
    await act(async () => {
      oldPending.resolve({ text: "stale", engine: "local" });
      await first.completion;
    });
    await act(() => control(_fixture).cancel());
    expect(client.cancelTranscriptionRequest).toHaveBeenLastCalledWith({ requestId: secondId });
    await finish(second.completion);
    expect(delivered).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const controls = new Map<string, ScientVoiceController>();

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get controls() {
      return controls;
    },
    resetControls() {
      controls.clear();
    },
    publishControl(owner: string, control: ScientVoiceController) {
      controls.set(owner, control);
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
