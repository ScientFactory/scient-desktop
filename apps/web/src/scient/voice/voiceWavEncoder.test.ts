import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { VOICE_CLIP_SAMPLE_RATE_HZ, computeRms, encodeWavClip } from "./voiceWavEncoder.ts";

function readAscii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("computeRms", () => {
  it("is 0 for an empty frame", () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it("is the constant amplitude for a DC frame", () => {
    expect(computeRms(new Float32Array([1, 1, 1, 1]))).toBeCloseTo(1);
  });

  it("computes root-mean-square for a symmetric frame", () => {
    // sqrt((0.5^2 + 0.5^2) / 2) = 0.5
    expect(computeRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe("encodeWavClip WAV header", () => {
  const clip = encodeWavClip(
    [new Float32Array(VOICE_CLIP_SAMPLE_RATE_HZ)],
    VOICE_CLIP_SAMPLE_RATE_HZ,
  );
  const view = viewOf(clip.wavBytes);
  const dataSize = VOICE_CLIP_SAMPLE_RATE_HZ * 2; // 16-bit mono

  it("emits a 44-byte header plus 16-bit PCM data", () => {
    expect(clip.wavBytes.length).toBe(44 + dataSize);
  });

  it("has the standard RIFF/WAVE/fmt/data tags", () => {
    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(readAscii(view, 36, 4)).toBe("data");
  });

  it("declares PCM mono 24 kHz 16-bit with correct derived fields", () => {
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // audio format = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(VOICE_CLIP_SAMPLE_RATE_HZ);
    expect(view.getUint32(28, true)).toBe(VOICE_CLIP_SAMPLE_RATE_HZ * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(dataSize);
  });

  it("reports the target sample rate and a 1000 ms duration", () => {
    expect(clip.sampleRateHz).toBe(VOICE_CLIP_SAMPLE_RATE_HZ);
    expect(clip.durationMs).toBe(1000);
  });
});

describe("encodeWavClip resampling", () => {
  it("halves the sample count when downsampling 48 kHz → 24 kHz", () => {
    const input = new Float32Array(48_000);
    const clip = encodeWavClip([input], 48_000);
    const sampleCount = (clip.wavBytes.length - 44) / 2;
    expect(sampleCount).toBe(24_000);
    expect(clip.durationMs).toBe(1000);
  });

  it("concatenates multiple frames before resampling", () => {
    const clip = encodeWavClip(
      [new Float32Array(12_000), new Float32Array(12_000)],
      VOICE_CLIP_SAMPLE_RATE_HZ,
    );
    const sampleCount = (clip.wavBytes.length - 44) / 2;
    expect(sampleCount).toBe(24_000);
  });

  it("produces an empty-data clip for no frames", () => {
    const clip = encodeWavClip([], 48_000);
    expect(clip.wavBytes.length).toBe(44);
    expect(clip.durationMs).toBe(0);
  });
});

describe("encodeWavClip base64", () => {
  it("round-trips the WAV bytes through base64", () => {
    const clip = encodeWavClip(
      [new Float32Array([0, 0.5, -0.5, 1, -1])],
      VOICE_CLIP_SAMPLE_RATE_HZ,
    );
    const decoded = Result.getOrThrow(Encoding.decodeBase64(clip.base64));
    expect(Array.from(decoded)).toEqual(Array.from(clip.wavBytes));
  });

  it("quantises full-scale samples to the 16-bit PCM range", () => {
    const clip = encodeWavClip([new Float32Array([1, -1])], VOICE_CLIP_SAMPLE_RATE_HZ);
    const view = viewOf(clip.wavBytes);
    expect(view.getInt16(44, true)).toBe(0x7fff); // +1.0 → max positive
    expect(view.getInt16(46, true)).toBe(-0x8000); // -1.0 → max negative
  });
});
