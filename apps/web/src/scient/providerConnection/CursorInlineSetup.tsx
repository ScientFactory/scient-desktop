import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import {
  hasExternalCursorUpdate,
  hasManagedCursorUpdate,
  startCursorBrowserSignIn,
  startReviewedCursorRuntimeAction,
  updateCursorRuntime,
} from "./cursorLifecycleActions";
import {
  currentOptimisticProviderValue,
  isManagedRuntimeActionDurablySettled,
  type OptimisticProviderValue,
} from "./optimisticProviderValue";
import {
  cancelRuntimeActionLabel,
  failedRuntimeOperationMessage,
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  managedRuntimeRepairMessage,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import { ProviderRuntimeDiagnosticsDetails } from "./ProviderRuntimeDiagnostics";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "sign-in"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;

function runtimeStage(operation: ProviderRuntimeOperation | null): string {
  const message = operation?.message.trim();
  return message && message.length > 0 ? message : "Preparing Cursor…";
}

function accountDescription(provider: ServerProvider): string {
  const email = provider.auth.email?.trim();
  const label = provider.auth.label?.trim();
  if (email && label) return `${email} · ${label}`;
  return email ?? label ?? "Your Cursor account is connected.";
}

export function CursorInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [optimisticRuntimeOperation, setOptimisticRuntimeOperation] =
    useState<OptimisticProviderValue<ProviderRuntimeOperation> | null>(null);

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setOptimisticRuntimeOperation(null);
  }, [props.provider.instanceId]);

  const runtime = props.provider.connection?.runtime;
  const serverRuntimeOperation = runtime?.operation ?? null;

  useEffect(() => {
    // Errors belong to the lifecycle state that produced them. In particular,
    // a late runtime-cancel failure must not survive installation and be
    // relabelled as a Cursor sign-in failure on the next screen.
    setLocalError(null);
  }, [
    props.provider.auth.status,
    props.provider.installed,
    runtime?.operation?.operationId,
    runtime?.operation?.status,
    runtime?.source,
  ]);

  // The start command returns before the provider-status stream publishes the
  // operation, so bridge that brief gap locally. The first new provider
  // snapshot is authoritative even when a fast operation has already settled
  // and its operation id is no longer present.
  const currentOptimisticRuntimeOperation = currentOptimisticProviderValue(
    optimisticRuntimeOperation,
    props.provider,
  );
  const optimisticRuntimeOperationIsSettled =
    runtime &&
    currentOptimisticRuntimeOperation &&
    isManagedRuntimeActionDurablySettled(currentOptimisticRuntimeOperation.action, runtime);
  const runtimeOperation =
    serverRuntimeOperation ??
    (optimisticRuntimeOperationIsSettled ? null : currentOptimisticRuntimeOperation);
  const activeRuntimeOperation = isActiveProviderRuntimeOperation(runtimeOperation)
    ? runtimeOperation
    : null;
  const connectionOperation = props.provider.connection?.operation ?? null;
  const activeConnectionOperation = isActiveProviderConnectionOperation(connectionOperation)
    ? connectionOperation
    : null;
  const isAuthenticated = props.provider.auth.status === "authenticated";
  const hasModels = props.provider.models.length > 0;
  const isReady = props.provider.status === "ready" && hasModels;
  const supportsBrowserSignIn =
    props.provider.connection?.methods.includes("cursor_browser") ?? false;
  const managedUpdateAvailable =
    !props.managedRuntimePresentedExternally && hasManagedCursorUpdate(props.provider);
  const externalUpdateAvailable = hasExternalCursorUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const needsRuntimeRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

  const run = async (
    action: Exclude<PendingAction, null>,
    operation: () => Promise<ServerProvider>,
    fallback: string,
    syncRuntimeOperation = false,
  ) => {
    setLocalError(null);
    setPendingAction(action);
    try {
      const provider = await operation();
      if (syncRuntimeOperation) {
        const nextOperation = provider.connection?.runtime?.operation ?? null;
        setOptimisticRuntimeOperation(
          nextOperation && isActiveProviderRuntimeOperation(nextOperation)
            ? { baseProvider: props.provider, value: nextOperation }
            : null,
        );
      }
      return provider;
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, fallback));
      return undefined;
    } finally {
      setPendingAction(null);
    }
  };

  const install = () =>
    run(
      "install",
      () => startReviewedCursorRuntimeAction(props.controller, "install"),
      "Scient could not install Cursor.",
      true,
    );
  const update = () =>
    run(
      "update",
      () => updateCursorRuntime(props.controller, props.provider),
      "Scient could not update Cursor.",
      true,
    );
  const repair = async () => {
    const provider = await run(
      "repair",
      () => startReviewedCursorRuntimeAction(props.controller, "repair"),
      "Scient could not repair Cursor.",
      true,
    );
    if (
      provider?.connection?.runtime?.operation?.action === "repair" &&
      provider.connection.runtime.operation.status === "succeeded"
    ) {
      props.onRepairSucceeded?.();
    }
  };

  const cancelRuntime = async () => {
    if (!activeRuntimeOperation) return;
    await run(
      "cancel-runtime",
      () => props.controller.cancelRuntime(activeRuntimeOperation.operationId),
      "Scient could not cancel Cursor setup.",
    );
  };

  const signIn = () =>
    run(
      "sign-in",
      () => startCursorBrowserSignIn(props.controller),
      "Scient could not start Cursor sign in.",
    );

  const cancelSignIn = async () => {
    if (!activeConnectionOperation) return;
    await run(
      "cancel-sign-in",
      () => props.controller.cancelConnection(activeConnectionOperation.operationId),
      "Scient could not cancel Cursor sign in.",
    );
  };

  if (
    activeRuntimeOperation ||
    pendingAction === "install" ||
    pendingAction === "repair" ||
    pendingAction === "update"
  ) {
    const action =
      activeRuntimeOperation?.action ??
      (pendingAction === "repair" || pendingAction === "update" ? pendingAction : "install");
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={runtimeStage(activeRuntimeOperation)}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            action === "update"
              ? "Updating Cursor"
              : action === "repair"
                ? "Repairing Cursor"
                : "Installing Cursor"
          }
        />
        <AssistedSetupActions>
          <Button
            aria-label={cancelRuntimeActionLabel("Cursor", action)}
            disabled={!activeRuntimeOperation || pendingAction === "cancel-runtime"}
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
      </SetupFrame>
    );
  }

  if (needsRuntimeRepair) {
    const error =
      localError ?? managedRuntimeRepairMessage(props.provider, "Cursor", runtimeOperation);
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={error}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Cursor needs repair"
        />
        <AssistedSetupActions>
          <Button onClick={() => void repair()} size="sm" type="button" variant="ghost-primary">
            <RefreshCwIcon aria-hidden /> Repair Cursor
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const error = localError ?? failedRuntimeOperationMessage(runtimeOperation, "install");
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? `Cursor is not installed on ${providerRuntimeComputerLabel(props.provider)}.`
              : `Assisted installation is not available for ${providerRuntimeComputerLabel(props.provider)}. You can use an existing Cursor installation.`)
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? "Cursor installation couldn’t finish" : "Install Cursor"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={error ? "Retry Cursor installation" : "Install Cursor"}
              onClick={() => void install()}
              size="sm"
              type="button"
              variant="ghost-primary"
            >
              {error ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {error ? "Retry installation" : "Install"}
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const verifying = activeConnectionOperation?.status === "verifying";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            verifying ? "Finding models for your account…" : "Complete sign-in in your browser."
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? "Checking your account" : "Finish signing in"}
        />
        <AssistedSetupActions>
          {!verifying && activeConnectionOperation?.authorizationUrl ? (
            <Button
              onClick={() =>
                void props.controller.openAuthorizationPage(
                  activeConnectionOperation.authorizationUrl!,
                )
              }
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              <ExternalLinkIcon aria-hidden /> Reopen Cursor sign-in
            </Button>
          ) : null}
          {activeConnectionOperation ? (
            <Button
              aria-label="Cancel Cursor sign-in"
              disabled={pendingAction === "cancel-sign-in"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              Cancel
            </Button>
          ) : null}
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (isAuthenticated) {
    if (!isReady) {
      return (
        <StatusFrame
          accountAction={props.accountAction}
          body={
            props.provider.message ??
            (hasModels
              ? "Cursor is connected, but its readiness check did not finish."
              : "Cursor is connected but did not report an available model.")
          }
          title="Cursor needs attention"
          warning
        />
      );
    }
    if (updateRunning) {
      return (
        <StatusFrame
          accountAction={props.accountAction}
          body={updateState?.message ?? "Updating and verifying Cursor…"}
          title="Updating Cursor"
          loading
        />
      );
    }
    if (updateAvailable) {
      const error = localError ?? (updateState?.status === "failed" ? updateState.message : null);
      return (
        <SetupFrame>
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
            title={error ? "Cursor couldn’t be updated" : "Cursor update available"}
          />
          <AssistedSetupActions>
            {props.accountAction}
            <Button
              aria-label={error ? "Retry Cursor update" : "Update Cursor"}
              onClick={() => void update()}
              size="sm"
              type="button"
              variant="ghost-primary"
            >
              <RefreshCwIcon aria-hidden /> {error ? "Try again" : "Update"}
            </Button>
          </AssistedSetupActions>
        </SetupFrame>
      );
    }
    return (
      <StatusFrame
        accountAction={props.accountAction}
        body={accountDescription(props.provider)}
        title="Cursor is ready"
      />
    );
  }

  if (props.provider.auth.required === false) {
    return (
      <StatusFrame
        body={
          isReady
            ? "This Cursor setup does not require account sign-in."
            : (props.provider.message ?? "Cursor did not report an available model.")
        }
        title={isReady ? "Cursor is ready" : "Cursor needs attention"}
        warning={!isReady}
      />
    );
  }

  if (!supportsBrowserSignIn) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body="This Cursor instance uses external credentials or custom settings. Manage them in provider Settings."
          icon={<ShieldCheckIcon className="size-5 text-primary" />}
          title="Custom Cursor setup"
        />
        <div className="flex justify-end">
          <ProviderRuntimeDiagnosticsDetails
            displayName={props.displayName}
            provider={props.provider}
          />
        </div>
      </SetupFrame>
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  const canInstallManaged =
    !props.managedRuntimePresentedExternally && (runtime?.actions.includes("install") ?? false);
  const useManaged = () =>
    run(
      "install",
      () => startReviewedCursorRuntimeAction(props.controller, "install"),
      "Scient could not switch to managed Cursor.",
      true,
    );
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          "Sign in with your existing Cursor subscription. Scient never sees your password."
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Cursor sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        <Button
          aria-label={signInError ? "Retry Cursor sign-in" : undefined}
          onClick={() => void signIn()}
          size="sm"
          type="button"
          variant="ghost-primary"
        >
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError ? "Try again" : "Sign in to Cursor"}
        </Button>
      </AssistedSetupActions>
      <div className="flex justify-end">
        <ProviderRuntimeDiagnosticsDetails
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={canInstallManaged ? () => void useManaged() : undefined}
          provider={props.provider}
        />
      </div>
    </SetupFrame>
  );
}

function StatusFrame(props: {
  readonly accountAction?: ReactNode;
  readonly body: ReactNode;
  readonly loading?: boolean;
  readonly title: string;
  readonly warning?: boolean;
}) {
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={props.body}
        icon={
          props.loading ? (
            <LoaderIcon className="size-5 animate-spin text-primary" />
          ) : props.warning ? (
            <TriangleAlertIcon className="size-5 text-warning" />
          ) : (
            <CheckCircle2Icon className="size-5 text-success" />
          )
        }
        title={props.title}
        trailing={props.accountAction}
      />
    </SetupFrame>
  );
}

function SetupFrame(props: { readonly children: ReactNode }) {
  return <AssistedSetupFrame>{props.children}</AssistedSetupFrame>;
}
