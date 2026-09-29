import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_AUDIO_BASE64_MAX_CHARS,
  VOICE_TRANSCRIPT_CORRECTION_MAX_CHARS,
  VoiceTranscribeRequest,
  VoiceCancelTranscriptionRequest,
  VoiceTranscriptCorrectionRequest,
} from "./voice.ts";

const decodeVoiceRequest = Schema.decodeUnknownSync(VoiceTranscribeRequest);
const decodeCancellationRequest = Schema.decodeUnknownSync(VoiceCancelTranscriptionRequest);
const decodeCorrectionRequest = Schema.decodeUnknownSync(VoiceTranscriptCorrectionRequest);

describe("VoiceTranscribeRequest", () => {
  it("accepts a request at the bounded base64 size", () => {
    const request = {
      audioBase64: "A".repeat(VOICE_AUDIO_BASE64_MAX_CHARS),
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 180_000,
    } as const;
    expect(decodeVoiceRequest(request)).toEqual(request);
  });

  it("rejects an oversized base64 payload at the IPC schema", () => {
    expect(() =>
      decodeVoiceRequest({
        audioBase64: "A".repeat(VOICE_AUDIO_BASE64_MAX_CHARS + 1),
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 180_000,
      }),
    ).toThrow();
  });

  it("accepts a supported explicit language and rejects arbitrary values", () => {
    const request = {
      audioBase64: "AAAA",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1_000,
      language: "he",
    } as const;
    expect(decodeVoiceRequest(request)).toEqual(request);
    expect(() => decodeVoiceRequest({ ...request, language: "auto" })).toThrow();
    expect(() => decodeVoiceRequest({ ...request, language: "xx" })).toThrow();
  });
});

describe("VoiceTranscriptCorrectionRequest", () => {
  it("accepts a non-empty bounded transcript", () => {
    expect(decodeCorrectionRequest({ transcript: "Hello world" })).toEqual({
      transcript: "Hello world",
    });
  });

  it("rejects empty and oversized transcripts", () => {
    expect(() => decodeCorrectionRequest({ transcript: "   " })).toThrow();
    expect(() =>
      decodeCorrectionRequest({
        transcript: "A".repeat(VOICE_TRANSCRIPT_CORRECTION_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("accepts only supported explicit language hints", () => {
    expect(decodeCorrectionRequest({ transcript: "שלום", language: "he" })).toEqual({
      transcript: "שלום",
      language: "he",
    });
    expect(() => decodeCorrectionRequest({ transcript: "hello", language: "auto" })).toThrow();
  });
});

describe("voice request identity", () => {
  it("round-trips scoped identities while accepting older transcription requests", () => {
    const request = {
      audioBase64: "AAAA",
      mimeType: "audio/wav",
      sampleRateHz: 24000,
      durationMs: 1,
    };
    expect(decodeVoiceRequest(request)).toEqual(request);
    expect(decodeVoiceRequest({ ...request, requestId: "owner" }).requestId).toBe("owner");
    expect(decodeCancellationRequest({ requestId: "owner" })).toEqual({ requestId: "owner" });
  });
  it.each(["", " ", "x".repeat(129)])("rejects invalid cancellation identities", (requestId) => {
    expect(() => decodeCancellationRequest({ requestId })).toThrow();
  });
});
