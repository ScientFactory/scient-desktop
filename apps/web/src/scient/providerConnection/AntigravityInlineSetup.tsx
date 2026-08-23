import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import {
  cancelAntigravitySignIn,
  disconnectAntigravity,
  hasManagedAntigravityUpdate,
  startAntigravitySignInAndOpenAuthorizationPage,
  startReviewedAntigravityRuntimeAction,
  updateAntigravityRuntime,
} from "./antigravityLifecycleActions";
import { needsManagedRuntimeRecovery } from "./providerConnectionPresentation";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
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
  | "disconnect"
  | null;

const ACTIVE_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
]);
function failureMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.trim().length > 0 ? value.message : fallback;
}

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
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
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
  const hasModels = props.provider.models.length > 0;
  const isReady = props.provider.status === "ready" && hasModels && isAuthenticated;
  const managedUpdateAvailable = hasManagedAntigravityUpdate(props.provider);
  const needsRuntimeRepair = needsManagedRuntimeRecovery(props.provider);
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
      setLocalError(failureMessage(error, `Scient could not ${action} Antigravity.`));
    } finally {
      setPendingAction(null);
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
        failureMessage(error, "Scient could not return the authorization code to Antigravity."),
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
    const action = activeRuntimeOperation?.action ?? pendingAction;
    return (
      <SetupFrame>
        <LoaderIcon className="size-6 animate-spin text-primary" />
        <h2 className="text-sm font-semibold">
          {action === "update"
            ? "Updating Antigravity"
            : action === "repair"
              ? "Repairing Antigravity"
              : action === "remove"
                ? "Removing Antigravity"
                : "Installing Antigravity"}
        </h2>
        <p className="text-muted-foreground text-xs">{stage}</p>
        {activeRuntimeOperation ? (
          <Button
            className={DESTRUCTIVE_GHOST_ACTION_CLASS}
            onClick={() => void cancelRuntime()}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            <XIcon aria-hidden /> Cancel
          </Button>
        ) : null}
      </SetupFrame>
    );
  }

  if (needsRuntimeRepair) {
    return (
      <SetupFrame>
        <TriangleAlertIcon className="size-7 text-warning" />
        <h2 className="text-sm font-semibold">Antigravity needs repair</h2>
        <p className="text-muted-foreground text-xs">
          {localError ?? runtimeOperation?.message ?? props.provider.message}
        </p>
        <Button
          onClick={() =>
            void run("repair", () =>
              startReviewedAntigravityRuntimeAction(props.controller, "repair"),
            )
          }
          size="sm"
        >
          <RefreshCwIcon aria-hidden /> Repair Antigravity
        </Button>
      </SetupFrame>
    );
  }

  if (removedSuccessfully) {
    return (
      <SetupFrame>
        <CheckCircle2Icon className="size-7 text-success" />
        <h2 className="text-sm font-semibold">Antigravity removed</h2>
        <p className="text-muted-foreground text-xs">{runtimeOperation.message}</p>
        {runtime?.actions.includes("install") ? (
          <Button
            onClick={() =>
              void run("install", () =>
                startReviewedAntigravityRuntimeAction(props.controller, "install"),
              )
            }
            size="sm"
            variant="outline"
          >
            Install again
          </Button>
        ) : null}
      </SetupFrame>
    );
  }

  if (!props.provider.installed) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const command = manualInstallCommand(props.provider);
    return (
      <SetupFrame>
        <ProviderInstanceIcon
          className="size-8"
          displayName={props.displayName}
          driverKind={props.provider.driver}
        />
        <h2 className="text-sm font-semibold">Install Antigravity</h2>
        <p className="text-muted-foreground text-xs">
          {canInstall
            ? "Scient can install a reviewed official Google CLI privately for this app."
            : "Assisted installation is not available on this computer. Use Google’s official installer."}
        </p>
        {canInstall ? (
          <Button
            onClick={() =>
              void run("install", () =>
                startReviewedAntigravityRuntimeAction(props.controller, "install"),
              )
            }
            size="sm"
          >
            Install Antigravity
          </Button>
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
        {localError ? <p className="text-destructive text-xs">{localError}</p> : null}
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
        <LoaderIcon className="size-6 animate-spin text-primary" />
        <h2 className="text-sm font-semibold">
          {verifying ? "Checking your Google account" : "Finish signing in"}
        </h2>
        <p className="text-muted-foreground text-xs">
          {verifying
            ? "Finding the models available to your account…"
            : "Complete the official Antigravity sign-in in your browser."}
        </p>
        {activeConnectionOperation?.authorizationUrl ? (
          <Button
            onClick={() =>
              void props.controller.openAuthorizationPage(
                activeConnectionOperation.authorizationUrl as string,
              )
            }
            size="sm"
            variant="ghost"
          >
            <ExternalLinkIcon aria-hidden />
            {activeConnectionOperation.authorizationUrlKind === "manual_fallback"
              ? "Open sign-in help"
              : "Reopen Google sign-in"}
          </Button>
        ) : null}
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
        {activeConnectionOperation ? (
          <Button
            className={DESTRUCTIVE_GHOST_ACTION_CLASS}
            disabled={pendingAction === "submit-code"}
            onClick={() => void cancelSignIn()}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
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
      "Sign in with the Google account for your existing subscription. Scient never sees your password.";
    return (
      <SetupFrame>
        {signInError ? (
          <TriangleAlertIcon className="size-7 text-destructive" />
        ) : (
          <ProviderInstanceIcon
            className="size-8"
            displayName={props.displayName}
            driverKind={props.provider.driver}
          />
        )}
        <h2 className="text-sm font-semibold">
          {signInError ? "Google sign-in didn’t finish" : "Antigravity is installed"}
        </h2>
        <p
          className={signInError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
          role={signInError ? "alert" : undefined}
        >
          {signInGuidance}
        </p>
        <Button
          onClick={() =>
            void run("sign-in", () =>
              startAntigravitySignInAndOpenAuthorizationPage(props.controller),
            )
          }
          size="sm"
        >
          <ExternalLinkIcon aria-hidden /> {signInError ? "Try again" : "Sign in with Google"}
        </Button>
      </SetupFrame>
    );
  }

  if (!isReady) {
    return (
      <StatusFrame
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
        body={updateState?.message ?? "Updating and verifying Antigravity…"}
        loading
        title="Updating Antigravity"
      />
    );
  }

  if (managedUpdateAvailable) {
    return (
      <SetupFrame>
        <RefreshCwIcon className="size-7 text-primary" />
        <h2 className="text-sm font-semibold">Antigravity update available</h2>
        <p className="text-muted-foreground text-xs">
          Install the reviewed update when you’re ready. The current version remains active until
          verification succeeds.
        </p>
        <Button
          onClick={() =>
            void run("update", () => updateAntigravityRuntime(props.controller, props.provider))
          }
          size="sm"
        >
          Update Antigravity
        </Button>
      </SetupFrame>
    );
  }

  return (
    <SetupFrame>
      <CheckCircle2Icon className="size-7 text-success" />
      <h2 className="text-sm font-semibold">Antigravity is ready</h2>
      <p className="text-muted-foreground text-xs">
        Your{" "}
        <ProviderAccountManagementLink provider="antigravity">
          Google account
        </ProviderAccountManagementLink>{" "}
        is connected
        {props.provider.version ? ` with CLI ${props.provider.version}` : ""}.
        {defaultModel ? ` Default model: ${defaultModel.name}.` : ""}
      </p>
      {props.provider.connection?.canDisconnect ? (
        <Button
          disabled={pendingAction === "disconnect"}
          onClick={() => void run("disconnect", () => disconnectAntigravity(props.controller))}
          size="sm"
          variant="ghost"
        >
          Sign out
        </Button>
      ) : null}
      {localError ? <p className="text-destructive text-xs">{localError}</p> : null}
    </SetupFrame>
  );
}

function StatusFrame(props: {
  readonly title: string;
  readonly body: string;
  readonly loading?: boolean;
  readonly warning?: boolean;
}) {
  return (
    <SetupFrame>
      {props.loading ? (
        <LoaderIcon className="size-6 animate-spin text-primary" />
      ) : props.warning ? (
        <TriangleAlertIcon className="size-7 text-warning" />
      ) : (
        <CheckCircle2Icon className="size-7 text-success" />
      )}
      <h2 className="text-sm font-semibold">{props.title}</h2>
      <p className="text-muted-foreground text-xs">{props.body}</p>
    </SetupFrame>
  );
}

function SetupFrame(props: { readonly children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-3 px-5 py-4 text-center"
      data-antigravity-setup-surface="true"
    >
      {props.children}
    </div>
  );
}
