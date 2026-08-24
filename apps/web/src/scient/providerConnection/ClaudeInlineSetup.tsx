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
} from "./AssistedProviderSetup";
import {
  hasExternalClaudeUpdate,
  hasManagedClaudeUpdate,
  startClaudeSignIn,
  startReviewedClaudeRuntimeAction,
  updateClaudeRuntime,
} from "./claudeLifecycleActions";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import { ProviderAccountManagementLink } from "./ProviderAccountManagementLink";
import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";
import {
  DESTRUCTIVE_GHOST_ACTION_CLASS,
  PRIMARY_GHOST_ACTION_CLASS,
} from "./providerConnectionActionStyles";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "sign-in"
  | "submit-code"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;
type ClaudeSignInMethod = "claude_subscription" | "claude_console";

function runtimeStage(operation: ProviderRuntimeOperation | null): string {
  switch (operation?.status) {
    case "preparing":
      return "Preparing the verified download…";
    case "downloading":
      return "Downloading Claude…";
    case "verifying":
      return "Verifying the download…";
    case "installing":
      return "Installing Claude privately…";
    case "testing":
      return "Checking the installation…";
    case "activating":
      return "Finishing setup…";
    default:
      return "Preparing Claude…";
  }
}

export function ClaudeInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showAuthorizationCode, setShowAuthorizationCode] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }, [props.provider.instanceId]);

  const runtime = props.provider.connection?.runtime;
  const runtimeOperation = runtime?.operation ?? null;
  const activeRuntimeOperation = isActiveProviderRuntimeOperation(runtimeOperation)
    ? runtimeOperation
    : null;
  const connectionOperation = props.provider.connection?.operation ?? null;
  const activeConnectionOperation = isActiveProviderConnectionOperation(connectionOperation)
    ? connectionOperation
    : null;

  useEffect(() => {
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }, [activeConnectionOperation?.operationId]);

  const isAuthenticated = props.provider.auth.status === "authenticated";
  const hasModels = props.provider.models.length > 0;
  const isReady = props.provider.status === "ready" && hasModels;
  const supportsSubscriptionSignIn =
    props.provider.connection?.methods.includes("claude_subscription") ?? false;
  const supportsConsoleSignIn =
    props.provider.connection?.methods.includes("claude_console") ?? false;
  const failedConnectionMethod =
    connectionOperation?.status === "failed" &&
    (connectionOperation.method === "claude_subscription" ||
      connectionOperation.method === "claude_console")
      ? connectionOperation.method
      : null;
  const signInMethod =
    failedConnectionMethod ??
    (supportsSubscriptionSignIn
      ? "claude_subscription"
      : supportsConsoleSignIn
        ? "claude_console"
        : null);
  const alternateSignInMethod =
    signInMethod === "claude_subscription" && supportsConsoleSignIn
      ? "claude_console"
      : signInMethod === "claude_console" && supportsSubscriptionSignIn
        ? "claude_subscription"
        : null;
  const managedUpdateAvailable =
    !props.managedRuntimePresentedExternally && hasManagedClaudeUpdate(props.provider);
  const externalUpdateAvailable = hasExternalClaudeUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const needsRuntimeRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

  const install = async () => {
    setLocalError(null);
    setPendingAction("install");
    try {
      await startReviewedClaudeRuntimeAction(props.controller, "install");
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, "Scient could not install Claude."));
    } finally {
      setPendingAction(null);
    }
  };

  const update = async () => {
    setLocalError(null);
    setPendingAction("update");
    try {
      await updateClaudeRuntime(props.controller, props.provider);
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, "Scient could not update Claude."));
    } finally {
      setPendingAction(null);
    }
  };

  const repair = async () => {
    setLocalError(null);
    setPendingAction("repair");
    try {
      const provider = await startReviewedClaudeRuntimeAction(props.controller, "repair");
      if (
        provider.connection?.runtime?.operation?.action === "repair" &&
        provider.connection.runtime.operation.status === "succeeded"
      ) {
        props.onRepairSucceeded?.();
      }
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, "Scient could not repair Claude."));
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
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not cancel Claude setup."),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const signIn = async (method: ClaudeSignInMethod | null = signInMethod) => {
    if (!method) return;
    setLocalError(null);
    setPendingAction("sign-in");
    try {
      await startClaudeSignIn(props.controller, method);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not start Claude sign in."),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const submitCode = async () => {
    if (!activeConnectionOperation || authorizationCode.trim().length === 0) return;
    const code = authorizationCode;
    setAuthorizationCode("");
    setLocalError(null);
    setPendingAction("submit-code");
    try {
      await props.controller.submitAuthorizationCode(activeConnectionOperation.operationId, code);
      setShowAuthorizationCode(false);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(
          error,
          "Scient could not return the one-time code to Claude.",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const openManualFallback = async () => {
    const authorizationUrl = activeConnectionOperation?.authorizationUrl;
    if (!authorizationUrl) return;
    setLocalError(null);
    try {
      await props.controller.openAuthorizationPage(authorizationUrl);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(
          error,
          "Scient could not open Claude’s fallback sign-in page.",
        ),
      );
    }
  };

  const cancelSignIn = async () => {
    if (!activeConnectionOperation) return;
    setLocalError(null);
    setAuthorizationCode("");
    setPendingAction("cancel-sign-in");
    try {
      await props.controller.cancelConnection(activeConnectionOperation.operationId);
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, "Scient could not cancel Claude sign in."),
      );
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
          title={
            updating ? "Updating Claude" : repairing ? "Repairing Claude" : "Installing Claude"
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

  if (needsRuntimeRepair) {
    const error =
      localError ??
      (runtimeOperation?.status === "failed"
        ? runtimeOperation.message
        : (props.provider.message ?? "Claude's private runtime could not start."));
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={error}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Claude needs repair"
        />
        <AssistedSetupActions>
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            onClick={() => void repair()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden /> Repair Claude
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const error =
      localError ?? (runtimeOperation?.status === "failed" ? runtimeOperation.message : null);
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? `Claude is not installed on ${providerRuntimeComputerLabel(props.provider)}.`
              : `Assisted installation is not available for ${providerRuntimeComputerLabel(props.provider)}. You can use an existing Claude installation.`)
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ShieldCheckIcon className="size-5 text-primary" />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? "Claude installation couldn’t finish" : "Install Claude"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              className={PRIMARY_GHOST_ACTION_CLASS}
              onClick={() => void install()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {error ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {error ? "Retry installation" : "Install Claude"}
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const verifying =
      activeConnectionOperation?.status === "verifying" || pendingAction === "submit-code";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={verifying ? "Finding your available models…" : "Complete sign-in in your browser."}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? "Checking your account" : "Finish signing in"}
        />
        {activeConnectionOperation &&
        activeConnectionOperation.acceptsAuthorizationCode !== false ? (
          <ProviderAuthorizationCodeDisclosure
            authorizationCode={authorizationCode}
            disabled={pendingAction === "submit-code"}
            expanded={showAuthorizationCode}
            onAuthorizationCodeChange={setAuthorizationCode}
            onExpandedChange={setShowAuthorizationCode}
            onSubmit={() => void submitCode()}
            providerName="Claude"
            submitting={pendingAction === "submit-code"}
          />
        ) : null}
        {localError ? (
          <p className="ps-8 text-destructive text-xs" role="alert">
            {localError}
          </p>
        ) : null}
        <AssistedSetupActions>
          {activeConnectionOperation?.authorizationUrl &&
          activeConnectionOperation.authorizationUrlKind === "manual_fallback" ? (
            <Button
              onClick={() => void openManualFallback()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              <ExternalLinkIcon aria-hidden />
              Browser didn’t open?
            </Button>
          ) : null}
          {activeConnectionOperation ? (
            <Button
              className={DESTRUCTIVE_GHOST_ACTION_CLASS}
              disabled={pendingAction === "cancel-sign-in" || pendingAction === "submit-code"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-muted"
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
          accountAction={connectedActions}
          body={
            props.provider.message ??
            (hasModels
              ? "Claude is connected, but its readiness check did not finish."
              : "Claude is connected but did not report an available model.")
          }
          title="Claude needs attention"
          warning
        />
      );
    }
    if (updateRunning) {
      return (
        <StatusFrame
          accountAction={props.accountAction}
          title="Updating Claude"
          body={updateState?.message ?? "Updating and verifying Claude…"}
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
            title={error ? "Claude couldn’t be updated" : "Claude update available"}
          />
          <AssistedSetupActions>
            {props.accountAction}
            <Button
              className={PRIMARY_GHOST_ACTION_CLASS}
              onClick={() => void update()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon aria-hidden /> {error ? "Try again" : "Update Claude"}
            </Button>
          </AssistedSetupActions>
        </SetupFrame>
      );
    }
    const accountLabel = props.provider.auth.label;
    const isSubscriptionAccount = accountLabel?.toLowerCase().includes("subscription") ?? false;
    return (
      <StatusFrame
        accountAction={connectedActions}
        title="Claude is ready"
        body={
          accountLabel && isSubscriptionAccount ? (
            <>
              <ProviderAccountManagementLink provider="claude">
                {accountLabel}
              </ProviderAccountManagementLink>{" "}
              is connected.
            </>
          ) : accountLabel ? (
            `${accountLabel} is connected.`
          ) : (
            "Claude is connected."
          )
        }
      />
    );
  }

  if (props.provider.auth.required === false) {
    return (
      <StatusFrame
        title={isReady ? "Claude is ready" : "Claude needs attention"}
        body={
          isReady
            ? "This Claude setup does not require account sign-in."
            : (props.provider.message ?? "Claude did not report an available model.")
        }
        warning={!isReady}
      />
    );
  }

  if (!signInMethod) {
    return (
      <StatusFrame
        title="Claude needs setup"
        body="Finish configuring this custom Claude provider in Settings."
        warning
      />
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          (signInMethod === "claude_subscription"
            ? "Sign in with your existing Claude subscription. Scient never sees your password."
            : "Connect your Anthropic Console account. Scient never sees your password.")
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ShieldCheckIcon className="size-5 text-primary" />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Claude sign-in didn’t finish" : "Sign in required"}
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
            {alternateSignInMethod === "claude_console"
              ? "Use Anthropic Console"
              : "Use Claude subscription"}
          </Button>
        ) : null}
        <Button
          className={PRIMARY_GHOST_ACTION_CLASS}
          onClick={() => void signIn()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError
            ? "Try sign in again"
            : signInMethod === "claude_subscription"
              ? "Sign in to Claude"
              : "Sign in with Console"}
        </Button>
      </AssistedSetupActions>
    </SetupFrame>
  );
}

function StatusFrame(props: {
  readonly accountAction?: ReactNode;
  readonly title: string;
  readonly body: ReactNode;
  readonly loading?: boolean;
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

function SetupFrame({ children }: { readonly children: ReactNode }) {
  return <AssistedSetupFrame>{children}</AssistedSetupFrame>;
}
