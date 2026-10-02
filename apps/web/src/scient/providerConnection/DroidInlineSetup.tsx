import type { ProviderRuntimeSummary, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupDiagnostics,
  AssistedSetupFrame,
  AssistedSetupStatus,
  AssistedSetupUpdateButton,
  AssistedSetupUpdateStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import {
  cancelRuntimeActionLabel,
  failedRuntimeOperationMessage,
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  managedRuntimeRepairMessage,
  needsManagedRuntimeRecovery,
  providerAccountIdentity,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import {
  externalProviderUpdate,
  externalProviderUpdateProgress,
  providerUpdateIssue,
  providerUpdateOffer,
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import { resolveProviderRuntimeForPresentation } from "./ProviderRuntimeSection";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "external-update"
  | "sign-in"
  | "check"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;

export function DroidInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  /**
   * Composer only: the model setup entry point. `primary` is the ready
   * frame's one action; `secondary` sits quietly under another frame's.
   */
  readonly modelsActions?: { readonly primary: ReactNode; readonly secondary: ReactNode };
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  /** A status check that could not run; not a failure of the action it follows. */
  const [checkError, setCheckError] = useState<string | null>(null);
  const [localRuntime, setLocalRuntime] = useState<ProviderRuntimeSummary | null>(null);

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setCheckError(null);
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
  const updateOffer = providerUpdateOffer(props.provider, {
    managed: !props.managedRuntimePresentedExternally,
  });
  const externalUpdateProgress = externalProviderUpdateProgress(
    props.provider,
    pendingAction === "external-update",
  );
  // Custom models need Droid itself, not a Factory account.
  const modelsActions =
    props.provider.installed && !props.provider.probePending ? props.modelsActions : undefined;
  const secondaryActions = modelsActions ? (
    <AssistedSetupActions>{modelsActions.secondary}</AssistedSetupActions>
  ) : null;

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

  const update = async () => {
    setLocalError(null);
    setPendingAction(updateOffer?.path === "external" ? "external-update" : "update");
    try {
      const provider = await updateManagedOrExternalProviderRuntime(
        props.controller,
        props.provider,
        "No Droid update is currently available.",
      );
      setLocalRuntime(provider.connection?.runtime ?? null);
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, "Scient could not update Droid."));
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
    setCheckError(null);
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

  /** One full status check: Droid's start, account and models. */
  const checkAgain = async () => {
    setLocalError(null);
    setCheckError(null);
    setPendingAction("check");
    try {
      await props.controller.refresh();
    } catch (error) {
      setCheckError(providerLifecycleFailureMessage(error, "Scient could not check Droid."));
    } finally {
      setPendingAction(null);
    }
  };
  /** `quiet` beside the frame's own primary action. */
  const checkAgainButton = (label: string, quiet = false) => (
    <Button
      aria-label="Check Droid again"
      disabled={pendingAction !== null}
      onClick={() => void checkAgain()}
      size="sm"
      type="button"
      variant={quiet ? "ghost-muted" : "ghost-primary"}
    >
      {pendingAction === "check" ? (
        <LoaderIcon aria-hidden className="animate-spin" />
      ) : (
        <RefreshCwIcon aria-hidden />
      )}
      {label}
    </Button>
  );

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

  const runtimeDiagnostics = (
    <AssistedSetupDiagnostics
      displayName={props.displayName}
      presentedExternally={props.managedRuntimePresentedExternally}
      provider={props.provider}
    />
  );
  if (
    activeRuntimeOperation ||
    pendingAction === "install" ||
    pendingAction === "repair" ||
    pendingAction === "update"
  ) {
    const action = activeRuntimeOperation?.action ?? pendingAction ?? "install";
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={activeRuntimeOperation?.message ?? "Preparing the private Droid runtime…"}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            action === "update"
              ? "Updating Droid"
              : action === "repair"
                ? "Repairing Droid"
                : "Installing Droid"
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel("Droid", activeRuntimeOperation.action)}
              disabled={pendingAction === "cancel-runtime"}
              onClick={() => void cancelRuntime()}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
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
      </AssistedSetupFrame>
    );
  }

  if (externalUpdateProgress) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupUpdateStatus
          name="Droid"
          provider={props.provider}
          trailing={props.accountAction}
          update={externalProviderUpdate(props.provider)}
          working={externalUpdateProgress}
        />
      </AssistedSetupFrame>
    );
  }

  if (needsRepair) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            checkError ??
            localError ??
            managedRuntimeRepairMessage(props.provider, "Droid", runtimeOperation)
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Droid needs repair"
        />
        <AssistedSetupActions>
          {/* A start that failed once may work again; Droid is only re-checked on request. */}
          {checkAgainButton("Try again", true)}
          <Button
            disabled={pendingAction === "check"}
            onClick={() => void runRuntime("repair")}
            size="sm"
            type="button"
            variant="ghost-primary"
          >
            <RefreshCwIcon aria-hidden /> Repair Droid
          </Button>
        </AssistedSetupActions>
        {runtimeDiagnostics}
      </AssistedSetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const installationError =
      localError ?? failedRuntimeOperationMessage(runtimeOperation, "install");
    return (
      <AssistedSetupFrame>
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
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={installationError ? "alert" : undefined}
          title={installationError ? "Droid installation couldn’t finish" : "Install Droid"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={installationError ? "Retry installation of Droid" : "Install Droid"}
              onClick={() => void runRuntime("install")}
              size="sm"
              type="button"
              variant="ghost-primary"
            >
              {installationError ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {installationError ? "Retry installation" : "Install"}
            </Button>
          </AssistedSetupActions>
        ) : null}
        {installationError ? runtimeDiagnostics : null}
      </AssistedSetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const starting = pendingAction === "sign-in" && !activeConnectionOperation;
    const verifying = activeConnectionOperation?.status === "verifying";
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            starting
              ? "Checking Droid and preparing Factory sign in…"
              : verifying
                ? "Confirming your Factory account…"
                : "Complete Factory sign in in the browser opened by Droid."
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={starting ? "Starting sign in" : verifying ? "Verifying sign in" : "Finish sign in"}
        />
        {activeConnectionOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label="Cancel Droid sign-in"
              disabled={pendingAction === "cancel-sign-in"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
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
      </AssistedSetupFrame>
    );
  }

  if (isAuthenticated && isReady && updateOffer) {
    const issue = providerUpdateIssue(props.provider, updateOffer, localError);
    return (
      <AssistedSetupFrame>
        <AssistedSetupUpdateStatus
          issue={issue}
          name="Droid"
          provider={props.provider}
          update={updateOffer}
        />
        <AssistedSetupActions>
          {props.accountAction}
          <AssistedSetupUpdateButton
            name="Droid"
            onClick={() => void update()}
            retry={issue !== null}
          />
        </AssistedSetupActions>
        {secondaryActions}
        {issue ? runtimeDiagnostics : null}
      </AssistedSetupFrame>
    );
  }

  if (isAuthenticated) {
    return (
      <AssistedSetupFrame>
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
        {modelsActions ? (
          <AssistedSetupActions>{modelsActions.primary}</AssistedSetupActions>
        ) : null}
        {isReady ? null : runtimeDiagnostics}
      </AssistedSetupFrame>
    );
  }

  const canInstallManaged =
    !props.managedRuntimePresentedExternally && (runtime?.actions.includes("install") ?? false);
  if (props.provider.status === "error") {
    // The status check itself failed: Droid did not start, so there is no
    // account state to act on. A Scient-managed runtime is repaired above.
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            checkError ?? localError ?? props.provider.message ?? "Scient could not start Droid."
          }
          icon={<TriangleAlertIcon className="size-5 text-destructive" />}
          role="alert"
          title="Droid couldn’t start"
        />
        <AssistedSetupActions>
          {checkAgainButton("Try again", updateOffer !== null)}
          {updateOffer ? (
            <AssistedSetupUpdateButton name="Droid" onClick={() => void update()} retry={false} />
          ) : null}
        </AssistedSetupActions>
        {secondaryActions}
        <AssistedSetupDiagnostics
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={canInstallManaged ? () => void runRuntime("install") : undefined}
          presentedExternally={props.managedRuntimePresentedExternally}
          provider={props.provider}
        />
      </AssistedSetupFrame>
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  if (!supportsDevicePairing) {
    // With FACTORY_API_KEY the account is the environment's key: no sign-in replaces it.
    const usesApiKey = props.provider.auth.type === "apiKey";
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            checkError ??
            signInError ??
            props.provider.message ??
            "Assisted sign in is unavailable."
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role={(checkError ?? signInError) ? "alert" : undefined}
          title={usesApiKey ? "Factory rejected the API key" : "Assisted sign in unavailable"}
        />
        <AssistedSetupActions>{checkAgainButton("Check again")}</AssistedSetupActions>
        {secondaryActions}
        {runtimeDiagnostics}
      </AssistedSetupFrame>
    );
  }

  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={
          checkError ??
          signInError ??
          "Sign in with your existing Factory subscription. Droid owns the secure flow; Scient never sees your password."
        }
        icon={
          (checkError ?? signInError) ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={(checkError ?? signInError) ? "alert" : undefined}
        title={signInError ? "Droid sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        {/* A sign-in finished outside Scient shows only after a status check. */}
        {checkAgainButton("Check again", true)}
        <Button
          aria-label={signInError ? "Try again to sign in to Droid" : undefined}
          disabled={pendingAction === "check"}
          onClick={() => void signIn()}
          size="sm"
          type="button"
          variant="ghost-primary"
        >
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError ? "Try sign in again" : "Sign in with Factory"}
        </Button>
      </AssistedSetupActions>
      {secondaryActions}
      {signInError && !props.managedRuntimePresentedExternally ? (
        <AssistedSetupDiagnostics
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={canInstallManaged ? () => void runRuntime("install") : undefined}
          provider={props.provider}
        />
      ) : null}
    </AssistedSetupFrame>
  );
}
