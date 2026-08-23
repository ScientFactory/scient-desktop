export type ScientOnboardingPresentationStatus =
  | "unseen"
  | "in-progress"
  | "dismissed"
  | "completed";

export type ScientOnboardingEntryDecision = "wait" | "present" | "bypass" | "complete-silently";

export type ScientOnboardingStep = "agent" | "preferences" | "start";

/**
 * Resolve whether the automatic first-run surface belongs on the empty chat
 * route. The host route remains responsible for environment connection; this
 * decision starts only after the environment and its entity shell are ready.
 */
export function resolveScientOnboardingEntry(input: {
  readonly status: ScientOnboardingPresentationStatus;
  readonly shellBootstrapped: boolean;
  readonly primaryEnvironmentReady: boolean;
  readonly operateAccess: "granted" | "denied" | "pending";
  readonly hasExistingActivity: boolean;
}): ScientOnboardingEntryDecision {
  if (input.status === "dismissed" || input.status === "completed") return "bypass";
  if (!input.shellBootstrapped || !input.primaryEnvironmentReady) return "wait";
  if (input.operateAccess === "pending") return "wait";
  if (input.operateAccess === "denied") return "bypass";
  if (input.hasExistingActivity) return "complete-silently";
  return "present";
}

/**
 * Keep the automatic journey short by omitting setup that is already true.
 * Manual replay intentionally includes every step so users can review or
 * change their setup from Settings without resetting anything first.
 */
export function resolveScientOnboardingJourney(input: {
  readonly mode: "automatic" | "manual";
  readonly providerReady: boolean;
  readonly preferencesSaved: boolean;
}): ReadonlyArray<ScientOnboardingStep> {
  if (input.mode === "manual") return ["agent", "preferences", "start"];
  return [
    ...(input.providerReady ? [] : (["agent"] as const)),
    ...(input.preferencesSaved ? [] : (["preferences"] as const)),
    "start" as const,
  ];
}

export function resolveResumableScientOnboardingStep(input: {
  readonly journey: ReadonlyArray<ScientOnboardingStep>;
  readonly lastStep: ScientOnboardingStep | null;
}): ScientOnboardingStep {
  if (input.lastStep && input.journey.includes(input.lastStep)) return input.lastStep;
  return input.journey[0] ?? "start";
}

export function shouldDismissScientOnboardingOnManualExit(
  status: ScientOnboardingPresentationStatus,
): boolean {
  return status === "unseen" || status === "in-progress";
}
