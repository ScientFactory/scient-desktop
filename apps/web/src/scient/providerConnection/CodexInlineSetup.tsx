import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import {
  hasExternalCodexUpdate,
  hasManagedCodexUpdate,
  startCodexBrowserSignIn,
  startCodexDeviceSignIn,
  startReviewedCodexRuntimeAction,
  updateCodexRuntime,
} from "./codexLifecycleActions";
import { ProviderRuntimeDiagnosticsDetails } from "./ProviderRuntimeDiagnostics";
import { ProviderAccountManagementLink } from "./ProviderAccountManagementLink";
import { needsManagedRuntimeRecovery } from "./providerConnectionPresentation";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "sign-in"
  | "device-sign-in"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;

const ACTIVE_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
]);

function failureMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.trim().length > 0 ? value.message : fallback;
}

function runtimeStage(operation: ProviderRuntimeOperation | null): string {
  switch (operation?.status) {
    case "preparing":
      return "Preparing the verified download…";
    case "downloading":
      return "Downloading Codex…";
    case "verifying":
      return "Verifying the download…";
    case "installing":
      return "Installing Codex privately…";
    case "testing":
      return "Checking the installation…";
    case "activating":
      return "Finishing setup…";
    default:
      return "Preparing Codex…";
  }
}

function computerLabel(provider: ServerProvider): string {
  const target = provider.connection?.runtime?.target;
  if (target?.startsWith("darwin-")) return "this Mac";
  if (target?.startsWith("win32-")) return "this Windows computer";
  if (target?.startsWith("linux-")) return "this Linux computer";
  return "this computer";
}

export function CodexInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
  }, [props.provider.instanceId]);

  const runtime = props.provider.connection?.runtime;
  const runtimeOperation = runtime?.operation ?? null;
  const activeRuntimeOperation =
    runtimeOperation && ACTIVE_RUNTIME_STATUSES.has(runtimeOperation.status)
      ? runtimeOperation
      : null;
  const connectionOperation = props.provider.connection?.operation ?? null;
  const activeConnectionOperation =
    connectionOperation &&
    !["connected", "cancelled", "failed"].includes(connectionOperation.status)
      ? connectionOperation
      : null;
  const isAuthenticated = props.provider.auth.status === "authenticated";
  const supportsBrowserSignIn =
    props.provider.connection?.methods.includes("codex_browser") ?? false;
  const supportsDeviceSignIn =
    props.provider.connection?.methods.includes("codex_device_code") ?? false;
  const failedSignInMethod =
    connectionOperation?.status === "failed" &&
    (connectionOperation.method === "codex_browser" ||
      connectionOperation.method === "codex_device_code")
      ? connectionOperation.method
      : null;
  const signInMethod =
    failedSignInMethod ??
    (supportsBrowserSignIn ? "codex_browser" : supportsDeviceSignIn ? "codex_device_code" : null);
  const alternateSignInMethod =
    signInMethod === "codex_browser" && supportsDeviceSignIn
      ? "codex_device_code"
      : signInMethod === "codex_device_code" && supportsBrowserSignIn
        ? "codex_browser"
        : null;
  const managedUpdateAvailable =
    !props.managedRuntimePresentedExternally && hasManagedCodexUpdate(props.provider);
  const externalUpdateAvailable = hasExternalCodexUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const needsRuntimeRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

  const install = async () => {
    setLocalError(null);
    setPendingAction("install");
    try {
      await startReviewedCodexRuntimeAction(props.controller, "install");
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not install Codex."));
    } finally {
      setPendingAction(null);
    }
  };

  const update = async () => {
    setLocalError(null);
    setPendingAction("update");
    try {
      await updateCodexRuntime(props.controller, props.provider);
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not update Codex."));
    } finally {
      setPendingAction(null);
    }
  };

  const repair = async () => {
    setLocalError(null);
    setPendingAction("repair");
    try {
      const provider = await startReviewedCodexRuntimeAction(props.controller, "repair");
      if (
        provider.connection?.runtime?.operation?.action === "repair" &&
        provider.connection.runtime.operation.status === "succeeded"
      ) {
        props.onRepairSucceeded?.();
      }
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not repair Codex."));
    } finally {
      setPendingAction(null);
    }
  };

  const canShowInlineRepair =
    !props.managedRuntimePresentedExternally && runtime?.actions.includes("repair");
  const connectedActions =
    canShowInlineRepair || props.accountAction ? (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {canShowInlineRepair ? (
          <Button
            disabled={pendingAction !== null}
            onClick={() => void repair()}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            <RefreshCwIcon aria-hidden /> Repair
          </Button>
        ) : null}
        {props.accountAction}
      </div>
    ) : undefined;

  const cancelRuntime = async () => {
    if (!activeRuntimeOperation) return;
    setLocalError(null);
    setPendingAction("cancel-runtime");
    try {
      await props.controller.cancelRuntime(activeRuntimeOperation.operationId);
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not cancel Codex setup."));
    } finally {
      setPendingAction(null);
    }
  };

  const signIn = async (method: "codex_browser" | "codex_device_code" | null = signInMethod) => {
    if (!method) return;
    setLocalError(null);
    setPendingAction(method === "codex_device_code" ? "device-sign-in" : "sign-in");
    try {
      if (method === "codex_device_code") {
        await startCodexDeviceSignIn(props.controller);
      } else {
        await startCodexBrowserSignIn(props.controller);
      }
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not start Codex sign in."));
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
      setLocalError(failureMessage(error, "Scient could not cancel Codex sign in."));
    } finally {
      setPendingAction(null);
    }
  };

  if (
    activeRuntimeOperation ||
    pendingAction === "install" ||
    pendingAction === "repair" ||
    pendingAction === "update"
  ) {
    const stage = runtimeStage(activeRuntimeOperation);
    const updating = pendingAction === "update" || activeRuntimeOperation?.action === "update";
    const repairing = pendingAction === "repair" || activeRuntimeOperation?.action === "repair";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={stage}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={updating ? "Updating Codex" : repairing ? "Repairing Codex" : "Installing Codex"}
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

  if (needsRuntimeRepair) {
    const error =
      localError ??
      (runtimeOperation?.status === "failed"
        ? runtimeOperation.message
        : (props.provider.message ?? "Codex's private runtime could not start."));
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={error}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Codex needs repair"
        />
        <AssistedSetupActions>
          <Button onClick={() => void repair()} size="sm" type="button">
            <RefreshCwIcon aria-hidden /> Repair Codex
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!props.provider.installed) {
    const error =
      localError ?? (runtimeOperation?.status === "failed" ? runtimeOperation.message : null);
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? `Codex is not installed on ${computerLabel(props.provider)}.`
              : `Assisted installation is not available for ${computerLabel(props.provider)}. You can use an existing Codex installation.`)
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ShieldCheckIcon className="size-5 text-primary" />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? "Codex installation couldn’t finish" : "Install Codex"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button onClick={() => void install()} size="sm" type="button">
              {error ? <RefreshCwIcon aria-hidden /> : null}
              {error ? "Retry installation" : "Install"}
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (
    activeConnectionOperation ||
    pendingAction === "sign-in" ||
    pendingAction === "device-sign-in"
  ) {
    const verifying = activeConnectionOperation?.status === "verifying";
    const usingDeviceCode = activeConnectionOperation?.method === "codex_device_code";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            verifying
              ? "Confirming sign-in with Codex…"
              : usingDeviceCode
                ? "Enter this code on Codex’s secure sign-in page."
                : "Complete sign-in in your browser."
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? "Checking your account" : "Finish signing in"}
        />
        {usingDeviceCode && activeConnectionOperation?.userCode ? (
          <div className="ms-8 flex items-center justify-between gap-3 rounded-md border bg-background/40 px-3 py-2">
            <code className="font-semibold tracking-wider text-foreground">
              {activeConnectionOperation.userCode}
            </code>
            <Button
              aria-label="Copy Codex device code"
              onClick={() => copyToClipboard(activeConnectionOperation.userCode!, undefined)}
              size="icon-sm"
              type="button"
              variant="ghost-muted"
            >
              <CopyIcon aria-hidden />
            </Button>
          </div>
        ) : null}
        {!verifying && activeConnectionOperation?.authorizationUrl ? (
          <AssistedSetupActions>
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
              <ExternalLinkIcon aria-hidden /> Reopen sign-in page
            </Button>
            {activeConnectionOperation ? (
              <Button
                className={DESTRUCTIVE_GHOST_ACTION_CLASS}
                disabled={pendingAction === "cancel-sign-in"}
                onClick={() => void cancelSignIn()}
                size="sm"
                type="button"
                variant="ghost-muted"
              >
                Cancel
              </Button>
            ) : null}
          </AssistedSetupActions>
        ) : activeConnectionOperation ? (
          <AssistedSetupActions>
            <Button
              className={DESTRUCTIVE_GHOST_ACTION_CLASS}
              disabled={pendingAction === "cancel-sign-in"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              Cancel
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (isAuthenticated) {
    if (updateRunning) {
      return (
        <StatusFrame
          accountAction={props.accountAction}
          title="Updating Codex"
          body={updateState?.message ?? "Updating and verifying Codex…"}
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
              error ?? (
                <>
                  Install the reviewed update when you’re ready. Your current version remains
                  available until the update is verified.
                </>
              )
            }
            icon={
              error ? (
                <TriangleAlertIcon className="size-5 text-destructive" />
              ) : (
                <RefreshCwIcon className="size-5 text-primary" />
              )
            }
            role={error ? "alert" : undefined}
            title={error ? "Codex couldn’t be updated" : "Codex update available"}
          />
          <AssistedSetupActions>
            {props.accountAction}
            <Button onClick={() => void update()} size="sm" type="button">
              {error ? "Try again" : "Update"}
            </Button>
          </AssistedSetupActions>
        </SetupFrame>
      );
    }
    return (
      <StatusFrame
        accountAction={connectedActions}
        title="Codex is ready"
        body={
          <>
            Your{" "}
            <ProviderAccountManagementLink provider="codex">
              ChatGPT subscription
            </ProviderAccountManagementLink>{" "}
            is connected.
          </>
        }
      />
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  const canInstallManaged = runtime?.actions.includes("install") ?? false;
  const useManaged = async () => {
    setLocalError(null);
    setPendingAction("install");
    try {
      await startReviewedCodexRuntimeAction(props.controller, "install");
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not switch to managed Codex."));
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          "Sign in with your existing ChatGPT account. The secure flow opens in your browser, and Scient never sees your password."
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ShieldCheckIcon className="size-5 text-primary" />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Codex sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        {alternateSignInMethod ? (
          <Button
            className="text-muted-foreground"
            onClick={() => void signIn(alternateSignInMethod)}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            {alternateSignInMethod === "codex_device_code"
              ? "Use device code"
              : "Use browser sign-in"}
          </Button>
        ) : null}
        <Button onClick={() => void signIn()} size="sm" type="button">
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError
            ? "Try again"
            : signInMethod === "codex_device_code"
              ? "Sign in with device code"
              : "Sign in with ChatGPT"}
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
  readonly title: string;
  readonly body: ReactNode;
  readonly loading?: boolean;
}) {
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={props.body}
        icon={
          props.loading ? (
            <LoaderIcon className="size-5 animate-spin text-primary" />
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
  return <AssistedSetupFrame flow="codex">{props.children}</AssistedSetupFrame>;
}
