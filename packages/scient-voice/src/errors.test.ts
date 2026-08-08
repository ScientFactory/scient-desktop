import { describe, expect, it } from "vite-plus/test";

import {
  isVoiceTranscriptionError,
  VoiceTranscriptionError,
  voiceTranscriptionFailureAllowsFallback,
} from "./errors.ts";

describe("VoiceTranscriptionError", () => {
  it("carries the classification and uses safeMessage as the message", () => {
    const cause = new Error("root cause");
    const error = new VoiceTranscriptionError({
      kind: "timeout",
      fallbackAllowed: true,
      safeMessage: "It timed out.",
      retryAfterMs: 1_500,
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("VoiceTranscriptionError");
    expect(error.message).toBe("It timed out.");
    expect(error.safeMessage).toBe("It timed out.");
    expect(error.kind).toBe("timeout");
    expect(error.fallbackAllowed).toBe(true);
    expect(error.retryAfterMs).toBe(1_500);
    expect(error.cause).toBe(cause);
  });

  it("leaves retryAfterMs undefined when not provided", () => {
    const error = new VoiceTranscriptionError({
      kind: "invalid-audio",
      fallbackAllowed: false,
      safeMessage: "Bad audio.",
    });
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it("is recognized by the type guard", () => {
    const error = new VoiceTranscriptionError({
      kind: "provider-error",
      fallbackAllowed: false,
      safeMessage: "Failed.",
    });
    expect(isVoiceTranscriptionError(error)).toBe(true);
    expect(isVoiceTranscriptionError(new Error("plain"))).toBe(false);
    expect(isVoiceTranscriptionError("nope")).toBe(false);
  });

  it("reports fallback eligibility only for fallback-allowed errors", () => {
    expect(
      voiceTranscriptionFailureAllowsFallback(
        new VoiceTranscriptionError({
          kind: "network",
          fallbackAllowed: true,
          safeMessage: "Network.",
        }),
      ),
    ).toBe(true);
    expect(
      voiceTranscriptionFailureAllowsFallback(
        new VoiceTranscriptionError({
          kind: "invalid-audio",
          fallbackAllowed: false,
          safeMessage: "Bad audio.",
        }),
      ),
    ).toBe(false);
    expect(voiceTranscriptionFailureAllowsFallback(new Error("plain"))).toBe(false);
  });
});
