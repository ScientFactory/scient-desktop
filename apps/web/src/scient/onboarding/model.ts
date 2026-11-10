import * as Schema from "effect/Schema";

import type { ScientOnboardingPresentationStatus, ScientOnboardingStep } from "./policy";

export const SCIENT_ONBOARDING_STORAGE_KEY = "scient:getting-started:v1";
export const SCIENT_PERSONALIZATION_STORAGE_KEY = "scient:personalization:v1";
export const SCIENT_OTHER_WORK_MAX_LENGTH = 120;

export const ScientOnboardingStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(["unseen", "in-progress", "dismissed", "completed"]),
  lastStep: Schema.NullOr(Schema.Literals(["agent", "preferences", "start"])),
  firstPresentedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type ScientOnboardingState = typeof ScientOnboardingStateSchema.Type;

export const EMPTY_SCIENT_ONBOARDING_STATE: ScientOnboardingState = {
  schemaVersion: 1,
  status: "unseen",
  lastStep: null,
  firstPresentedAt: null,
  updatedAt: null,
};

export const ScientWorkKindSchema = Schema.Literals(["code", "academic", "scientific"]);
export type ScientWorkKind = typeof ScientWorkKindSchema.Type;

export const SCIENT_FIELD_VALUES = [
  "biology",
  "medicine",
  "neuroscience",
  "computer-science",
  "mathematics",
  "physics",
  "chemistry",
  "earth-science",
  "engineering",
  "social-sciences",
  "humanities",
  "other",
] as const;
export type ScientField = (typeof SCIENT_FIELD_VALUES)[number];
export const SCIENT_FIELD_LABELS: Readonly<Record<ScientField, string>> = {
  biology: "Biology & life sciences",
  medicine: "Medicine & health",
  neuroscience: "Neuroscience & psychology",
  "computer-science": "Computer science & AI",
  mathematics: "Mathematics & statistics",
  physics: "Physics & astronomy",
  chemistry: "Chemistry & materials",
  "earth-science": "Earth & environmental sciences",
  engineering: "Engineering",
  "social-sciences": "Social sciences & economics",
  humanities: "Humanities",
  other: "Other",
};

export const SCIENT_ROLE_VALUES = [
  "student",
  "phd-student",
  "postdoc",
  "researcher",
  "industry",
  "other",
] as const;
export type ScientRole = (typeof SCIENT_ROLE_VALUES)[number];
export const SCIENT_ROLE_LABELS: Readonly<Record<ScientRole, string>> = {
  student: "Student",
  "phd-student": "PhD student",
  postdoc: "Postdoc",
  researcher: "Researcher or professor",
  industry: "Industry",
  other: "Other",
};

export const ScientPersonalizationProfileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workKinds: Schema.Array(ScientWorkKindSchema),
  fieldOrTopic: Schema.String.check(Schema.isMaxLength(SCIENT_OTHER_WORK_MAX_LENGTH)),
  updatedAt: Schema.String,
  // Added after the first release; older saved profiles have none of these.
  field: Schema.optionalKey(Schema.Literals(SCIENT_FIELD_VALUES)),
  role: Schema.optionalKey(Schema.Literals(SCIENT_ROLE_VALUES)),
  /** When the question was answered or skipped, so it is asked once. */
  askedAt: Schema.optionalKey(Schema.String),
});
export type ScientPersonalizationProfile = typeof ScientPersonalizationProfileSchema.Type;

export const EMPTY_SCIENT_PERSONALIZATION_PROFILE: ScientPersonalizationProfile = {
  schemaVersion: 1,
  workKinds: [],
  fieldOrTopic: "",
  updatedAt: "",
};

export function hasSavedScientPreferences(profile: ScientPersonalizationProfile): boolean {
  return (
    profile.workKinds.length > 0 ||
    profile.fieldOrTopic.trim().length > 0 ||
    profile.field !== undefined ||
    profile.role !== undefined
  );
}

function updateState(
  state: ScientOnboardingState,
  status: ScientOnboardingPresentationStatus,
  lastStep: ScientOnboardingStep | null,
  now: string,
): ScientOnboardingState {
  return {
    schemaVersion: 1,
    status,
    lastStep,
    firstPresentedAt: state.firstPresentedAt ?? now,
    updatedAt: now,
  };
}

export function startScientOnboarding(
  state: ScientOnboardingState,
  step: ScientOnboardingStep,
  now: string,
): ScientOnboardingState {
  return updateState(state, "in-progress", step, now);
}

export function moveScientOnboarding(
  state: ScientOnboardingState,
  step: ScientOnboardingStep,
  now: string,
): ScientOnboardingState {
  return updateState(state, "in-progress", step, now);
}

export function dismissScientOnboarding(
  state: ScientOnboardingState,
  now: string,
): ScientOnboardingState {
  return updateState(state, "dismissed", null, now);
}

export function completeScientOnboarding(
  state: ScientOnboardingState,
  now: string,
): ScientOnboardingState {
  return updateState(state, "completed", null, now);
}
