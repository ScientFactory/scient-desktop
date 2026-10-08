// @effect-diagnostics nodeBuiltinImport:off - Node-only test harness reads the static worklet fixture for VM execution.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";
import {
  VOICE_WORKLET_PROCESSOR_NAME,
  type VoiceWorkletFlushCommand,
  type VoiceWorkletMessage,
} from "./voiceWorkletProcessor.ts";

const source = NodeFS.readFileSync(
  new URL("../../../public/scient-voice-worklet.js", import.meta.url),
  "utf8",
);

function createProcessor(sampleRate: number) {
  const messages: VoiceWorkletMessage[] = [];
  class AudioWorkletProcessor {
    port = {
      onmessage: (_event: { data: VoiceWorkletFlushCommand }) => {},
      postMessage: (message: VoiceWorkletMessage) => messages.push(message),
    };
  }
  interface Processor extends AudioWorkletProcessor {
    process(inputs: Float32Array[][]): boolean;
  }
  const registered: { create?: () => Processor } = {};
  NodeVM.runInNewContext(source, {
    sampleRate,
    Float32Array,
    AudioWorkletProcessor,
    registerProcessor: (name: string, constructor: new () => Processor) => {
      expect(name).toBe(VOICE_WORKLET_PROCESSOR_NAME);
      registered.create = () => new constructor();
    },
  });
  if (!registered.create) throw new Error("Worklet did not register");
  const processor = registered.create();
  return {
    processor,
    messages,
    flush: (requestId: number) => processor.port.onmessage({ data: { type: "flush", requestId } }),
  };
}

describe("progressive voice worklet capture", () => {
  it.each([24_000, 44_100, 48_000])(
    "fills 112 real measurements in about two seconds at %i Hz",
    (rate) => {
      const { processor, messages } = createProcessor(rate);
      let filledAt = 0;
      for (let offset = 0; offset < rate * 2.1; offset += 128) {
        processor.process([[new Float32Array(128).fill(0.125)]]);
        if (filledAt === 0 && messages.length >= VOICE_WAVEFORM_LEVEL_COUNT) {
          filledAt = (offset + 128) / rate;
        }
      }
      expect(filledAt).toBeGreaterThan(1.98);
      expect(filledAt).toBeLessThan(2.02);
      for (const message of messages) {
        expect(message.type).toBe("samples");
        if (message.type === "samples") expect(message.rms).toBeCloseTo(0.125);
      }
    },
  );

  it("preserves every sample through three minutes of faster updates and final flush", () => {
    const { processor, messages, flush } = createProcessor(24_000);
    const original = Float32Array.from(
      { length: 24_000 * 180 + 73 },
      (_, index) => (index % 31) / 31 - 0.5,
    );
    for (let offset = 0; offset < original.length; offset += 128) {
      processor.process([[original.subarray(offset, offset + 128)]]);
    }
    flush(1);
    const captured = new Float32Array(original.length);
    let length = 0;
    let frames = 0;
    for (const message of messages) {
      if (message.type !== "samples") continue;
      captured.set(message.samples, length);
      length += message.samples.length;
      frames += 1;
      expect(Number.isFinite(message.rms)).toBe(true);
    }
    expect(frames).toBeGreaterThan(10_000);
    expect(length).toBe(original.length);
    expect(Buffer.from(captured.buffer).equals(Buffer.from(original.buffer))).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "flushed", requestId: 1 });
    const before = messages.length;
    flush(2);
    expect(messages).toHaveLength(before + 1);
    expect(messages.at(-1)).toEqual({ type: "flushed", requestId: 2 });
  });

  it("does not invent samples when the input is absent or silent", () => {
    const { processor, messages, flush } = createProcessor(24_000);
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(messages).toEqual([]);
    processor.process([[new Float32Array(17)]]);
    flush(3);
    expect(messages[0]).toMatchObject({ type: "samples", rms: 0, samples: new Float32Array(17) });
    expect(messages[1]).toEqual({ type: "flushed", requestId: 3 });
  });
});
