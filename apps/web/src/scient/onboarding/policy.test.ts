import { describe, expect, it } from "vite-plus/test";

import {
  resolveResumableScientOnboardingStep,
  resolveScientOnboardingEntry,
  resolveScientOnboardingJourney,
  shouldDismissScientOnboardingOnManualExit,
} from "./policy";

describe("resolveScientOnboardingEntry", () => {
  const ready = {
    status: "unseen" as const,
    shellBootstrapped: true,
    primaryEnvironmentReady: true,
    operateAccess: "granted" as const,
    hasExistingActivity: false,
  };

  it("presents only on an empty, ready, writable environment", () => {
    expect(resolveScientOnboardingEntry(ready)).toBe("present");
    expect(resolveScientOnboardingEntry({ ...ready, shellBootstrapped: false })).toBe("wait");
    expect(resolveScientOnboardingEntry({ ...ready, primaryEnvironmentReady: false })).toBe("wait");
    expect(resolveScientOnboardingEntry({ ...ready, operateAccess: "pending" })).toBe("wait");
    expect(resolveScientOnboardingEntry({ ...ready, operateAccess: "denied" })).toBe("bypass");
  });

  it("never repeats a dismissed or completed flow", () => {
    expect(resolveScientOnboardingEntry({ ...ready, status: "dismissed" })).toBe("bypass");
    expect(resolveScientOnboardingEntry({ ...ready, status: "completed" })).toBe("bypass");
  });

  it("silently handles existing users instead of interrupting them", () => {
    expect(resolveScientOnboardingEntry({ ...ready, hasExistingActivity: true })).toBe(
      "complete-silently",
    );
    expect(
      resolveScientOnboardingEntry({
        ...ready,
        status: "in-progress",
        hasExistingActivity: true,
      }),
    ).toBe("complete-silently");
  });
});

describe("resolveScientOnboardingJourney", () => {
  it("uses three steps only for a completely fresh setup", () => {
    expect(
      resolveScientOnboardingJourney({
        mode: "automatic",
        providerReady: false,
        preferencesSaved: false,
      }),
    ).toEqual(["agent", "preferences", "start"]);
  });

  it("omits setup already completed in canonical state", () => {
    expect(
      resolveScientOnboardingJourney({
        mode: "automatic",
        providerReady: true,
        preferencesSaved: false,
      }),
    ).toEqual(["preferences", "start"]);
    expect(
      resolveScientOnboardingJourney({
        mode: "automatic",
        providerReady: false,
        preferencesSaved: true,
      }),
    ).toEqual(["agent", "start"]);
    expect(
      resolveScientOnboardingJourney({
        mode: "automatic",
        providerReady: true,
        preferencesSaved: true,
      }),
    ).toEqual(["start"]);
  });

  it("keeps every step available during a manual replay", () => {
    expect(
      resolveScientOnboardingJourney({
        mode: "manual",
        providerReady: true,
        preferencesSaved: true,
      }),
    ).toEqual(["agent", "preferences", "start"]);
  });
});

describe("resolveResumableScientOnboardingStep", () => {
  it("resumes only when the stored step still belongs to the journey", () => {
    expect(
      resolveResumableScientOnboardingStep({
        journey: ["preferences", "start"],
        lastStep: "preferences",
      }),
    ).toBe("preferences");
    expect(
      resolveResumableScientOnboardingStep({
        journey: ["preferences", "start"],
        lastStep: "agent",
      }),
    ).toBe("preferences");
  });
});

describe("shouldDismissScientOnboardingOnManualExit", () => {
  it("prevents a fresh manual exit from immediately reopening automatic onboarding", () => {
    expect(shouldDismissScientOnboardingOnManualExit("unseen")).toBe(true);
    expect(shouldDismissScientOnboardingOnManualExit("in-progress")).toBe(true);
    expect(shouldDismissScientOnboardingOnManualExit("dismissed")).toBe(false);
    expect(shouldDismissScientOnboardingOnManualExit("completed")).toBe(false);
  });
});
