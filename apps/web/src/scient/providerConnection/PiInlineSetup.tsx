import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { DownloadIcon, LoaderIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { PiIcon } from "../../components/Icons";
import { ConnectModelsButton } from "./ConnectModelsButton";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import {
  PRIMARY_GHOST_ACTION_CLASS,
  DESTRUCTIVE_GHOST_ACTION_CLASS,
} from "./providerConnectionActionStyles";
import {
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import { startReviewedProviderRuntimeAction } from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

/** Pi has a managed runtime, but no single provider-owned account flow. */
export function PiInlineSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
  readonly composerController?: ProviderLifecycleController;
}) {
  const presentation = providerSettingsLifecyclePresentation(props.provider, props.displayName);
  const showModelSetup = presentation.kind === "manual";
  if (
    props.composerController &&
    (!isProviderRuntimePresentedAsInstalled(props.provider) ||
      needsManagedRuntimeRecovery(props.provider) ||
      isActiveProviderRuntimeOperation(props.provider.connection?.runtime?.operation))
  ) {
    return (
      <PiComposerRuntimeSetup
        key={props.provider.instanceId}
        provider={props.provider}
        controller={props.composerController}
      />
    );
  }
  return (
    <>
      {!props.managedRuntimePresentedExternally ? (
        <ProviderRuntimeSection
          compact
          environmentId={props.environmentId}
          provider={props.provider}
          displayName={props.displayName}
          onActionSucceeded={(action) => {
            if (action === "repair") props.onRepairSucceeded?.();
          }}
        />
      ) : null}
      {showModelSetup ? (
        <AssistedSetupFrame>
          <AssistedSetupStatus
            icon={<PiIcon className="size-5 text-primary" />}
            title={
              props.provider.status === "error"
                ? "Could not load Pi models"
                : "Connect a model provider"
            }
            body={
              props.provider.status === "error"
                ? (props.provider.message ?? "Refresh to try again.")
                : "Add a custom model, or use /login in Pi for a supported subscription."
            }
          />
        </AssistedSetupFrame>
      ) : null}
      {props.provider.installed && !props.provider.probePending ? (
        <ConnectModelsButton
          environmentId={props.environmentId}
          instanceId={props.provider.instanceId}
        />
      ) : null}
    </>
  );
}

function PiComposerRuntimeSetup(props: {
  readonly provider: ServerProvider;
  readonly controller: ProviderLifecycleController;
}) {
  const [pending, setPending] = useState<"install" | "repair" | "cancel" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const runtime = props.provider.connection?.runtime;
  const operation = runtime?.operation;
  const active = isActiveProviderRuntimeOperation(operation) ? operation : null;
  const repair = needsManagedRuntimeRecovery(props.provider);
  const action = repair ? "repair" : "install";
  const error = localError ?? (operation?.status === "failed" ? operation.message : null);
  const working = Boolean(active) || pending !== null;

  const run = async (next: "install" | "repair" | "cancel") => {
    setLocalError(null);
    setPending(next);
    try {
      if (next === "cancel") {
        if (active) await props.controller.cancelRuntime(active.operationId);
      } else {
        await startReviewedProviderRuntimeAction(props.controller, next);
      }
    } catch (cause) {
      setLocalError(providerLifecycleFailureMessage(cause, "Pi setup could not finish."));
    } finally {
      setPending(null);
    }
  };

  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        icon={
          working ? (
            <LoaderIcon className="size-5 animate-spin text-primary" />
          ) : error ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <PiIcon className="size-5 text-primary" />
          )
        }
        title={
          working
            ? active?.action === "repair" || pending === "repair"
              ? "Repairing Pi"
              : active?.action === "update"
                ? "Updating Pi"
                : "Installing Pi"
            : error
              ? "Pi installation couldn’t finish"
              : repair
                ? "Pi needs repair"
                : "Install Pi"
        }
        body={
          error ??
          (working
            ? (active?.message ?? "Preparing Pi…")
            : runtime?.actions.includes(action)
              ? repair
                ? "Repair Pi to continue."
                : `Pi is not installed on ${providerRuntimeComputerLabel(props.provider)}.`
              : "Use an existing Pi installation on this computer.")
        }
        role={error ? "alert" : working ? "status" : undefined}
      />
      {active ? (
        <AssistedSetupActions>
          <Button
            className={DESTRUCTIVE_GHOST_ACTION_CLASS}
            type="button"
            variant="ghost-muted"
            size="sm"
            disabled={pending === "cancel"}
            onClick={() => void run("cancel")}
          >
            <XIcon aria-hidden /> Cancel
          </Button>
        </AssistedSetupActions>
      ) : !working && runtime?.actions.includes(action) ? (
        <AssistedSetupActions>
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void run(action)}
          >
            {error || repair ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
            {repair ? "Repair Pi" : error ? "Retry installation" : "Install"}
          </Button>
        </AssistedSetupActions>
      ) : null}
    </AssistedSetupFrame>
  );
}
