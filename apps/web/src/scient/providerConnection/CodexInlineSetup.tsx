import { msg, T, useGT, useMessages } from "gt-react";
import {
  DEFAULT_PROVIDER_STARTING_MESSAGE,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
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
  AssistedSetupDeviceCode,
  AssistedSetupDiagnostics,
  AssistedSetupFrame,
  AssistedSetupStatusFrame,
  AssistedSetupStatus,
  AssistedSetupUpdateButton,
  AssistedSetupUpdateStatus,
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import {
  startCodexBrowserSignIn,
  startCodexDeviceSignIn,
  startReviewedCodexRuntimeAction,
  updateCodexRuntime,
} from "./codexLifecycleActions";
import {
  externalProviderUpdate,
  externalProviderUpdateProgress,
  providerUpdateIssue,
  providerUpdateOffer,
} from "./providerLifecycleActions";
import { ProviderAccountManagementLink } from "./ProviderAccountManagementLink";
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
import { browserSignInWaitingView, useProviderSignInBrowser } from "./useProviderSignInBrowser";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";
import { m, type MessageResolver } from "~/i18n/messages";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "external-update"
  | "sign-in"
  | "device-sign-in"
  | "cancel-runtime"
  | "cancel-sign-in"
  | "check"
  | null;

function runtimeStage(
  operation: ProviderRuntimeOperation | null,
  resolve: MessageResolver = m,
): string {
  switch (operation?.status) {
    case "preparing":
      return resolve(msg("Preparing the verified download…"));
    case "downloading":
      return resolve(msg("Downloading Codex…"));
    case "verifying":
      return resolve(msg("Verifying the download…"));
    case "installing":
      return resolve(msg("Installing Codex privately…"));
    case "testing":
      return resolve(msg("Checking the installation…"));
    case "activating":
      return resolve(msg("Finishing setup…"));
    default:
      return resolve(msg("Preparing Codex…"));
  }
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
  const gt = useGT();
  const messages = useMessages();

  const [previousInstanceId, setPreviousInstanceId] = useState(props.provider.instanceId);
  if (previousInstanceId !== props.provider.instanceId) {
    setPreviousInstanceId(props.provider.instanceId);
    setPendingAction(null);
    setLocalError(null);
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
  const browser = useProviderSignInBrowser(
    props.controller.signInKey,
    activeConnectionOperation,
    props.displayName,
  );
  // Only this window opens the Codex page; others offer it.
  const page = browserSignInWaitingView(browser, activeConnectionOperation, messages);
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
        await startReviewedCodexRuntimeAction(props.controller, "install");
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not install Codex.")),
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
        await updateCodexRuntime(props.controller, props.provider);
      } catch (error) {
        setLocalError(providerLifecycleFailureMessage(error, gt("Scient could not update Codex.")));
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
        const provider = await startReviewedCodexRuntimeAction(props.controller, "repair");
        if (
          provider.connection?.runtime?.operation?.action === "repair" &&
          provider.connection.runtime.operation.status === "succeeded"
        ) {
          props.onRepairSucceeded?.();
        }
      } catch (error) {
        setLocalError(providerLifecycleFailureMessage(error, gt("Scient could not repair Codex.")));
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
          providerLifecycleFailureMessage(error, gt("Scient could not cancel Codex setup.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const signIn = async (method: "codex_browser" | "codex_device_code" | null = signInMethod) => {
    if (!method) return;
    setLocalError(null);
    setPendingAction(method === "codex_device_code" ? "device-sign-in" : "sign-in");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        if (method === "codex_device_code") {
          await startCodexDeviceSignIn(props.controller);
        } else {
          await startCodexBrowserSignIn(props.controller);
        }
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not start Codex sign in.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const checkAgain = async () => {
    setLocalError(null);
    setPendingAction("check");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await props.controller.refresh();
      } catch (error) {
        setLocalError(providerLifecycleFailureMessage(error, gt("Scient could not check Codex.")));
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };

  const cancelSignIn = async () => {
    if (!activeConnectionOperation) return;
    setLocalError(null);
    setPendingAction("cancel-sign-in");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await props.controller.cancelConnection(activeConnectionOperation.operationId);
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not cancel Codex sign in.")),
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
              ? gt("Updating Codex")
              : repairing
                ? gt("Repairing Codex")
                : gt("Installing Codex")
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel(
                "Codex",
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
          name="Codex"
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
      localError ?? managedRuntimeRepairMessage(props.provider, "Codex", undefined, messages);
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={error}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("Codex needs repair")}
        />
        <AssistedSetupActions>
          <Button onClick={() => void repair()} size="sm" type="button" variant="ghost-primary">
            <RefreshCwIcon aria-hidden /> <T>Repair Codex</T>
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
              ? gt("Codex is not installed on {computer}.", {
                  computer: providerRuntimeComputerLabel(props.provider, messages),
                })
              : gt(
                  "Assisted installation is not available for {computer}. You can use an existing Codex installation.",
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
          title={error ? gt("Codex installation couldn’t finish") : gt("Install Codex")}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={error ? gt("Retry installation of Codex") : gt("Install Codex")}
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

  if (
    activeConnectionOperation ||
    pendingAction === "sign-in" ||
    pendingAction === "device-sign-in"
  ) {
    const starting = !activeConnectionOperation || activeConnectionOperation.status === "starting";
    const verifying = activeConnectionOperation?.status === "verifying";
    const usingDeviceCode = activeConnectionOperation?.method === "codex_device_code";
    const openFailure = !starting && !verifying ? page.failure : null;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            starting
              ? (props.provider.connection?.startingMessage ?? DEFAULT_PROVIDER_STARTING_MESSAGE)
              : verifying
                ? gt("Confirming sign-in with Codex…")
                : usingDeviceCode && !openFailure
                  ? gt("Enter this code on Codex’s secure sign-in page.")
                  : page.body
          }
          icon={
            openFailure ? (
              <TriangleAlertIcon className="size-5 text-warning" />
            ) : page.userMustOpen ? (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            ) : (
              <LoaderIcon className="size-5 animate-spin text-primary" />
            )
          }
          role={openFailure ? "alert" : undefined}
          title={
            verifying
              ? gt("Checking your account")
              : page.blocked && !starting
                ? gt("Sign-in page blocked")
                : gt("Finish signing in")
          }
        />
        {usingDeviceCode && activeConnectionOperation?.userCode ? (
          <AssistedSetupDeviceCode code={activeConnectionOperation.userCode} providerName="Codex" />
        ) : null}
        {!verifying && activeConnectionOperation?.authorizationUrl ? (
          <AssistedSetupActions>
            <Button
              disabled={browser.opening?.status === "opening"}
              onClick={() => void browser.reopen()}
              size="sm"
              type="button"
              variant={page.userMustOpen ? "ghost-primary" : "ghost-muted"}
            >
              <ExternalLinkIcon aria-hidden />{" "}
              {page.notOpenedHere || page.blocked
                ? gt("Open sign-in page")
                : gt("Reopen sign-in page")}
            </Button>
            {activeConnectionOperation ? (
              <Button
                aria-label={gt("Cancel Codex sign-in")}
                disabled={pendingAction === "cancel-sign-in"}
                onClick={() => void cancelSignIn()}
                size="sm"
                type="button"
                variant="ghost-destructive-action"
              >
                <T>Cancel</T>
              </Button>
            ) : null}
          </AssistedSetupActions>
        ) : activeConnectionOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={gt("Cancel Codex sign-in")}
              disabled={pendingAction === "cancel-sign-in"}
              onClick={() => void cancelSignIn()}
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              <T>Cancel</T>
            </Button>
          </AssistedSetupActions>
        ) : null}
      </AssistedSetupFrame>
    );
  }

  if (isAuthenticated) {
    if (updateOffer) {
      const issue = providerUpdateIssue(props.provider, updateOffer, localError);
      return (
        <AssistedSetupFrame>
          <AssistedSetupUpdateStatus
            issue={issue}
            name="Codex"
            provider={props.provider}
            update={updateOffer}
          />
          <AssistedSetupActions>
            {props.accountAction}
            <AssistedSetupUpdateButton
              name="Codex"
              onClick={() => void update()}
              retry={issue !== null}
            />
          </AssistedSetupActions>
          {issue ? runtimeDiagnostics : null}
        </AssistedSetupFrame>
      );
    }
    return (
      <AssistedSetupStatusFrame
        accountAction={props.accountAction}
        title={gt("Codex is ready")}
        body={
          <>
            <T>
              Your{" "}
              <ProviderAccountManagementLink provider="codex">
                ChatGPT subscription
              </ProviderAccountManagementLink>{" "}
              is connected.
            </T>
          </>
        }
      />
    );
  }

  // The status check could not read the account, usually because Codex cannot reach OpenAI.
  // A sign-in would fail the same way, so checking again comes first.
  if (
    connectionOperation?.status !== "failed" &&
    props.provider.status === "error" &&
    props.provider.auth.status === "unknown"
  ) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={localError ?? gt("Check your internet connection or VPN, then try again.")}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("Codex can’t check your account")}
        />
        <AssistedSetupActions>
          {signInMethod ? (
            <Button
              disabled={pendingAction !== null}
              onClick={() => void signIn()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              <T>Sign in again</T>
            </Button>
          ) : null}
          <Button
            aria-label={gt("Check Codex again")}
            disabled={pendingAction !== null}
            onClick={() => void checkAgain()}
            size="sm"
            type="button"
            variant="ghost-primary"
          >
            {pendingAction === "check" ? (
              <LoaderIcon aria-hidden className="animate-spin" />
            ) : (
              <RefreshCwIcon aria-hidden />
            )}
            <T>Try again</T>
          </Button>
        </AssistedSetupActions>
      </AssistedSetupFrame>
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  const canInstallManaged =
    !props.managedRuntimePresentedExternally && (runtime?.actions.includes("install") ?? false);
  const switchToManaged = async () => {
    setLocalError(null);
    setPendingAction("install");
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await startReviewedCodexRuntimeAction(props.controller, "install");
      } catch (error) {
        setLocalError(
          providerLifecycleFailureMessage(error, gt("Scient could not switch to managed Codex.")),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
  };
  return (
    <AssistedSetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          gt("Sign in with your existing ChatGPT subscription. Scient never sees your password.")
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? gt("Codex sign-in didn’t finish") : gt("Sign in required")}
      />
      <AssistedSetupActions>
        {alternateSignInMethod ? (
          <Button
            onClick={() => void signIn(alternateSignInMethod)}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            {alternateSignInMethod === "codex_device_code"
              ? gt("Use device code")
              : gt("Use browser sign-in")}
          </Button>
        ) : null}
        <Button
          aria-label={signInError ? gt("Try again to sign in to Codex") : undefined}
          onClick={() => void signIn()}
          size="sm"
          type="button"
          variant="ghost-primary"
        >
          {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
          {signInError
            ? gt("Try again")
            : signInMethod === "codex_device_code"
              ? gt("Sign in with device code")
              : gt("Sign in with ChatGPT")}
        </Button>
      </AssistedSetupActions>
      {signInError && !props.managedRuntimePresentedExternally ? (
        <AssistedSetupDiagnostics
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={canInstallManaged ? () => void switchToManaged() : undefined}
          provider={props.provider}
        />
      ) : null}
    </AssistedSetupFrame>
  );
}
