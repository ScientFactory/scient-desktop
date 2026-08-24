import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_AUDIO_BASE64_MAX_CHARS,
  VOICE_TRANSCRIPT_CORRECTION_MAX_CHARS,
  VoiceTranscribeRequest,
  VoiceTranscriptCorrectionRequest,
} from "./voice.ts";

const decodeVoiceRequest = Schema.decodeUnknownSync(VoiceTranscribeRequest);
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
});
