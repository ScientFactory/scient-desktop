import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import {
  cancelAntigravitySignIn,
  hasManagedAntigravityUpdate,
  startAntigravitySignInAndOpenAuthorizationPage,
  startReviewedAntigravityRuntimeAction,
  updateAntigravityRuntime,
} from "./antigravityLifecycleActions";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
  providerRuntimeComputerLabel,
} from "./providerConnectionPresentation";
import {
  DESTRUCTIVE_GHOST_ACTION_CLASS,
  PRIMARY_GHOST_ACTION_CLASS,
} from "./providerConnectionActionStyles";
import { ProviderAccountManagementLink } from "./ProviderAccountManagementLink";
import { ProviderAuthorizationCodeForm } from "./ProviderAuthorizationCodeForm";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "cancel-runtime"
  | "sign-in"
  | "submit-code"
  | "cancel-sign-in"
  | null;

function runtimeStage(operation: ProviderRuntimeOperation | null): string {
  switch (operation?.status) {
    case "preparing":
      return "Preparing the reviewed download…";
    case "downloading":
      return "Downloading Antigravity from Google…";
    case "verifying":
      return "Verifying the Google release…";
    case "installing":
      return "Installing Antigravity privately…";
    case "testing":
      return "Checking the installation…";
    case "activating":
      return "Finishing setup…";
    case "removing":
      return "Removing Scient’s private Antigravity copy…";
    default:
      return "Preparing Antigravity…";
  }
}

function manualInstallCommand(provider: ServerProvider): string {
  return provider.connection?.runtime?.target.startsWith("win32-")
    ? "irm https://antigravity.google/cli/install.ps1 | iex"
    : "curl -fsSL https://antigravity.google/cli/install.sh | bash";
}

export function AntigravityInlineSetup(props: {
  readonly accountAction?: ReactNode;
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setCopiedInstallCommand(false);
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
    setAuthorizationCode("");
  }, [activeConnectionOperation?.operationId]);

  const isAuthenticated = props.provider.auth.status === "authenticated";
  const hasModels = props.provider.models.length > 0;
  const isReady = props.provider.status === "ready" && hasModels && isAuthenticated;
  const managedUpdateAvailable =
    !props.managedRuntimePresentedExternally && hasManagedAntigravityUpdate(props.provider);
  const needsRuntimeRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const defaultModel =
    props.provider.models.find((model) => model.isDefault) ?? props.provider.models[0];
  const removedSuccessfully =
    runtimeOperation?.status === "succeeded" && runtimeOperation.action === "remove";

  const run = async (action: Exclude<PendingAction, null>, operation: () => Promise<unknown>) => {
    setLocalError(null);
    setPendingAction(action);
    try {
      await operation();
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(error, `Scient could not ${action} Antigravity.`),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const runtimeAction = async (action: "install" | "repair") => {
    const provider = await startReviewedAntigravityRuntimeAction(props.controller, action);
    if (
      action === "repair" &&
      provider.connection?.runtime?.operation?.action === "repair" &&
      provider.connection.runtime.operation.status === "succeeded"
    ) {
      props.onRepairSucceeded?.();
    }
  };

  const cancelRuntime = () =>
    activeRuntimeOperation
      ? run("cancel-runtime", () =>
          props.controller.cancelRuntime(activeRuntimeOperation.operationId),
        )
      : Promise.resolve();
  const cancelSignIn = () =>
    activeConnectionOperation
      ? run("cancel-sign-in", () =>
          cancelAntigravitySignIn(props.controller, activeConnectionOperation.operationId),
        )
      : Promise.resolve();

  const submitCode = async () => {
    if (!activeConnectionOperation || authorizationCode.trim().length === 0) return;
    setLocalError(null);
    setPendingAction("submit-code");
    try {
      await props.controller.submitAuthorizationCode(
        activeConnectionOperation.operationId,
        authorizationCode,
      );
      setAuthorizationCode("");
    } catch (error) {
      setLocalError(
        providerLifecycleFailureMessage(
          error,
          "Scient could not return the authorization code to Antigravity.",
        ),
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
    const action = activeRuntimeOperation?.action ?? pendingAction;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={runtimeStage(activeRuntimeOperation)}
          icon={
            <AntigravityLoadingIcon
              displayName={props.displayName}
              driver={props.provider.driver}
            />
          }
          title={
            <AntigravityLoadingTitle>
              {action === "update"
                ? "Updating Antigravity"
                : action === "repair"
                  ? "Repairing Antigravity"
                  : action === "remove"
                    ? "Removing Antigravity"
                    : "Installing Antigravity"}
            </AntigravityLoadingTitle>
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
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            localError ??
            runtimeOperation?.message ??
            props.provider.message ??
            "Antigravity’s private runtime could not start."
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Antigravity needs repair"
        />
        <AssistedSetupActions>
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            onClick={() => void run("repair", () => runtimeAction("repair"))}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden /> Repair Antigravity
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (removedSuccessfully && !props.managedRuntimePresentedExternally) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={runtimeOperation.message}
          icon={<CheckCircle2Icon className="size-5 text-success" />}
          title="Antigravity removed"
        />
        {runtime?.actions.includes("install") ? (
          <AssistedSetupActions>
            <Button
              className={PRIMARY_GHOST_ACTION_CLASS}
              onClick={() => void run("install", () => runtimeAction("install"))}
              size="sm"
              type="button"
              variant="ghost"
            >
              <DownloadIcon aria-hidden /> Install again
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (
    props.managedRuntimePresentedExternally &&
    !isProviderRuntimePresentedAsInstalled(props.provider)
  ) {
    return isAuthenticated ? (
      <StatusFrame
        accountAction={props.accountAction}
        body={
          <>
            Your{" "}
            <ProviderAccountManagementLink provider="antigravity">
              Google account
            </ProviderAccountManagementLink>{" "}
            remains connected.
          </>
        }
        title="Google account connected"
      />
    ) : null;
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const command = manualInstallCommand(props.provider);
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            localError ??
            (canInstall
              ? "Scient can install a reviewed official Antigravity runtime privately."
              : `Assisted installation is not available on ${providerRuntimeComputerLabel(props.provider)}. Use Google’s official installer.`)
          }
          icon={
            localError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <AntigravitySetupIcon
                displayName={props.displayName}
                driver={props.provider.driver}
              />
            )
          }
          role={localError ? "alert" : undefined}
          title={localError ? "Antigravity installation couldn’t finish" : "Install Antigravity"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              className={PRIMARY_GHOST_ACTION_CLASS}
              onClick={() => void run("install", () => runtimeAction("install"))}
              size="sm"
              type="button"
              variant="ghost"
            >
              {localError ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {localError ? "Retry installation" : "Install Antigravity"}
            </Button>
          </AssistedSetupActions>
        ) : (
          <button
            className="flex max-w-full items-center gap-1.5 rounded bg-muted px-2 py-1.5 font-mono text-[10px]"
            onClick={() => {
              void navigator.clipboard.writeText(command);
              setCopiedInstallCommand(true);
            }}
            type="button"
          >
            {copiedInstallCommand ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
            <span className="truncate">{command}</span>
          </button>
        )}
      </SetupFrame>
    );
  }

  if (!isAuthenticated && (activeConnectionOperation || pendingAction === "sign-in")) {
    const verifying = activeConnectionOperation?.status === "verifying";
    const waitingForAuthorizationCode =
      (activeConnectionOperation?.acceptsAuthorizationCode === true ||
        (activeConnectionOperation?.acceptsAuthorizationCode === undefined &&
          activeConnectionOperation?.method === "antigravity_google" &&
          activeConnectionOperation.authorizationUrlKind === "primary")) &&
      !verifying;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            verifying
              ? "Finding the models available to your account…"
              : "Complete the official Antigravity sign-in in your browser."
          }
          icon={
            <AntigravityLoadingIcon
              displayName={props.displayName}
              driver={props.provider.driver}
            />
          }
          title={
            <AntigravityLoadingTitle>
              {verifying ? "Checking your Google account" : "Finish signing in"}
            </AntigravityLoadingTitle>
          }
        />
        {waitingForAuthorizationCode ? (
          <div className="w-full space-y-2">
            <p className="text-muted-foreground text-xs">
              Paste the code Google shows after sign in.
            </p>
            <ProviderAuthorizationCodeForm
              authorizationCode={authorizationCode}
              disabled={pendingAction === "submit-code"}
              onAuthorizationCodeChange={setAuthorizationCode}
              onSubmit={() => void submitCode()}
              providerName={props.displayName}
              submitting={pendingAction === "submit-code"}
            />
          </div>
        ) : null}
        {!verifying ? (
          <AssistedSetupActions>
            {activeConnectionOperation?.authorizationUrl ? (
              <Button
                onClick={() =>
                  void props.controller.openAuthorizationPage(
                    activeConnectionOperation.authorizationUrl as string,
                  )
                }
                size="sm"
                type="button"
                variant="ghost-muted"
              >
                <ExternalLinkIcon aria-hidden />
                {activeConnectionOperation.authorizationUrlKind === "manual_fallback"
                  ? "Open sign-in help"
                  : "Reopen Google sign-in"}
              </Button>
            ) : null}
            {activeConnectionOperation ? (
              <Button
                className={DESTRUCTIVE_GHOST_ACTION_CLASS}
                disabled={pendingAction === "submit-code" || pendingAction === "cancel-sign-in"}
                onClick={() => void cancelSignIn()}
                size="sm"
                type="button"
                variant="ghost-muted"
              >
                Cancel
              </Button>
            ) : null}
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (props.provider.auth.status === "unknown") {
    return (
      <StatusFrame
        body={
          props.provider.message ??
          "Scient could not confirm the Google account state. Check the provider again before signing in."
        }
        title="Couldn’t verify your Google account"
        warning
      />
    );
  }

  if (!isAuthenticated) {
    const signInError =
      localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
    const configurationWarning = props.provider.message?.includes("Gemini API-key mode")
      ? props.provider.message
      : null;
    const signInGuidance =
      signInError ??
      configurationWarning ??
      "Sign in with your existing Gemini subscription. Scient never sees your password.";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={signInGuidance}
          icon={
            signInError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <AntigravitySetupIcon
                displayName={props.displayName}
                driver={props.provider.driver}
              />
            )
          }
          role={signInError ? "alert" : undefined}
          title={signInError ? "Google sign-in didn’t finish" : "Sign in required"}
        />
        <AssistedSetupActions>
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            onClick={() =>
              void run("sign-in", () =>
                startAntigravitySignInAndOpenAuthorizationPage(props.controller),
              )
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <ExternalLinkIcon aria-hidden /> {signInError ? "Try again" : "Sign in with Google"}
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!isReady) {
    return (
      <StatusFrame
        accountAction={props.accountAction}
        body={
          props.provider.message ??
          "Your Google account is connected, but Antigravity did not report an available model."
        }
        title="Antigravity needs attention"
        warning
      />
    );
  }

  if (updateRunning) {
    return (
      <StatusFrame
        accountAction={props.accountAction}
        body={updateState?.message ?? "Updating and verifying Antigravity…"}
        loading
        title="Updating Antigravity"
      />
    );
  }

  if (managedUpdateAvailable) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body="Install the reviewed update when you’re ready. The current version remains active until verification succeeds."
          icon={<RefreshCwIcon className="size-5 text-primary" />}
          title="Antigravity update available"
        />
        <AssistedSetupActions>
          {props.accountAction}
          <Button
            className={PRIMARY_GHOST_ACTION_CLASS}
            onClick={() =>
              void run("update", () => updateAntigravityRuntime(props.controller, props.provider))
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon aria-hidden /> Update Antigravity
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  return (
    <StatusFrame
      accountAction={props.accountAction}
      body={
        <>
          Your{" "}
          <ProviderAccountManagementLink provider="antigravity">
            Google account
          </ProviderAccountManagementLink>{" "}
          is connected
          {props.provider.version ? ` with CLI ${props.provider.version}` : ""}.
          {defaultModel ? ` Default model: ${defaultModel.name}.` : ""}
        </>
      }
      title="Antigravity is ready"
    />
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

function SetupFrame(props: { readonly children: ReactNode }) {
  return <AssistedSetupFrame>{props.children}</AssistedSetupFrame>;
}

function AntigravitySetupIcon(props: {
  readonly displayName: string;
  readonly driver: ServerProvider["driver"];
}) {
  return (
    <>
      <ShieldCheckIcon className="size-5 text-primary in-[[data-model-picker-content=true]]:hidden" />
      <ProviderInstanceIcon
        className="hidden size-8 in-[[data-model-picker-content=true]]:inline-flex"
        displayName={props.displayName}
        driverKind={props.driver}
        iconClassName="size-8"
      />
    </>
  );
}

function AntigravityLoadingIcon(props: {
  readonly displayName: string;
  readonly driver: ServerProvider["driver"];
}) {
  return (
    <>
      <LoaderIcon className="size-5 animate-spin text-primary in-[[data-model-picker-content=true]]:hidden" />
      <ProviderInstanceIcon
        className="hidden size-8 in-[[data-model-picker-content=true]]:inline-flex"
        displayName={props.displayName}
        driverKind={props.driver}
        iconClassName="size-8"
      />
    </>
  );
}

function AntigravityLoadingTitle(props: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <LoaderIcon className="hidden size-3.5 animate-spin text-primary in-[[data-model-picker-content=true]]:block" />
      {props.children}
    </span>
  );
}
