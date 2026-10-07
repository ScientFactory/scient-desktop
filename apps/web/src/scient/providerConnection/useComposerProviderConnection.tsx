import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeSummary,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useCallback, useLayoutEffect, useState } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ComposerProviderUpdateFooter } from "./ComposerProviderUpdateFooter";
import { ProviderLifecycleSetupSurface } from "./ProviderOnboardingPicker";
import {
  activeProviderRuntimeUpdateOperation,
  providerConnectionPresentation,
  shouldShowProviderLifecycleSetupInComposer,
} from "./providerConnectionPresentation";
import {
  currentOptimisticProviderValue,
  type OptimisticProviderValue,
} from "./optimisticProviderValue";

type ModelDisabledReason = (instanceId: ProviderInstanceId, model: string) => string | null;

/**
 * The composer's view of the selected provider's managed runtime: an update
 * the user just started (held optimistically until the snapshot catches up),
 * whether sends must wait for it, and whether the provider needs connecting
 * before it can run a turn.
 */
export function useComposerProviderRuntimeUpdate(input: {
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly getModelDisabledReason: ModelDisabledReason;
}) {
  const { selectedProviderEntry, selectedInstanceId, lockedProvider, getModelDisabledReason } =
    input;
  const [localRuntimeUpdate, setLocalRuntimeUpdate] =
    useState<OptimisticProviderValue<ProviderRuntimeSummary> | null>(null);
  const [preparingRuntimeUpdateInstanceId, setPreparingRuntimeUpdateInstanceId] =
    useState<ProviderInstanceId | null>(null);
  const optimisticRuntimeUpdate = selectedProviderEntry
    ? currentOptimisticProviderValue(localRuntimeUpdate, selectedProviderEntry.snapshot)
    : null;
  const selectedProviderRuntime =
    optimisticRuntimeUpdate ?? selectedProviderEntry?.snapshot.connection?.runtime;
  const activeSelectedProviderRuntimeUpdate =
    activeProviderRuntimeUpdateOperation(selectedProviderRuntime);
  const selectedProviderIsUpdating =
    preparingRuntimeUpdateInstanceId === selectedInstanceId ||
    activeSelectedProviderRuntimeUpdate !== null;
  const selectedProviderUpdateLabel = selectedProviderEntry
    ? `Updating ${selectedProviderEntry.displayName}…`
    : "Updating provider…";
  const providerRuntimeUpdateSendDisabledReason = selectedProviderIsUpdating
    ? `${selectedProviderEntry?.displayName ?? "Provider"} is updating.`
    : null;
  const getComposerModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) =>
      instanceId === selectedInstanceId && providerRuntimeUpdateSendDisabledReason
        ? providerRuntimeUpdateSendDisabledReason
        : getModelDisabledReason(instanceId, model),
    [getModelDisabledReason, providerRuntimeUpdateSendDisabledReason, selectedInstanceId],
  );
  const selectedProviderNeedsConnection =
    selectedProviderEntry !== undefined &&
    shouldShowProviderLifecycleSetupInComposer(
      selectedProviderEntry.snapshot,
      selectedProviderRuntime,
    );
  const selectedProviderConnectionKind = providerConnectionPresentation(
    selectedProviderEntry?.snapshot,
  ).kind;
  const reconnectProviderEntry =
    lockedProvider !== null &&
    selectedProviderEntry !== undefined &&
    (selectedProviderConnectionKind === "not-connected" ||
      selectedProviderConnectionKind === "connecting")
      ? selectedProviderEntry
      : undefined;
  return {
    setLocalRuntimeUpdate,
    preparingRuntimeUpdateInstanceId,
    setPreparingRuntimeUpdateInstanceId,
    providerRuntimeUpdateSendDisabledReason,
    getComposerModelDisabledReason,
    selectedProviderNeedsConnection,
    reconnectProviderEntry,
    /** Model picker trigger props while the selected provider updates. */
    modelPickerUpdateStatusProps: selectedProviderIsUpdating
      ? {
          statusLabel: selectedProviderUpdateLabel,
          triggerAriaLabel: `${selectedProviderEntry?.displayName ?? "Provider"} update in progress`,
        }
      : {},
  };
}

/**
 * Translate a historical Antigravity family selection on the composer draft
 * into one of the selected instance's live variants.
 */
export function useReconcileAntigravityComposerSelection(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly hasStartedModelSession: boolean;
  readonly fallbackModelSelection: ModelSelection | null | undefined;
  readonly draftActiveProvider: ProviderInstanceId | null | undefined;
  readonly draftModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly providerModelPreferences: UnifiedSettings["providerModelPreferences"];
}): void {
  const {
    composerDraftTarget,
    selectedProviderEntry,
    hasStartedModelSession,
    fallbackModelSelection,
    draftActiveProvider,
    draftModelSelectionByProvider,
    providerModelPreferences,
  } = input;
  useLayoutEffect(() => {
    if (!selectedProviderEntry) return;
    if (draftActiveProvider && draftActiveProvider !== selectedProviderEntry.instanceId) return;
    const source =
      draftModelSelectionByProvider[selectedProviderEntry.instanceId] ?? fallbackModelSelection;
    if (!source) return;
    useComposerDraftStore.getState().reconcileAntigravityDraftSelection({
      threadRef: composerDraftTarget,
      provider: selectedProviderEntry.snapshot,
      hasStartedSession: hasStartedModelSession,
      fallbackSelection: fallbackModelSelection,
      hiddenModels: providerModelPreferences[selectedProviderEntry.instanceId]?.hiddenModels,
    });
  }, [
    composerDraftTarget,
    selectedProviderEntry,
    hasStartedModelSession,
    fallbackModelSelection,
    draftActiveProvider,
    draftModelSelectionByProvider,
    providerModelPreferences,
  ]);
}

/** Inline setup inside the model picker for providers that can be set up. */
export function useComposerProviderSetupRenderers(environmentId: EnvironmentId) {
  const isProviderSetupAvailable = useCallback(
    (entry: ProviderInstanceEntry) => entry.enabled && entry.isAvailable,
    [],
  );
  const renderProviderSetup = useCallback(
    (entry: ProviderInstanceEntry) => (
      <ProviderLifecycleSetupSurface environmentId={environmentId} entry={entry} />
    ),
    [environmentId],
  );
  return { isProviderSetupAvailable, renderProviderSetup };
}

/** The model picker footer that offers and tracks a managed runtime update. */
export function useComposerProviderUpdateFooter(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentUnavailable: { readonly label: string } | null;
  readonly runtimeUpdate: Pick<
    ReturnType<typeof useComposerProviderRuntimeUpdate>,
    | "preparingRuntimeUpdateInstanceId"
    | "setPreparingRuntimeUpdateInstanceId"
    | "setLocalRuntimeUpdate"
  >;
}) {
  const { environmentId, environmentUnavailable } = input;
  const {
    preparingRuntimeUpdateInstanceId,
    setPreparingRuntimeUpdateInstanceId,
    setLocalRuntimeUpdate,
  } = input.runtimeUpdate;
  // The server stages an update while turns run and switches runtimes only
  // once the provider is idle, so a running turn does not block starting one.
  const providerUpdateDisabledReason =
    environmentUnavailable !== null ? "Available when this environment reconnects." : undefined;
  return useCallback(
    (entry: ProviderInstanceEntry) => (
      <ComposerProviderUpdateFooter
        key={entry.instanceId}
        environmentId={environmentId}
        entry={entry}
        {...(preparingRuntimeUpdateInstanceId !== null &&
        preparingRuntimeUpdateInstanceId !== entry.instanceId
          ? { disabledReason: "Another provider update is being prepared." }
          : providerUpdateDisabledReason
            ? { disabledReason: providerUpdateDisabledReason }
            : {})}
        onPreparingChange={(isPreparing) => {
          setPreparingRuntimeUpdateInstanceId(isPreparing ? entry.instanceId : null);
        }}
        onUpdateStarted={(provider) => {
          const runtime = provider.connection?.runtime;
          if (runtime) {
            setLocalRuntimeUpdate({ baseProvider: entry.snapshot, value: runtime });
          }
        }}
      />
    ),
    // The two state setters are stable; they are listed because they arrive as
    // parameters here.
    [
      environmentId,
      preparingRuntimeUpdateInstanceId,
      providerUpdateDisabledReason,
      setLocalRuntimeUpdate,
      setPreparingRuntimeUpdateInstanceId,
    ],
  );
}
