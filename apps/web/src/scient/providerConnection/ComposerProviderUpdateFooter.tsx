import type { EnvironmentId, ProviderRuntimeSummary, ServerProvider } from "@t3tools/contracts";
import { useState } from "react";

import { ModelPickerProviderUpdateFooter } from "../../components/chat/ModelPickerContent";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  currentOptimisticProviderValue,
  type OptimisticProviderValue,
} from "./optimisticProviderValue";
import { startReviewedProviderRuntimeAction } from "./providerLifecycleActions";
import {
  activeProviderRuntimeUpdateOperation,
  isActiveProviderRuntimeOperation,
} from "./providerConnectionPresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

export function canOfferComposerManagedRuntimeUpdate(entry: ProviderInstanceEntry): boolean {
  const runtime = entry.snapshot.connection?.runtime;
  return (
    runtime?.source === "scient_managed" &&
    !isActiveProviderRuntimeOperation(runtime.operation) &&
    runtime.actions.includes("update")
  );
}

export function ComposerProviderUpdateFooter(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: ProviderInstanceEntry;
  readonly disabledReason?: string | undefined;
  readonly onPreparingChange: (isPreparing: boolean) => void;
  readonly onUpdateStarted: (provider: ServerProvider) => void;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.entry.snapshot,
  });
  const [isStarting, setIsStarting] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [localRuntimeUpdate, setLocalRuntimeUpdate] =
    useState<OptimisticProviderValue<ProviderRuntimeSummary> | null>(null);
  const runtime =
    currentOptimisticProviderValue(localRuntimeUpdate, props.entry.snapshot) ??
    props.entry.snapshot.connection?.runtime;
  const activeUpdate = activeProviderRuntimeUpdateOperation(runtime);

  if (!activeUpdate && !canOfferComposerManagedRuntimeUpdate(props.entry)) return null;

  const startUpdate = async () => {
    if (isStarting || props.disabledReason) return;
    setHasError(false);
    setIsStarting(true);
    props.onPreparingChange(true);
    try {
      const provider = await startReviewedProviderRuntimeAction(controller, "update");
      const startedRuntime = provider.connection?.runtime;
      if (startedRuntime) {
        setLocalRuntimeUpdate({ baseProvider: props.entry.snapshot, value: startedRuntime });
      }
      props.onUpdateStarted(provider);
    } catch {
      setHasError(true);
    } finally {
      props.onPreparingChange(false);
      setIsStarting(false);
    }
  };

  return (
    <ModelPickerProviderUpdateFooter
      displayName={props.entry.displayName}
      driverKind={props.entry.driverKind}
      accentColor={props.entry.accentColor}
      disabled={Boolean(props.disabledReason)}
      {...(props.disabledReason ? { disabledReason: props.disabledReason } : {})}
      isStarting={isStarting}
      isUpdating={activeUpdate !== null}
      hasError={hasError}
      onUpdate={() => void startUpdate()}
    />
  );
}
