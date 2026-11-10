import { describe, expect, it } from "@effect/vitest";
import { consentAllows, normalizeInheritedEvent } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

const context = { appVersion: "0.6.27", buildChannel: "stable" } as const;

describe("capture and voice outcome metadata", () => {
  it("keeps capture starts free of premature outcomes", () => {
    const event = normalizeInheritedEvent(
      "scient.operation.started",
      {
        operationKind: "compute-artifact",
        captureSchemaVersion: 2,
        captureSource: "interactive",
        captureOutcome: "failed",
        captureCoverage: "partial",
        captureReason: "image-limit",
        retainedOutputCount: 2,
        rejectedOutputCount: 3,
      },
      context,
    )!;
    expect(event.properties).toEqual({
      ...context,
      contractRevision: "11",
      operationKind: "compute-artifact",
      trigger: "other",
      durationBucket: "unknown",
      failureClass: "unknown",
      reviewRequired: false,
      captureSchemaVersion: 2,
      captureSource: "interactive",
    });
  });

  it("keeps an unenumerated Run File rejection count unknown", () => {
    const event = normalizeInheritedEvent(
      "scient.operation.failed",
      {
        operationKind: "compute-artifact",
        captureSchemaVersion: 2,
        captureSource: "run-file",
        captureOutcome: "partial",
        captureCoverage: "unavailable",
        captureReason: "artifact-collection-failed",
        retainedOutputCount: 1,
      },
      context,
    )!;
    expect(event.properties).toMatchObject({
      captureOutcome: "partial",
      captureReason: "artifact-collection-failed",
      retainedOutputCountBucket: "1",
      rejectedOutputCountBucket: "unknown",
    });
    expect(event.properties).not.toHaveProperty("rejectedOutputCount");
  });

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
