import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  completeScientOnboarding,
  dismissScientOnboarding,
  EMPTY_SCIENT_ONBOARDING_STATE,
  hasSavedScientPreferences,
  moveScientOnboarding,
  startScientOnboarding,
  ScientOnboardingStateSchema,
  ScientPersonalizationProfileSchema,
} from "./model";

const now = "2026-08-23T10:00:00.000Z";
const encodeOnboardingState = Schema.encodeUnknownSync(ScientOnboardingStateSchema);
const decodeOnboardingState = Schema.decodeUnknownSync(ScientOnboardingStateSchema);
const decodePersonalizationProfile = Schema.decodeUnknownSync(ScientPersonalizationProfileSchema);

describe("Scient onboarding presentation state", () => {
  it("starts once and keeps the original presentation timestamp while resuming", () => {
    const started = startScientOnboarding(EMPTY_SCIENT_ONBOARDING_STATE, "agent", now);
    expect(started).toEqual({
      schemaVersion: 1,
      status: "in-progress",
      lastStep: "agent",
      firstPresentedAt: now,
      updatedAt: now,
    });

    const later = "2026-08-23T10:01:00.000Z";
    expect(moveScientOnboarding(started, "preferences", later)).toMatchObject({
      status: "in-progress",
      lastStep: "preferences",
      firstPresentedAt: now,
      updatedAt: later,
    });
  });

  it("distinguishes dismissal from completion without storing readiness", () => {
    expect(dismissScientOnboarding(EMPTY_SCIENT_ONBOARDING_STATE, now)).toMatchObject({
      status: "dismissed",
      lastStep: null,
    });
    expect(completeScientOnboarding(EMPTY_SCIENT_ONBOARDING_STATE, now)).toMatchObject({
      status: "completed",
      lastStep: null,
    });
  });
});

describe("hasSavedScientPreferences", () => {
  it("requires an actual selection or topic", () => {
    expect(
      hasSavedScientPreferences({
        schemaVersion: 1,
        workKinds: [],
        fieldOrTopic: "   ",
        updatedAt: now,
      }),
    ).toBe(false);
    expect(
      hasSavedScientPreferences({
        schemaVersion: 1,
        workKinds: ["academic"],
        fieldOrTopic: "",
        updatedAt: now,
      }),
    ).toBe(true);
  });
});

describe("Scient onboarding storage schemas", () => {
  it("round-trips the versioned presentation record", () => {
    const started = startScientOnboarding(EMPTY_SCIENT_ONBOARDING_STATE, "agent", now);
    const encoded = encodeOnboardingState(started);
    expect(decodeOnboardingState(encoded)).toEqual(started);
  });

  it("rejects unknown preference values instead of silently personalizing from them", () => {
    expect(() =>
      decodePersonalizationProfile({
        schemaVersion: 1,
        workKinds: ["medical"],
        fieldOrTopic: "Cardiology",
        updatedAt: now,
      }),
    ).toThrow();
  });
});
