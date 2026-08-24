import type { ProviderRuntimeSummary, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { DroidIcon } from "../../components/Icons";
import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
  providerAccountIdentity,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import { startReviewedProviderRuntimeAction } from "./providerLifecycleActions";
import { resolveProviderRuntimeForPresentation } from "./ProviderRuntimeSection";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction = "install" | "repair" | "sign-in" | "cancel-runtime" | "cancel-sign-in" | null;

export function DroidInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localRuntime, setLocalRuntime] = useState<ProviderRuntimeSummary | null>(null);

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setLocalRuntime(null);
  }, [props.provider.instanceId]);

  const serverRuntime = props.provider.connection?.runtime;
  const runtime = resolveProviderRuntimeForPresentation(serverRuntime, localRuntime);
  const runtimeOperation = runtime?.operation ?? null;
  const activeRuntimeOperation = isActiveProviderRuntimeOperation(runtimeOperation)
    ? runtimeOperation
    : null;
  const connectionOperation = props.provider.connection?.operation ?? null;
  const activeConnectionOperation = isActiveProviderConnectionOperation(connectionOperation)
    ? connectionOperation
    : null;
  const supportsDevicePairing =
    props.provider.connection?.methods.includes("droid_device_pairing") ?? false;
  const isAuthenticated = props.provider.auth.status === "authenticated";
  const isReady =
    props.provider.status === "ready" && isAuthenticated && props.provider.models.length > 0;
  const needsRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

  useEffect(() => {
    const localOperation = localRuntime?.operation;
    if (!localOperation || !serverRuntime) return;
    const serverCaughtUp = serverRuntime.operation?.operationId === localOperation.operationId;
    const installFinished =
      localOperation.action === "install" && serverRuntime.source === "scient_managed";
    if (serverCaughtUp || installFinished) setLocalRuntime(null);
  }, [localRuntime, serverRuntime]);

  const runRuntime = async (action: "install" | "repair") => {
    setLocalError(null);
    setPendingAction(action);
    try {
      const provider = await startReviewedProviderRuntimeAction(props.controller, action);
      setLocalRuntime(provider.connection?.runtime ?? null);
      if (
        action === "repair" &&
        provider.connection?.runtime?.operation?.action === "repair" &&
        provider.connection.runtime.operation.status === "succeeded"
      ) {
        props.onRepairSucceeded?.();
      }
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, `Scient could not ${action} Droid.`));
    } finally {
      setPendingAction(null);
    }
  };

  const cancelRuntime = async () => {
    if (!activeRuntimeOperation) return;
    setLocalError(null);
    setPendingAction("cancel-runtime");
    try {
      await props.controller.cancelRuntime(activeRuntimeOperation.operationId);
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, "Scient could not cancel Droid setup."));
    } finally {
      setPendingAction(null);
    }
  };

  const signIn = async () => {
    if (!supportsDevicePairing) return;
    setLocalError(null);
    setPendingAction("sign-in");
    try {
      await props.controller.startConnection("droid_device_pairing");
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not start Droid sign in."),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const cancelSignIn = async () => {
    if (!activeConnectionOperation) return;
    setLocalError(null);
    setPendingAction("cancel-sign-in");
    try {
      await props.controller.cancelConnection(activeConnectionOperation.operationId);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not cancel Droid sign in."),
      );
    } finally {
      setPendingAction(null);
    }
  };

  if (activeRuntimeOperation || pendingAction === "install" || pendingAction === "repair") {
    const repairing = pendingAction === "repair" || activeRuntimeOperation?.action === "repair";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={activeRuntimeOperation?.message ?? "Preparing the private Droid runtime…"}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            <DroidLoadingTitle>
              {repairing ? "Repairing Droid" : "Installing Droid"}
            </DroidLoadingTitle>
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              className={DESTRUCTIVE_GHOST_ACTION_CLASS}
              disabled={pendingAction === "cancel-runtime"}
              onClick={() => void cancelRuntime()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              {pendingAction === "cancel-runtime" ? (
                <LoaderIcon aria-hidden className="animate-spin" />
              ) : (
                <XIcon aria-hidden />
              )}
              Cancel
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (needsRepair) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            localError ?? runtimeOperation?.message ?? "Droid’s private runtime could not start."
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Droid needs repair"
        />
        <AssistedSetupActions>
          <Button onClick={() => void runRuntime("repair")} size="sm" type="button">
            <RefreshCwIcon aria-hidden /> Repair Droid
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const installationError =
      localError ?? (runtimeOperation?.status === "failed" ? runtimeOperation.message : null);
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            installationError ??
            (canInstall
              ? "Scient can install a reviewed Factory Droid runtime privately for this app."
              : (props.provider.message ?? "Install Droid to continue."))
          }
          icon={
            installationError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ShieldCheckIcon className="size-5 text-primary" />
            )
          }
          role={installationError ? "alert" : undefined}
          title={installationError ? "Droid installation couldn’t finish" : "Install Droid"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button onClick={() => void runRuntime("install")} size="sm" type="button">
              {installationError ? <RefreshCwIcon aria-hidden /> : null}
              {installationError ? "Retry installation" : "Install"}
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const starting = pendingAction === "sign-in" && !activeConnectionOperation;
    const verifying = activeConnectionOperation?.status === "verifying";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            starting
              ? "Checking Droid and preparing Factory sign in…"
              : verifying
                ? "Confirming your Factory account…"
                : "Complete Factory sign in in the browser opened by Droid."
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            <DroidLoadingTitle>
              {starting ? "Starting sign in" : verifying ? "Verifying sign in" : "Finish sign in"}
            </DroidLoadingTitle>
          }
        />
        {activeConnectionOperation ? (
          <AssistedSetupActions>
            <Button
              className={DESTRUCTIVE_GHOST_ACTION_CLASS}
              disabled={pendingAction === "cancel-sign-in"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              {pendingAction === "cancel-sign-in" ? (
                <LoaderIcon aria-hidden className="animate-spin" />
              ) : (
                <XIcon aria-hidden />
              )}
              Cancel sign in
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (isAuthenticated) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            isReady
              ? (providerAccountIdentity(props.provider) ?? "Factory account")
              : (props.provider.message ?? "Your Factory account is connected.")
          }
          icon={
            isReady ? (
              <CheckCircle2Icon className="size-5 text-success" />
            ) : (
              <TriangleAlertIcon className="size-5 text-warning" />
            )
          }
          title={isReady ? "Droid is ready" : "Droid needs attention"}
          trailing={props.accountAction}
        />
      </SetupFrame>
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  if (!supportsDevicePairing) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={signInError ?? props.provider.message ?? "Assisted sign in is unavailable."}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role={signInError ? "alert" : undefined}
          title="Assisted sign in unavailable"
        />
      </SetupFrame>
    );
  }

  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          "Sign in with your existing Factory subscription. Droid owns the secure flow; Scient never sees your password."
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ShieldCheckIcon className="size-5 text-primary" />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Droid sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        <Button onClick={() => void signIn()} size="sm" type="button">
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError ? "Try sign in again" : "Sign in with Factory"}
        </Button>
      </AssistedSetupActions>
    </SetupFrame>
  );
}

function SetupFrame(props: { readonly children: ReactNode }) {
  return (
    <AssistedSetupFrame>
      <DroidIcon
        aria-hidden
        className="hidden size-8 shrink-0 in-[[data-model-picker-content=true]]:block"
        data-droid-provider-mark="true"
      />
      <div className="contents in-[[data-model-picker-content=true]]:[&_[data-assisted-setup-icon=true]]:hidden">
        {props.children}
      </div>
    </AssistedSetupFrame>
  );
}

function DroidLoadingTitle(props: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <LoaderIcon className="hidden size-3.5 animate-spin text-primary in-[[data-model-picker-content=true]]:block" />
      {props.children}
    </span>
  );
}
