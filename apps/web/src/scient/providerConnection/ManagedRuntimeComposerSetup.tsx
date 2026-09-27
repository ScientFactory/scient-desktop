import type {
  EnvironmentId,
  ProviderManagedRuntimeAction,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { Icon } from "../../components/Icons";
import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import { ConnectModelsButton } from "./ConnectModelsButton";
import {
  cancelRuntimeActionLabel,
  failedRuntimeOperationMessage,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  managedRuntimeRepairMessage,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import {
  hasManagedProviderUpdate,
  startReviewedProviderRuntimeAction,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type Pending = "install" | "repair" | "update" | "cancel";

const WORKING_VERBS = {
  install: "Installing",
  repair: "Repairing",
  update: "Updating",
  remove: "Removing",
} satisfies Record<ProviderManagedRuntimeAction, string>;

/**
 * Composer setup for providers whose only Scient-owned lifecycle is a managed
 * runtime and whose models come from the tool itself or from custom model
 * connections. One frame, one next step; runtime management stays in
 * Settings. Mount with `key={provider.instanceId}` so local state resets.
 */
export function ManagedRuntimeComposerSetup(props: {
  readonly controller: ProviderLifecycleController;
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly icon: Icon;
  /** Next step when the runtime starts but reports no usable model. */
  readonly modelSetupHint: string;
  readonly provider: ServerProvider;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const name = props.displayName;
  const runtime = props.provider.connection?.runtime;
  const operation = runtime?.operation ?? null;
  const active = isActiveProviderRuntimeOperation(operation) ? operation : null;
  const failedOperationMessage = operation?.status === "failed" ? operation.message : null;

  const run = async (next: Pending) => {
    setLocalError(null);
    setPending(next);
    try {
      if (next === "cancel") {
        if (active) await props.controller.cancelRuntime(active.operationId);
      } else {
        await startReviewedProviderRuntimeAction(props.controller, next);
      }
    } catch (cause) {
      setLocalError(
        providerLifecycleFailureMessage(
          cause,
          next === "cancel"
            ? `Scient could not cancel ${name} setup.`
            : `Scient could not ${next} ${name}.`,
        ),
      );
    } finally {
      setPending(null);
    }
  };

  /** Models need the tool's own probe, so the entry point waits for it. */
  const connectModels = (appearance: "setup-action" | "setup-secondary") =>
    props.provider.probePending ? null : (
      <AssistedSetupActions>
        <ConnectModelsButton
          appearance={appearance}
          environmentId={props.environmentId}
          instanceId={props.provider.instanceId}
        />
      </AssistedSetupActions>
    );
  const primaryAction = (
    action: Exclude<Pending, "cancel">,
    label: string,
    accessibleName: string,
    icon: ReactNode,
  ) => (
    <AssistedSetupActions>
      <Button
        aria-label={accessibleName}
        onClick={() => void run(action)}
        size="sm"
        type="button"
        variant="ghost-primary"
      >
        {icon}
        {label}
      </Button>
    </AssistedSetupActions>
  );

  if (active || (pending !== null && pending !== "cancel")) {
    const action: ProviderManagedRuntimeAction =
      active?.action ?? (pending === "repair" || pending === "update" ? pending : "install");
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={localError ?? active?.message ?? `Preparing ${name}…`}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          role={localError ? "alert" : "status"}
          title={`${WORKING_VERBS[action]} ${name}`}
        />
        {active ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel(name, action)}
              disabled={pending === "cancel"}
              onClick={() => void run("cancel")}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              {pending === "cancel" ? (
                <LoaderIcon aria-hidden className="animate-spin" />
              ) : (
                <XIcon aria-hidden />
              )}
              Cancel
            </Button>
          </AssistedSetupActions>
        ) : null}
      </AssistedSetupFrame>
    );
  }

  if (needsManagedRuntimeRecovery(props.provider)) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={localError ?? managedRuntimeRepairMessage(props.provider, name)}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={`${name} needs repair`}
        />
        {runtime?.actions.includes("repair")
          ? primaryAction(
              "repair",
              `Repair ${name}`,
              `Repair ${name}`,
              <RefreshCwIcon aria-hidden />,
            )
          : null}
      </AssistedSetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const error = localError ?? failedRuntimeOperationMessage(operation, "install");
    const canInstall = runtime?.actions.includes("install") ?? false;
    const computer = providerRuntimeComputerLabel(props.provider);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? `${name} is not installed on ${computer}.`
              : `Assisted installation is not available for ${computer}. You can use an existing ${name} installation.`)
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? `${name} installation couldn’t finish` : `Install ${name}`}
        />
        {canInstall
          ? primaryAction(
              "install",
              error ? "Retry installation" : "Install",
              error ? `Retry ${name} installation` : `Install ${name}`,
              error ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />,
            )
          : null}
      </AssistedSetupFrame>
    );
  }

  if (props.provider.status !== "ready" || props.provider.models.length === 0) {
    const failed = props.provider.status === "error";
    const ModelIcon = props.icon;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={failed ? (props.provider.message ?? "Refresh to try again.") : props.modelSetupHint}
          icon={
            failed ? (
              <TriangleAlertIcon className="size-5 text-warning" />
            ) : (
              <ModelIcon className="size-5" />
            )
          }
          role={failed ? "alert" : undefined}
          title={failed ? `Could not load ${name} models` : "Connect a model provider"}
        />
        {connectModels("setup-action")}
      </AssistedSetupFrame>
    );
  }

  if (hasManagedProviderUpdate(props.provider)) {
    const error = localError ?? (operation?.action === "update" ? failedOperationMessage : null);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            "Install the reviewed update when you’re ready. Your current version remains available until the update is verified."
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <RefreshCwIcon className="size-5 text-primary" />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? `${name} couldn’t be updated` : `${name} update available`}
        />
        {primaryAction(
          "update",
          error ? "Try again" : "Update",
          error ? `Retry ${name} update` : `Update ${name}`,
          <RefreshCwIcon aria-hidden />,
        )}
        {connectModels("setup-secondary")}
      </AssistedSetupFrame>
    );
  }

  const managed = runtime?.source === "scient_managed";
  const version = (managed ? runtime?.managedVersion : null) ?? props.provider.version;
  const versionSuffix = version ? ` ${version}` : "";
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={
          managed
            ? `Using Scient-managed ${name}${versionSuffix}.`
            : `Using ${name}${versionSuffix} installed on ${providerRuntimeComputerLabel(props.provider)}.`
        }
        icon={<CheckCircle2Icon className="size-5 text-success" />}
        title={`${name} is ready`}
      />
      {connectModels("setup-action")}
    </AssistedSetupFrame>
  );
}
