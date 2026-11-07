import { describe, expect, it } from "@effect/vitest";
import { consentAllows, normalizeInheritedEvent } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

const context = { appVersion: "0.6.27", buildChannel: "stable" } as const;

describe("capture and voice outcome metadata", () => {
  it("buckets retained/rejected counts and keeps coverage separate from known loss", () => {
    const event = normalizeInheritedEvent(
      "scient.operation.completed",
      {
        operationKind: "compute-artifact",
        captureSchemaVersion: 2,
        captureSource: "interactive",
        captureOutcome: "retained",
        captureCoverage: "partial",
        captureReason: "scan-entry-limit",
        retainedOutputCount: 2,
        rejectedOutputCount: 0,
      },
      context,
    )!;
    expect(event.properties).toMatchObject({
      captureSchemaVersion: 2,
      captureOutcome: "retained",
      captureCoverage: "partial",
      captureReason: "scan-entry-limit",
      retainedOutputCountBucket: "2-3",
      rejectedOutputCountBucket: "0",
    });
    expect(event.properties).not.toHaveProperty("retainedOutputCount");
    expect(
      eventContractViolation({
        name: event.name,
        properties: event.properties,
        privacyLevel: event.privacyLevel,
        consentLevel: "product",
      }),
    ).toBeNull();
  });
  it("does not transmit arbitrary reason strings, transcript contents, or raw stage timings", () => {
    const capture = normalizeInheritedEvent(
      "scient.operation.failed",
      {
        operationKind: "compute-artifact",
        captureSchemaVersion: 2,
        captureReason: "private-diagnostic-note",
        captureOutcome: "partial",
        captureCoverage: "partial",
        captureSource: "interactive",
        retainedOutputCount: 1,
        rejectedOutputCount: 1,
      },
      context,
    )!;
    expect(capture.properties.captureReason).toBe("unknown");
    const voice = normalizeInheritedEvent(
      "voice.transcription.completed",
      {
        voiceSchemaVersion: 2,
        engineClass: "local-whisper",
        durationMs: 700,
        transcriptionDurationMs: 200,
        correctionDurationMs: 500,
        audioDurationMs: 3000,
        correctionOutcome: "fallback",
        text: "private transcript",
        path: "/private/audio.wav",
      },
      context,
    )!;
    expect(voice.properties).toMatchObject({
      voiceSchemaVersion: 2,
      correctionOutcome: "fallback",
      transcriptionDurationBucket: expect.any(String),
      correctionDurationBucket: expect.any(String),
    });
    expect(JSON.stringify([capture, voice])).not.toMatch(
      /private|DurationMs|retainedOutputCount"/u,
    );
    expect(
      eventContractViolation({
        name: voice.name,
        properties: voice.properties,
        privacyLevel: voice.privacyLevel,
        consentLevel: "product",
      }),
    ).toBeNull();
  });
  it("allows recording and transcription failures at Essential without collecting voice usage", () => {
    for (const name of ["voice.recording.failed", "voice.transcription.failed"]) {
      const event = normalizeInheritedEvent(
        name,
        { voiceSchemaVersion: 2, failureClass: "audio", stage: "preparing" },
        context,
      )!;
      expect(event.privacyLevel).toBe("essential");
      expect(consentAllows("essential", event.privacyLevel)).toBe(true);
    }
    const cancelled = normalizeInheritedEvent(
      "voice.transcription.cancelled",
      { voiceSchemaVersion: 2, stage: "correcting", correctionOutcome: "cancelled" },
      context,
    )!;
    expect(cancelled.properties.stage).toBe("correcting");
    expect(consentAllows("essential", cancelled.privacyLevel)).toBe(false);
    expect(consentAllows("off", cancelled.privacyLevel)).toBe(false);
  });
});
