// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  let root: Root;
  let recorder: VoiceRecorderControls;
  const onAutoStop = vi.fn();
  function Probe() {
    const value = useVoiceRecorder({ onAutoStop });
    useLayoutEffect(() => {
      recorder = value;
    });
    return null;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    root = createRoot(document.createElement("div"));
    await act(() => root.render(<Probe />));
    await act(() => recorder.start());
    await act(() => FakeWorklet.current.samples());
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers one clip after the maximum duration and final-frame flush", async () => {
    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 500));
    expect(onAutoStop).toHaveBeenCalledOnce();
    expect(onAutoStop.mock.calls[0]?.[0]?.durationMs).toBe(10);
    expect(media.stop).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "unmount"])(
    "does not deliver a clip when %s wins during the final flush",
    async (action) => {
      await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS));
      expect(FakeWorklet.current.port.postMessage).toHaveBeenCalledWith({
        type: "flush",
        requestId: 1,
      });
      expect(onAutoStop).not.toHaveBeenCalled();
      let cancellation: Promise<void> | undefined;
      await act(async () => {
        if (action === "cancel") cancellation = recorder.cancel();
        else root.render(null);
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
    let stopping!: ReturnType<VoiceRecorderControls["stop"]>;
    await act(async () => {
      stopping = recorder.stop();
    });
    await act(async () => {
      root.render(null);
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
    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS));
    let cancellation!: Promise<void>;
    await act(async () => {
      cancellation = recorder.cancel();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await cancellation;
    });
    await act(() => recorder.start());
    await act(() => FakeWorklet.current.samples());
    await act(() => vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 500));
    expect(onAutoStop).toHaveBeenCalledOnce();
  });

  it("publishes fresh speech before the full history fills", async () => {
    await act(async () => {
      for (let index = 0; index < 32; index += 1) FakeWorklet.current.samples(0);
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      FakeWorklet.current.samples(0.2);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(recorder.levels.at(-1)).toBe(0.2);
    expect(buildVoiceWaveformLevels(recorder.levels).slice(-32).at(-1)).toBe(0.2);
    expect(recorder.levels.length).toBeLessThan(VOICE_WAVEFORM_LEVEL_COUNT);
  });

  it("keeps visualization bounded through a three-minute clip without dropping audio", async () => {
    await act(() => recorder.cancel());
    await act(() => recorder.start());
    for (let batch = 0; batch < 33; batch += 1) {
      await act(async () => {
        const count = Math.min(64, 2_109 - batch * 64);
        for (let index = 0; index < count; index += 1) {
          FakeWorklet.current.samples((batch + 1) / 100, 2_048);
        }
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(recorder.levels.length).toBeLessThanOrEqual(112);
      expect(recorder.levels.at(-1)).toBe((batch + 1) / 100);
    }
    await act(async () => {
      FakeWorklet.current.samples(0.4, 768);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(recorder.levels).toHaveLength(112);
    expect(buildVoiceWaveformLevels(recorder.levels).at(-1)).toBe(0.4);
    let stopping!: ReturnType<VoiceRecorderControls["stop"]>;
    await act(async () => {
      stopping = recorder.stop();
      await vi.advanceTimersByTimeAsync(500);
      await stopping;
    });
    const clip = await stopping;
    expect(clip?.durationMs).toBe(MAX_RECORDING_MS);
    expect(clip?.wavBytes.length).toBe(44 + 180 * 24_000 * 2);
    expect(recorder.levels).toEqual([]);
  });

  it("clears queued waveform updates across repeated cancel and restart cycles", async () => {
    for (let cycle = 0; cycle < 12; cycle += 1) {
      await act(async () => {
        FakeWorklet.current.samples(0.2);
        await recorder.cancel();
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(recorder.levels).toEqual([]);
      expect(recorder.status).toBe("idle");
      await act(() => recorder.start());
    }
  });
});
