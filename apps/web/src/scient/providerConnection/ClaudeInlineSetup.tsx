import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupDiagnostics,
  AssistedSetupFrame,
  AssistedSetupStatusFrame,
  AssistedSetupStatus,
  AssistedSetupUpdateButton,
  AssistedSetupUpdateStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import {
  startClaudeSignIn,
  startReviewedClaudeRuntimeAction,
  updateClaudeRuntime,
} from "./claudeLifecycleActions";
import {
  externalProviderUpdate,
  externalProviderUpdateProgress,
  providerUpdateIssue,
  providerUpdateOffer,
} from "./providerLifecycleActions";
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
import { ProviderAccountManagementLink } from "./ProviderAccountManagementLink";
import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";
import { m, type MessageResolver } from "~/i18n/messages";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "external-update"
  | "sign-in"
  | "submit-code"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;
type ClaudeSignInMethod = "claude_subscription" | "claude_console";

function runtimeStage(
  operation: ProviderRuntimeOperation | null,
  resolve: MessageResolver = m,
): string {
  switch (operation?.status) {
    case "preparing":
      return resolve(msg("Preparing the verified download…"));
    case "downloading":
      return resolve(msg("Downloading Claude…"));
    case "verifying":
      return resolve(msg("Verifying the download…"));
    case "installing":
      return resolve(msg("Installing Claude privately…"));
    case "testing":
      return resolve(msg("Checking the installation…"));
    case "activating":
      return resolve(msg("Finishing setup…"));
    default:
      return resolve(msg("Preparing Claude…"));
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
  const gt = useGT();
  const messages = useMessages();
  const [showAuthorizationCode, setShowAuthorizationCode] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");

  const [previousInstanceId, setPreviousInstanceId] = useState(props.provider.instanceId);
  if (previousInstanceId !== props.provider.instanceId) {
    setPreviousInstanceId(props.provider.instanceId);
    setPendingAction(null);
    setLocalError(null);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }

  const runtime = props.provider.connection?.runtime;
  const runtimeOperation = runtime?.operation ?? null;
  const activeRuntimeOperation = isActiveProviderRuntimeOperation(runtimeOperation)
    ? runtimeOperation
    : null;
  const connectionOperation = props.provider.connection?.operation ?? null;
  const activeConnectionOperation = isActiveProviderConnectionOperation(connectionOperation)
    ? connectionOperation
    : null;

  const [previousOperationId, setPreviousOperationId] = useState(
    activeConnectionOperation?.operationId,
  );
  if (previousOperationId !== activeConnectionOperation?.operationId) {
    setPreviousOperationId(activeConnectionOperation?.operationId);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }

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
  const updateOffer = providerUpdateOffer(props.provider, {
    managed: !props.managedRuntimePresentedExternally,
  });
  const externalUpdateProgress = externalProviderUpdateProgress(
    props.provider,
    pendingAction === "external-update",
  );
  const needsRuntimeRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

  const install = async () => {
    setLocalError(null);
    setPendingAction("install");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await startReviewedClaudeRuntimeAction(props.controller, "install");
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not install Claude.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const update = async () => {
    setLocalError(null);
    setPendingAction(updateOffer?.path === "external" ? "external-update" : "update");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await updateClaudeRuntime(props.controller, props.provider);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not update Claude.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const repair = async () => {
    setLocalError(null);
    setPendingAction("repair");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        const provider = await startReviewedClaudeRuntimeAction(props.controller, "repair");
        if (
          provider.connection?.runtime?.operation?.action === "repair" &&
          provider.connection.runtime.operation.status === "succeeded"
        ) {
          props.onRepairSucceeded?.();
        }
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not repair Claude.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const cancelRuntime = async () => {
    if (!activeRuntimeOperation) return;
    setLocalError(null);
    setPendingAction("cancel-runtime");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await props.controller.cancelRuntime(activeRuntimeOperation.operationId);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not cancel Claude setup.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const signIn = async (method: ClaudeSignInMethod | null = signInMethod) => {
    if (!method) return;
    setLocalError(null);
    setPendingAction("sign-in");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await startClaudeSignIn(props.controller, method);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not start Claude sign in.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const submitCode = async () => {
    if (!activeConnectionOperation || authorizationCode.trim().length === 0) return;
    const code = authorizationCode;
    setAuthorizationCode("");
    setLocalError(null);
    setPendingAction("submit-code");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await props.controller.submitAuthorizationCode(activeConnectionOperation.operationId, code);
        setShowAuthorizationCode(false);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(
            error,
            gt("Scient could not return the one-time code to Claude."),
          ),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
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
          gt("Scient could not open Claude’s fallback sign-in page."),
        ),
      );
    }
  };

  const cancelSignIn = async () => {
    if (!activeConnectionOperation) return;
    setLocalError(null);
    setAuthorizationCode("");
    setPendingAction("cancel-sign-in");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await props.controller.cancelConnection(activeConnectionOperation.operationId);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not cancel Claude sign in.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
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
    const stage = runtimeStage(activeRuntimeOperation, messages);
    const updating = pendingAction === "update" || activeRuntimeOperation?.action === "update";
    const repairing = pendingAction === "repair" || activeRuntimeOperation?.action === "repair";
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={stage}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            updating
              ? gt("Updating Claude")
              : repairing
                ? gt("Repairing Claude")
                : gt("Installing Claude")
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel(
                "Claude",
                activeRuntimeOperation.action,
                messages,
              )}
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
              <T>Cancel</T>
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
          name="Claude"
          provider={props.provider}
          trailing={props.accountAction}
          update={externalProviderUpdate(props.provider)}
          working={externalUpdateProgress}
        />
      </AssistedSetupFrame>
    );
  }

  if (needsRuntimeRepair) {
    const error =
      localError ?? managedRuntimeRepairMessage(props.provider, "Claude", undefined, messages);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={error}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("Claude needs repair")}
        />
        <AssistedSetupActions>
          <Button onClick={() => void repair()} size="sm" type="button" variant="ghost-primary">
            <RefreshCwIcon aria-hidden /> <T>Repair Claude</T>
          </Button>
        </AssistedSetupActions>
        {runtimeDiagnostics}
      </AssistedSetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const error = localError ?? failedRuntimeOperationMessage(runtimeOperation, "install");
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            error ??
            (canInstall
              ? gt("Claude is not installed on {computer}.", {
                  computer: providerRuntimeComputerLabel(props.provider, messages),
                })
              : gt(
                  "Assisted installation is not available for {computer}. You can use an existing Claude installation.",
                  { computer: providerRuntimeComputerLabel(props.provider, messages) },
                ))
          }
          icon={
            error ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={error ? "alert" : undefined}
          title={error ? gt("Claude installation couldn’t finish") : gt("Install Claude")}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={error ? gt("Retry installation of Claude") : gt("Install Claude")}
              onClick={() => void install()}
              size="sm"
              type="button"
              variant="ghost-primary"
            >
              {error ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {error ? gt("Retry installation") : gt("Install")}
            </Button>
          </AssistedSetupActions>
        ) : null}
        {error ? runtimeDiagnostics : null}
      </AssistedSetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const verifying =
      activeConnectionOperation?.status === "verifying" || pendingAction === "submit-code";
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            verifying
              ? gt("Finding your available models…")
              : gt("Complete sign-in in your browser.")
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? gt("Checking your account") : gt("Finish signing in")}
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
              <T>Browser didn’t open?</T>
            </Button>
          ) : null}
          {activeConnectionOperation ? (
            <Button
              aria-label={gt("Cancel Claude sign-in")}
              disabled={pendingAction === "cancel-sign-in" || pendingAction === "submit-code"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              <T>Cancel</T>
            </Button>
          ) : null}
        </AssistedSetupActions>
      </AssistedSetupFrame>
    );
  }

  if (isAuthenticated) {
    if (!isReady) {
      return (
        <AssistedSetupStatusFrame
          accountAction={props.accountAction}
          body={
            props.provider.message ??
            (hasModels
              ? gt("Claude is connected, but its readiness check did not finish.")
              : gt("Claude is connected but did not report an available model."))
          }
          title={gt("Claude needs attention")}
          warning
          diagnostics={runtimeDiagnostics}
        />
      );
    }
    if (updateOffer) {
      const issue = providerUpdateIssue(props.provider, updateOffer, localError);
      return (
        <AssistedSetupFrame>
          <AssistedSetupUpdateStatus
            issue={issue}
            name="Claude"
            provider={props.provider}
            update={updateOffer}
          />
          <AssistedSetupActions>
            {props.accountAction}
            <AssistedSetupUpdateButton
              name="Claude"
              onClick={() => void update()}
              retry={issue !== null}
            />
          </AssistedSetupActions>
          {issue ? runtimeDiagnostics : null}
        </AssistedSetupFrame>
      );
    }
    const accountLabel = props.provider.auth.label;
    const isSubscriptionAccount = accountLabel?.toLowerCase().includes("subscription") ?? false;
    return (
      <AssistedSetupStatusFrame
        accountAction={props.accountAction}
        title={gt("Claude is ready")}
        body={
          accountLabel && isSubscriptionAccount ? (
            <T>
              <Var>
                <ProviderAccountManagementLink provider="claude">
                  {accountLabel}
                </ProviderAccountManagementLink>
              </Var>{" "}
              is connected.
            </T>
          ) : accountLabel ? (
            gt("{account} is connected.", { account: accountLabel })
          ) : (
            gt("Claude is connected.")
          )
        }
      />
    );
  }

  if (props.provider.auth.required === false) {
    return (
      <AssistedSetupStatusFrame
        title={isReady ? gt("Claude is ready") : gt("Claude needs attention")}
        body={
          isReady
            ? gt("This Claude setup does not require account sign-in.")
            : (props.provider.message ?? gt("Claude did not report an available model."))
        }
        warning={!isReady}
        diagnostics={isReady ? undefined : runtimeDiagnostics}
      />
    );
  }

  if (!signInMethod) {
    return (
      <AssistedSetupStatusFrame
        title={gt("Claude needs setup")}
        body={gt("Finish configuring this custom Claude provider in Settings.")}
        warning
        diagnostics={runtimeDiagnostics}
      />
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  const canInstallManaged =
    !props.managedRuntimePresentedExternally && (runtime?.actions.includes("install") ?? false);
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          (signInMethod === "claude_subscription"
            ? gt("Sign in with your existing Claude subscription. Scient never sees your password.")
            : gt("Connect your Anthropic Console account. Scient never sees your password."))
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? gt("Claude sign-in didn’t finish") : gt("Sign in required")}
      />
      <AssistedSetupActions>
        {alternateSignInMethod ? (
          <Button
            onClick={() => void signIn(alternateSignInMethod)}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            {alternateSignInMethod === "claude_console"
              ? gt("Use Anthropic Console")
              : gt("Use Claude subscription")}
          </Button>
        ) : null}
        <Button
          aria-label={signInError ? gt("Try again to sign in to Claude") : undefined}
          onClick={() => void signIn()}
          size="sm"
          type="button"
          variant="ghost-primary"
        >
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError
            ? gt("Try sign in again")
            : signInMethod === "claude_subscription"
              ? gt("Sign in to Claude")
              : gt("Sign in with Console")}
        </Button>
      </AssistedSetupActions>
      {signInError && !props.managedRuntimePresentedExternally ? (
        <AssistedSetupDiagnostics
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={canInstallManaged ? () => void install() : undefined}
          provider={props.provider}
        />
      ) : null}
    </AssistedSetupFrame>
  );
}
