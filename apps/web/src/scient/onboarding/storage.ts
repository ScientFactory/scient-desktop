import { useCallback, useMemo } from "react";

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

  const start = useCallback(
    (step: Parameters<typeof startScientOnboarding>[1]) => {
      setState((current) => startScientOnboarding(current, step, nowIso()));
    },
    [setState],
  );
  const move = useCallback(
    (step: Parameters<typeof moveScientOnboarding>[1]) => {
      setState((current) => moveScientOnboarding(current, step, nowIso()));
    },
    [setState],
  );
  const dismiss = useCallback(() => {
    setState((current) => dismissScientOnboarding(current, nowIso()));
  }, [setState]);
  const complete = useCallback(() => {
    setState((current) => completeScientOnboarding(current, nowIso()));
  }, [setState]);
  const saveProfile = useCallback(
    (next: Pick<ScientPersonalizationProfile, "workKinds" | "fieldOrTopic">) => {
      setProfile({
        schemaVersion: 1,
        workKinds: next.workKinds,
        fieldOrTopic: next.fieldOrTopic.trim(),
        updatedAt: nowIso(),
      });
    },
    [setProfile],
  );

  return useMemo(
    () => ({ state, profile, start, move, dismiss, complete, saveProfile }),
    [complete, dismiss, move, profile, saveProfile, start, state],
  );
}
