import { useAtomValue } from "@effect/atom-react";
import { supportsScientQuickChat } from "@t3tools/client-runtime/scient/quick-chat";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { PROVIDER_CLIENT_DEFINITIONS } from "../../components/settings/providerDriverMeta";
import { resolvePrimaryOperateAccess } from "../../components/settings/ProviderSettingsPanel.logic";
import { usePrimarySessionState } from "../../environments/primary";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "../../state/server";
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
  type GettingStartedProviderChoice,
} from "./ScientGettingStartedView";
import { useScientOnboardingStorage } from "./storage";

const PRIMARY_ONBOARDING_PROVIDER_COUNT = 3;

export function ScientGettingStartedFlow(props: { readonly mode: "automatic" | "manual" }) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const sessionState = usePrimarySessionState();
  const handleNewThread = useNewThreadHandler();
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
  const [startingQuickChat, setStartingQuickChat] = useState(false);

  const instanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
    [serverProviders],
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

  const entryByDriver = useMemo(() => {
    const entries = new Map<string, ProviderInstanceEntry>();
    for (const entry of instanceEntries) {
      const existing = entries.get(entry.driverKind);
      if (!existing || entry.isDefault) entries.set(entry.driverKind, entry);
    }
    return entries;
  }, [instanceEntries]);
  const choices = useMemo<ReadonlyArray<GettingStartedProviderChoice>>(
    () =>
      PROVIDER_CLIENT_DEFINITIONS.slice(0, PRIMARY_ONBOARDING_PROVIDER_COUNT).map((definition) => {
        const entry = entryByDriver.get(definition.value) ?? null;
        return {
          driverKind: definition.value,
          icon: definition.icon,
          label: definition.label,
          status: providerOnboardingStatusLabel(entry ?? undefined),
          ready: entry ? isProviderInstancePickerReady(entry) : false,
          actionable: operateAccess === "granted",
          entry,
        };
      }),
    [entryByDriver, operateAccess],
  );
  const selectedEntry = selectedEntryId
    ? (instanceEntries.find((entry) => entry.instanceId === selectedEntryId) ?? null)
    : null;

  const moveToStep = useCallback(
    (step: ScientOnboardingStep) => {
      setSelectedEntryId(null);
      if (props.mode === "manual") {
        setManualStep(step);
      } else {
        moveOnboarding(step);
      }
    },
    [moveOnboarding, props.mode],
  );

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

  const skip = useCallback(() => {
    if (props.mode === "automatic") {
      dismissOnboarding();
      return;
    }
    if (shouldDismissScientOnboardingOnManualExit(onboardingState.status)) {
      dismissOnboarding();
    }
    void navigate({ to: "/" });
  }, [dismissOnboarding, navigate, onboardingState.status, props.mode]);

  const goBack = useCallback(() => {
    if (selectedEntryId !== null) {
      setSelectedEntryId(null);
      return;
    }
    if (previousStep) moveToStep(previousStep);
  }, [moveToStep, previousStep, selectedEntryId]);

  const goNext = useCallback(() => {
    if (nextStep) moveToStep(nextStep);
  }, [moveToStep, nextStep]);

  const finishBefore = useCallback(
    async (operation: () => void | Promise<void>) => {
      completeOnboarding();
      if (props.mode === "manual") await navigate({ to: "/" });
      await operation();
    },
    [completeOnboarding, navigate, props.mode],
  );

  const addProject = useCallback(() => {
    void finishBefore(() => openCommandPalette({ open: "add-project" }));
  }, [finishBefore]);

  const startQuickChat = useCallback(() => {
    if (!primaryEnvironmentId || startingQuickChat) return;
    setStartingQuickChat(true);
    void handleNewThread(
      { environmentId: primaryEnvironmentId, projectId: null },
      { replace: true },
    )
      .then((result) => {
        if (result) completeOnboarding();
      })
      .finally(() => setStartingQuickChat(false));
  }, [completeOnboarding, handleNewThread, primaryEnvironmentId, startingQuickChat]);

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
          canStartQuickChat={supportsScientQuickChat(primaryServerConfig)}
          onAddProject={addProject}
          onStartQuickChat={startQuickChat}
          startingQuickChat={startingQuickChat}
        />
      )}
    </ScientGettingStartedShell>
  );
}
