import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { DRIVER_OPTIONS } from "../../components/settings/providerDriverMeta";
import { resolvePrimaryOperateAccess } from "../../components/settings/ProviderSettingsPanel.logic";
import { usePrimarySessionState } from "../../environments/primary";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { providerOnboardingStatusLabel } from "../providerConnection/ProviderOnboardingPicker";
import { hasSavedScientPreferences, type ScientWorkKind } from "./model";
import {
  resolveResumableScientOnboardingStep,
  resolveScientOnboardingJourney,
  shouldDismissScientOnboardingOnManualExit,
  type ScientOnboardingStep,
} from "./policy";
import {
  GettingStartedAgentStep,
  GettingStartedPreferencesStep,
  GettingStartedStartStep,
  ScientGettingStartedShell,
} from "./ScientGettingStartedView";
import { useScientOnboardingStorage } from "./storage";
import { ScientProjectImportAction } from "./ScientProjectImportAction";

export function ScientGettingStartedFlow(props: { readonly mode: "automatic" | "manual" }) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const sessionState = usePrimarySessionState();
  const {
    state: onboardingState,
    profile,
    start: startOnboarding,
    move: moveOnboarding,
    dismiss: dismissOnboarding,
    complete: completeOnboarding,
    saveProfile,
  } = useScientOnboardingStorage();
  const [manualStep, setManualStep] = useState<ScientOnboardingStep>("agent");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [workKinds, setWorkKinds] = useState<ReadonlyArray<ScientWorkKind>>(profile.workKinds);
  const [otherSelected, setOtherSelected] = useState(profile.fieldOrTopic.trim().length > 0);
  const [otherWork, setOtherWork] = useState(profile.fieldOrTopic);

  const instanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const providerReady = instanceEntries.some(isProviderInstancePickerReady);
  const preferencesSaved = hasSavedScientPreferences(profile);
  // Omit work already done at entry, then keep Back stable while setup state changes.
  const [journey] = useState<ReadonlyArray<ScientOnboardingStep>>(() =>
    resolveScientOnboardingJourney({
      mode: props.mode,
      providerReady,
      preferencesSaved,
    }),
  );
  const activeStep =
    props.mode === "manual"
      ? manualStep
      : resolveResumableScientOnboardingStep({
          journey,
          lastStep: onboardingState.lastStep,
        });
  const activeIndex = Math.max(0, journey.indexOf(activeStep));
  const previousStep = activeIndex > 0 ? journey[activeIndex - 1] : null;
  const nextStep = journey[activeIndex + 1] ?? null;

  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: typeof window !== "undefined" && Boolean(window.desktopBridge),
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.error !== null,
  });

  const entryByDriver = (() => {
    const entries = new Map<string, ProviderInstanceEntry>();
    for (const entry of instanceEntries) {
      const existing = entries.get(entry.driverKind);
      if (!existing || entry.isDefault) entries.set(entry.driverKind, entry);
    }
    return entries;
  })();
  const choices = DRIVER_OPTIONS.map((definition) => {
    const entry = entryByDriver.get(definition.value) ?? null;
    return {
      driverKind: definition.value,
      icon: definition.icon,
      label: definition.label,
      detail:
        [definition.vendorLabel, definition.accountLabel]
          .filter((part) => part !== undefined)
          .join(" · ") || null,
      status: providerOnboardingStatusLabel(entry ?? undefined),
      ready: entry ? isProviderInstancePickerReady(entry) : false,
      actionable: operateAccess === "granted",
      entry,
    };
  });
  const selectedEntry = selectedEntryId
    ? (instanceEntries.find((entry) => entry.instanceId === selectedEntryId) ?? null)
    : null;

  const moveToStep = (step: ScientOnboardingStep) => {
    setSelectedEntryId(null);
    if (props.mode === "manual") {
      setManualStep(step);
    } else {
      moveOnboarding(step);
    }
  };

  useEffect(() => {
    if (props.mode !== "automatic") return;
    if (onboardingState.status === "unseen") {
      startOnboarding(activeStep);
      return;
    }
    if (onboardingState.lastStep !== activeStep) moveOnboarding(activeStep);
  }, [
    activeStep,
    moveOnboarding,
    onboardingState.lastStep,
    onboardingState.status,
    props.mode,
    startOnboarding,
  ]);

  const skip = () => {
    if (props.mode === "automatic") {
      dismissOnboarding();
      return;
    }
    if (shouldDismissScientOnboardingOnManualExit(onboardingState.status)) {
      dismissOnboarding();
    }
    void navigate({ to: "/" });
  };

  const goBack = () => {
    if (selectedEntryId !== null) {
      setSelectedEntryId(null);
      return;
    }
    if (previousStep) moveToStep(previousStep);
  };

  const goNext = () => {
    if (nextStep) moveToStep(nextStep);
  };

  const finishBefore = async (operation: () => void | Promise<void>) => {
    completeOnboarding();
    if (props.mode === "manual") await navigate({ to: "/" });
    await operation();
  };

  const addProject = () => {
    void finishBefore(() => openCommandPalette({ open: "add-project" }));
  };

  if (!primaryEnvironmentId) return null;

  const canGoBack = selectedEntryId !== null || previousStep !== null;

  return (
    <ScientGettingStartedShell
      canGoBack={canGoBack}
      currentStep={activeStep}
      journey={journey}
      onBack={goBack}
      onSkip={skip}
    >
      {activeStep === "agent" ? (
        <GettingStartedAgentStep
          canContinue={providerReady}
          choices={choices}
          environmentId={primaryEnvironmentId}
          onContinue={goNext}
          onSelect={(choice) => {
            if (!choice.entry) {
              void navigate({ to: "/settings/providers" });
              return;
            }
            if (choice.ready) {
              goNext();
              return;
            }
            setSelectedEntryId(choice.entry.instanceId);
          }}
          selectedEntry={selectedEntry}
        />
      ) : activeStep === "preferences" ? (
        <GettingStartedPreferencesStep
          onContinue={() => {
            saveProfile({
              workKinds,
              fieldOrTopic: otherSelected ? otherWork : "",
            });
            goNext();
          }}
          onOtherSelectedChange={setOtherSelected}
          onOtherWorkChange={setOtherWork}
          onToggleWorkKind={(kind) =>
            setWorkKinds((current) =>
              current.includes(kind)
                ? current.filter((candidate) => candidate !== kind)
                : [...current, kind],
            )
          }
          otherSelected={otherSelected}
          otherWork={otherWork}
          workKinds={workKinds}
        />
      ) : (
        <GettingStartedStartStep
          onAddProject={addProject}
          importAction={<ScientProjectImportAction onImported={completeOnboarding} />}
        />
      )}
    </ScientGettingStartedShell>
  );
}
