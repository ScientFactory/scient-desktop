import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  completeScientOnboarding,
  dismissScientOnboarding,
  EMPTY_SCIENT_ONBOARDING_STATE,
  EMPTY_SCIENT_PERSONALIZATION_PROFILE,
  moveScientOnboarding,
  SCIENT_ONBOARDING_STORAGE_KEY,
  SCIENT_PERSONALIZATION_STORAGE_KEY,
  ScientOnboardingStateSchema,
  ScientPersonalizationProfileSchema,
  startScientOnboarding,
  type ScientPersonalizationProfile,
} from "./model";

const nowIso = () => new Date().toISOString();

export function useScientOnboardingStorage() {
  const [state, setState] = useLocalStorage(
    SCIENT_ONBOARDING_STORAGE_KEY,
    EMPTY_SCIENT_ONBOARDING_STATE,
    ScientOnboardingStateSchema,
  );
  const [profile, setProfile] = useLocalStorage(
    SCIENT_PERSONALIZATION_STORAGE_KEY,
    EMPTY_SCIENT_PERSONALIZATION_PROFILE,
    ScientPersonalizationProfileSchema,
  );

  const start = (step: Parameters<typeof startScientOnboarding>[1]) => {
    setState((current) => startScientOnboarding(current, step, nowIso()));
  };
  const move = (step: Parameters<typeof moveScientOnboarding>[1]) => {
    setState((current) => moveScientOnboarding(current, step, nowIso()));
  };
  const dismiss = () => {
    setState((current) => dismissScientOnboarding(current, nowIso()));
  };
  const complete = () => {
    setState((current) => completeScientOnboarding(current, nowIso()));
  };
  const saveProfile = (next: Pick<ScientPersonalizationProfile, "workKinds" | "fieldOrTopic">) => {
    setProfile({
      schemaVersion: 1,
      workKinds: next.workKinds,
      fieldOrTopic: next.fieldOrTopic.trim(),
      updatedAt: nowIso(),
    });
  };

  return { state, profile, start, move, dismiss, complete, saveProfile };
}
