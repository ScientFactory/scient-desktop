// FILE: voiceTranscription.test.ts
// Purpose: Verifies provider-neutral voice error classification helpers.
// Layer: Shared runtime tests

import { describe, expect, it } from "vitest";
import {
  isVoiceTranscriptionBackendError,
  VoiceTranscriptionBackendError,
  voiceTranscriptionFailureAllowsFallback,
} from "./voiceTranscription";

describe("VoiceTranscriptionBackendError", () => {
  it("preserves safe typed fallback metadata", () => {
    const error = new VoiceTranscriptionBackendError({
      kind: "rate-limit",
      fallbackAllowed: true,
      retryAfterMs: 30_000,
      safeMessage: "ChatGPT transcription is temporarily rate limited.",
    });

    expect(isVoiceTranscriptionBackendError(error)).toBe(true);
    expect(voiceTranscriptionFailureAllowsFallback(error)).toBe(true);
    expect(error).toMatchObject({
      kind: "rate-limit",
      fallbackAllowed: true,
      retryAfterMs: 30_000,
      message: "ChatGPT transcription is temporarily rate limited.",
    });
  });

  it("does not treat cancellation or unknown errors as fallback-safe", () => {
    const cancelled = new VoiceTranscriptionBackendError({
      kind: "cancelled",
      fallbackAllowed: false,
      safeMessage: "Voice transcription was cancelled.",
    });

    expect(voiceTranscriptionFailureAllowsFallback(cancelled)).toBe(false);
    expect(voiceTranscriptionFailureAllowsFallback(new Error("network"))).toBe(false);
  });
});
