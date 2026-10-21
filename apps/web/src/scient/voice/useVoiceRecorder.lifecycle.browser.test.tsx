import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_RECORDING_MS,
  useVoiceRecorder,
  type VoiceRecorderControls,
} from "./useVoiceRecorder.ts";
import { buildVoiceWaveformLevels, VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";

const media = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("./voiceMedia.ts", () => ({
  acquireCurrentMicrophone: async () => ({ getTracks: () => [{ stop: media.stop }] }),
}));

class FakeWorklet {
  static current: FakeWorklet;
  readonly events = new EventTarget();
  readonly port = {
    addEventListener: this.events.addEventListener.bind(this.events),
    removeEventListener: this.events.removeEventListener.bind(this.events),
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    FakeWorklet.current = this;
  }
  samples(rms = 0.1, sampleCount = 240) {
    this.events.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "samples", samples: new Float32Array(sampleCount), rms },
      }),
    );
  }
}
class FakeAudioContext {
  state = "running";
  sampleRate = 24000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  createGain = () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() });
  close = async () => {
    this.state = "closed";
  };
}

describe("automatic recording finalization", () => {
  const onAutoStop = vi.fn();
  function Probe({ _fixture }: { _fixture: _Fixture }) {
    const value = useVoiceRecorder({ onAutoStop });
    useLayoutEffect(() => {
      _fixture.publishRecorder(value);
    });
    return null;
  }
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
    vi.clearAllMocks();

    _fixture.stack.use(_fixtureStubGlobal("AudioContext", FakeAudioContext));
    _fixture.stack.use(_fixtureStubGlobal("AudioWorkletNode", FakeWorklet));
    _fixture.stack.use(
      _fixtureStubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } }),
    );
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
    await act(() => _fixture.recorder.start());
    await act(() => FakeWorklet.current.samples());
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  it("delivers one clip after the maximum duration and final-frame flush", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 500));
    expect(onAutoStop).toHaveBeenCalledOnce();
    expect(onAutoStop.mock.calls[0]?.[0]?.durationMs).toBe(10);
    expect(media.stop).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "unmount"])(
    "does not deliver a clip when %s wins during the final flush",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS));
      expect(FakeWorklet.current.port.postMessage).toHaveBeenCalledWith({
        type: "flush",
        requestId: 1,
      });
      expect(onAutoStop).not.toHaveBeenCalled();
      let cancellation: Promise<void> | undefined;
      await act(async () => {
        if (action === "cancel") cancellation = _fixture.recorder.cancel();
        else await _fixture.root0.rerender(null);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await cancellation;
      });
      expect(onAutoStop).not.toHaveBeenCalled();
      expect(media.stop).toHaveBeenCalled();
    },
  );

  it("an explicit stop keeps its final frame when the control unmounts during the flush", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let stopping!: ReturnType<VoiceRecorderControls["stop"]>;
    await act(async () => {
      stopping = _fixture.recorder.stop();
    });
    await act(async () => {
      await _fixture.root0.rerender(null);
    });
    expect(media.stop).not.toHaveBeenCalled();
    await act(async () => {
      FakeWorklet.current.samples(0.1, 120);
      FakeWorklet.current.events.dispatchEvent(
        new MessageEvent("message", { data: { type: "flushed", requestId: 1 } }),
      );
    });
    const clip = await stopping;
    expect(clip?.durationMs).toBe(15);
    expect(media.stop).toHaveBeenCalledOnce();
  });

  it("allows a new recording after cancelling a pending automatic stop", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS));
    let cancellation!: Promise<void>;
    await act(async () => {
      cancellation = _fixture.recorder.cancel();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await cancellation;
    });
    await act(() => _fixture.recorder.start());
    await act(() => FakeWorklet.current.samples());
    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 500));
    expect(onAutoStop).toHaveBeenCalledOnce();
  });

  it("publishes fresh speech before the full history fills", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => {
      for (let index = 0; index < 32; index += 1) FakeWorklet.current.samples(0);
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      FakeWorklet.current.samples(0.2);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(_fixture.recorder.levels.at(-1)).toBe(0.2);
    expect(buildVoiceWaveformLevels(_fixture.recorder.levels).slice(-32).at(-1)).toBe(0.2);
    expect(_fixture.recorder.levels.length).toBeLessThan(VOICE_WAVEFORM_LEVEL_COUNT);
  });

  it("keeps visualization bounded through a three-minute clip without dropping audio", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(() => _fixture.recorder.cancel());
    await act(() => _fixture.recorder.start());
    for (let batch = 0; batch < 33; batch += 1) {
      await act(async () => {
        const count = Math.min(64, 2_109 - batch * 64);
        for (let index = 0; index < count; index += 1) {
          FakeWorklet.current.samples((batch + 1) / 100, 2_048);
        }
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(_fixture.recorder.levels.length).toBeLessThanOrEqual(112);
      expect(_fixture.recorder.levels.at(-1)).toBe((batch + 1) / 100);
    }
    await act(async () => {
      FakeWorklet.current.samples(0.4, 768);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(_fixture.recorder.levels).toHaveLength(112);
    expect(buildVoiceWaveformLevels(_fixture.recorder.levels).at(-1)).toBe(0.4);
    let stopping!: ReturnType<VoiceRecorderControls["stop"]>;
    await act(async () => {
      stopping = _fixture.recorder.stop();
      await vi.advanceTimersByTimeAsync(500);
      await stopping;
    });
    const clip = await stopping;
    expect(clip?.durationMs).toBe(MAX_RECORDING_MS);
    expect(clip?.wavBytes.length).toBe(44 + 180 * 24_000 * 2);
    expect(_fixture.recorder.levels).toEqual([]);
  });

  it("clears queued waveform updates across repeated cancel and restart cycles", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    for (let cycle = 0; cycle < 12; cycle += 1) {
      await act(async () => {
        FakeWorklet.current.samples(0.2);
        await _fixture.recorder.cancel();
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(_fixture.recorder.levels).toEqual([]);
      expect(_fixture.recorder.status).toBe("idle");
      await act(() => _fixture.recorder.start());
    }
  });
});

function _createFixture() {
  let _published_recorder = undefined! as VoiceRecorderControls;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get recorder() {
      return _published_recorder;
    },
    publishRecorder(next: typeof _published_recorder) {
      _published_recorder = next;
      return next;
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
