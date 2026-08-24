import * as NodeBuffer from "node:buffer";

import { describe, expect, it } from "vite-plus/test";

import { VoiceTranscriptionError } from "./errors.ts";
import {
  isValidWav,
  MAX_AUDIO_BYTES,
  MAX_DURATION_MS,
  normalizeVoiceClip,
  TARGET_SAMPLE_RATE_HZ,
} from "./wavClip.ts";

/** Build a canonical WAV with `dataBytes` of PCM payload. */
function wavBuffer(options: { sampleRateHz?: number; dataBytes?: number } = {}): NodeBuffer.Buffer {
  const sampleRateHz = options.sampleRateHz ?? TARGET_SAMPLE_RATE_HZ;
  const dataBytes = options.dataBytes ?? 2;
  const bytes = NodeBuffer.Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); // bits per sample
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function wavBase64(options?: { sampleRateHz?: number; dataBytes?: number }): string {
  return wavBuffer(options).toString("base64");
}

const validRequest = () => ({
  mimeType: "audio/wav",
  sampleRateHz: TARGET_SAMPLE_RATE_HZ,
  durationMs: 1,
  audioBase64: wavBase64(),
});

describe("normalizeVoiceClip", () => {
  it("decodes and normalizes a valid 24 kHz mono PCM WAV", () => {
    const clip = normalizeVoiceClip(validRequest());
    expect(clip.mimeType).toBe("audio/wav");
    expect(clip.sampleRateHz).toBe(TARGET_SAMPLE_RATE_HZ);
    expect(clip.durationMs).toBe(1);
    expect(clip.audioBytes).toBeInstanceOf(Uint8Array);
    expect(clip.audioBytes.byteLength).toBe(46);
  });

  it("accepts a clip at the three-minute boundary within the existing size ceiling", () => {
    const dataBytes = TARGET_SAMPLE_RATE_HZ * 2 * (MAX_DURATION_MS / 1000);
    const clip = normalizeVoiceClip({
      mimeType: "audio/wav",
      sampleRateHz: TARGET_SAMPLE_RATE_HZ,
      durationMs: MAX_DURATION_MS,
      audioBase64: wavBase64({ dataBytes }),
    });
    expect(clip.durationMs).toBe(180_000);
    expect(clip.audioBytes.byteLength).toBe(8_640_044);
    expect(clip.audioBytes.byteLength).toBeLessThan(MAX_AUDIO_BYTES);
  });

  it("rejects a non-object payload", () => {
    expect(() => normalizeVoiceClip(null)).toThrow(VoiceTranscriptionError);
    expect(() => normalizeVoiceClip("string")).toThrow(
      "The voice transcription request is invalid.",
    );
  });

  it("rejects a non-WAV mime type", () => {
    expect(() => normalizeVoiceClip({ ...validRequest(), mimeType: "audio/mp3" })).toThrow(
      "Only WAV audio is supported for voice transcription.",
    );
  });

  it("rejects the wrong sample rate", () => {
    expect(() =>
      normalizeVoiceClip({
        ...validRequest(),
        sampleRateHz: 16_000,
        audioBase64: wavBase64({ sampleRateHz: 16_000 }),
      }),
    ).toThrow("Voice transcription requires 24 kHz mono WAV audio.");
  });

  it("rejects out-of-range durations", () => {
    expect(() => normalizeVoiceClip({ ...validRequest(), durationMs: 0 })).toThrow(
      "Voice messages must be between 1 ms and 180 seconds.",
    );
    expect(() => normalizeVoiceClip({ ...validRequest(), durationMs: 180_001 })).toThrow(
      "Voice messages must be between 1 ms and 180 seconds.",
    );
    expect(() => normalizeVoiceClip({ ...validRequest(), durationMs: 1.5 })).toThrow(
      "Voice messages must be between 1 ms and 180 seconds.",
    );
  });

  it("rejects a claimed duration that does not match the WAV payload", () => {
    expect(() =>
      normalizeVoiceClip({
        ...validRequest(),
        durationMs: 1,
        audioBase64: wavBase64({ dataBytes: TARGET_SAMPLE_RATE_HZ * 2 }),
      }),
    ).toThrow("The recorded audio duration does not match its WAV data.");
  });

  it("rejects payloads that are not valid base64", () => {
    expect(() => normalizeVoiceClip({ ...validRequest(), audioBase64: "not base64 !!!" })).toThrow(
      "The recorded audio could not be decoded.",
    );
  });

  it("rejects a WAV whose declared data length disagrees with the buffer", () => {
    const bytes = wavBuffer({ dataBytes: 4 });
    bytes.writeUInt32LE(999, 40); // lie about the data chunk size
    expect(() =>
      normalizeVoiceClip({ ...validRequest(), audioBase64: bytes.toString("base64") }),
    ).toThrow("The recorded audio is not a valid 24 kHz mono PCM WAV file.");
  });

  it("rejects a WAV whose embedded sample rate is wrong even if the field says 24 kHz", () => {
    // sampleRateHz field passes, but the WAV header encodes 16 kHz.
    expect(() =>
      normalizeVoiceClip({ ...validRequest(), audioBase64: wavBase64({ sampleRateHz: 16_000 }) }),
    ).toThrow("The recorded audio is not a valid 24 kHz mono PCM WAV file.");
  });

  it("rejects audio whose base64 exceeds the size ceiling", () => {
    // Well-formed base64 far larger than the decoded 10 MB ceiling allows.
    const huge = "A".repeat(MAX_AUDIO_BYTES * 2);
    expect(() => normalizeVoiceClip({ ...validRequest(), audioBase64: huge })).toThrow(
      "The recorded audio could not be decoded.",
    );
  });
});

describe("isValidWav", () => {
  it("accepts a canonical clip and rejects a too-short buffer", () => {
    expect(isValidWav(wavBuffer())).toBe(true);
    expect(isValidWav(NodeBuffer.Buffer.alloc(10))).toBe(false);
  });
});
