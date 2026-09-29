// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_RECORDING_MS,
  useVoiceRecorder,
  type VoiceRecorderControls,
} from "./useVoiceRecorder.ts";

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
  samples() {
    this.events.dispatchEvent(
      new MessageEvent("message", { data: { samples: new Float32Array(240), rms: 0.1 } }),
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
});
