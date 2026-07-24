// FILE: voiceRequest.test.ts
// Purpose: Verifies the provider-neutral desktop IPC audio boundary.
// Layer: Desktop voice tests

import { describe, expect, it } from "vitest";
import { normalizeDesktopVoiceRequest } from "./voiceRequest";

function wavBase64(sampleRateHz = 24_000): string {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  return bytes.toString("base64");
}

describe("normalizeDesktopVoiceRequest", () => {
  it("decodes a validated WAV once and defaults to automatic routing", () => {
    const result = normalizeDesktopVoiceRequest({
      provider: "claudeAgent",
      cwd: " /workspace ",
      threadId: "thread-1",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1,
      audioBase64: wavBase64(),
    });

    expect(result.mode).toBe("automatic");
    expect(result.clip).toMatchObject({
      cwd: "/workspace",
      threadId: "thread-1",
      sampleRateHz: 24_000,
      mimeType: "audio/wav",
    });
    expect(result.clip.audioBytes.byteLength).toBe(46);
  });

  it("accepts the provider-neutral offline-only mode", () => {
    expect(
      normalizeDesktopVoiceRequest({
        cwd: "/workspace",
        mode: "offline-only",
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1,
        audioBase64: wavBase64(),
      }).mode,
    ).toBe("offline-only");
  });

  it("rejects malformed and wrong-format WAV before either backend", () => {
    const base = {
      cwd: "/workspace",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1,
    };
    expect(() => normalizeDesktopVoiceRequest({ ...base, audioBase64: "not base64" })).toThrow(
      "The recorded audio could not be decoded.",
    );
    expect(() => normalizeDesktopVoiceRequest({ ...base, audioBase64: wavBase64(16_000) })).toThrow(
      "The recorded audio is not a valid 24 kHz mono PCM WAV file.",
    );
  });
});
