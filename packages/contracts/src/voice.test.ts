import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { VOICE_AUDIO_BASE64_MAX_CHARS, VoiceTranscribeRequest } from "./voice.ts";

const decodeVoiceRequest = Schema.decodeUnknownSync(VoiceTranscribeRequest);

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
