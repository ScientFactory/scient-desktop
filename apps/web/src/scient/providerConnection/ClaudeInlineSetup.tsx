import type { ProviderRuntimeOperation, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
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
  hasExternalClaudeUpdate,
  hasManagedClaudeUpdate,
  startClaudeSignIn,
  startReviewedClaudeRuntimeAction,
  updateClaudeRuntime,
} from "./claudeLifecycleActions";
import { needsManagedRuntimeRecovery } from "./providerConnectionPresentation";
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

function runtimeStage(operation: ProviderRuntimeOperation | null): {
  readonly label: string;
  readonly progress: number;
} {
  switch (operation?.status) {
    case "preparing":
      return { label: "Preparing the verified download…", progress: 8 };
    case "downloading": {
      const progress =
        operation.downloadedBytes !== undefined && operation.totalBytes !== undefined
          ? Math.min(
              42,
              Math.max(12, Math.round((operation.downloadedBytes / operation.totalBytes) * 42)),
            )
          : 24;
      return { label: "Downloading Claude…", progress };
    }
    case "verifying":
      return { label: "Verifying the download…", progress: 48 };
    case "installing":
      return { label: "Installing Claude privately…", progress: 66 };
    case "testing":
      return { label: "Checking the installation…", progress: 83 };
    case "activating":
      return { label: "Finishing setup…", progress: 94 };
    default:
      return { label: "Preparing Claude…", progress: 6 };
  }
}

function computerLabel(provider: ServerProvider): string {
  const target = provider.connection?.runtime?.target;
  if (target?.startsWith("darwin-")) return "this Mac";
  if (target?.startsWith("win32-")) return "this Windows computer";
  if (target?.startsWith("linux-")) return "this Linux computer";
  return "this computer";
}

export function ClaudeInlineSetup(props: {
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
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
  const managedUpdateAvailable = hasManagedClaudeUpdate(props.provider);
  const externalUpdateAvailable = hasExternalClaudeUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const needsRuntimeRepair = needsManagedRuntimeRecovery(props.provider);

  const install = async () => {
    setLocalError(null);
    setPendingAction("install");
    try {
      await startReviewedClaudeRuntimeAction(props.controller, "install");
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not install Claude."));
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
      setLocalError(failureMessage(error, "Scient could not update Claude."));
    } finally {
      setPendingAction(null);
    }
  };

  const repair = async () => {
    setLocalError(null);
    setPendingAction("repair");
    try {
      await startReviewedClaudeRuntimeAction(props.controller, "repair");
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not repair Claude."));
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
      setLocalError(failureMessage(error, "Scient could not cancel Claude setup."));
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
      setLocalError(failureMessage(error, "Scient could not start Claude sign in."));
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
      setLocalError(failureMessage(error, "Scient could not return the one-time code to Claude."));
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
      setShowAuthorizationCode(true);
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not open Claude’s fallback sign-in page."));
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
      setLocalError(failureMessage(error, "Scient could not cancel Claude sign in."));
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
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
        <h2 className="font-semibold text-lg">
          {updating ? "Updating Claude" : repairing ? "Repairing Claude" : "Installing Claude"}
        </h2>
        <p className="mt-1.5 text-muted-foreground text-sm">{stage.label}</p>
        <div
          aria-label={`Claude ${updating ? "update" : repairing ? "repair" : "installation"} progress`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={stage.progress}
          className="mt-4 w-full max-w-56"
          role="progressbar"
        >
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${stage.progress}%` }}
            />
          </div>
        </div>
        {activeRuntimeOperation ? (
          <Button
            className="mt-4"
            disabled={pendingAction === "cancel-runtime"}
            onClick={() => void cancelRuntime()}
            size="sm"
            type="button"
            variant="outline"
          >
            {pendingAction === "cancel-runtime" ? (
              <LoaderIcon aria-hidden className="animate-spin" />
            ) : (
              <XIcon aria-hidden />
            )}
            Cancel
          </Button>
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
        <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-warning" />
        <h2 className="font-semibold text-lg">Claude needs repair</h2>
        <p className="mt-1.5 max-w-60 text-balance text-muted-foreground text-sm leading-relaxed">
          {error}
        </p>
        <Button className="mt-4 gap-1.5" onClick={() => void repair()} size="sm" type="button">
          <RefreshCwIcon aria-hidden /> Repair Claude
        </Button>
      </SetupFrame>
    );
  }

  if (!props.provider.installed) {
    const error =
      localError ?? (runtimeOperation?.status === "failed" ? runtimeOperation.message : null);
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <SetupFrame>
        {error ? (
          <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-destructive" />
        ) : (
          <ProviderInstanceIcon
            className="mb-3 size-9"
            displayName={props.displayName}
            driverKind={props.provider.driver}
            iconClassName="size-8"
          />
        )}
        <h2 className="font-semibold text-lg">
          {error ? "Claude installation couldn’t finish" : props.displayName}
        </h2>
        <p
          className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed"
          role={error ? "alert" : undefined}
        >
          {error ?? `Claude is not installed on ${computerLabel(props.provider)}.`}
        </p>
        {canInstall ? (
          <Button className="mt-4 gap-1.5" onClick={() => void install()} size="sm" type="button">
            {error ? <RefreshCwIcon aria-hidden /> : null}
            {error ? "Retry installation" : "Install Claude"}
          </Button>
        ) : (
          <p className="mt-3 max-w-60 text-balance text-muted-foreground text-xs leading-relaxed">
            Assisted installation is not available for this computer yet. You can use an existing
            Claude installation.
          </p>
        )}
      </SetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const verifying =
      activeConnectionOperation?.status === "verifying" || pendingAction === "submit-code";
    return (
      <SetupFrame>
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
        <h2 className="font-semibold text-lg">
          {verifying ? "Checking your account" : "Finish signing in"}
        </h2>
        <p className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed">
          {verifying ? "Finding your available models…" : "Complete sign-in in your browser."}
        </p>
        {activeConnectionOperation?.authorizationUrl &&
        activeConnectionOperation.authorizationUrlKind === "manual_fallback" ? (
          <Button
            className="mt-3 gap-1.5"
            onClick={() => void openManualFallback()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ExternalLinkIcon aria-hidden />
            {showAuthorizationCode ? "Reopen fallback page" : "Browser didn’t open?"}
          </Button>
        ) : null}
        {showAuthorizationCode ? (
          <form
            className="mx-auto mt-2 flex w-fit max-w-full items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
            }}
          >
            <input
              aria-label="Claude one-time sign-in code"
              autoCapitalize="none"
              autoComplete="off"
              className="h-7 w-36 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none transition-colors placeholder:text-placeholder focus-visible:border-ring disabled:opacity-64"
              onChange={(event) => setAuthorizationCode(event.currentTarget.value)}
              placeholder="Paste code"
              spellCheck={false}
              value={authorizationCode}
            />
            <Button
              className="h-7 px-2.5"
              disabled={authorizationCode.trim().length === 0 || pendingAction === "submit-code"}
              size="sm"
              type="submit"
              variant="outline"
            >
              Submit
            </Button>
          </form>
        ) : null}
        {activeConnectionOperation ? (
          <Button
            className="mt-2"
            disabled={pendingAction === "cancel-sign-in" || pendingAction === "submit-code"}
            onClick={() => void cancelSignIn()}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        ) : null}
        {localError ? (
          <p className="mt-2 max-w-60 text-balance text-destructive text-xs" role="alert">
            {localError}
          </p>
        ) : null}
      </SetupFrame>
    );
  }

  if (isAuthenticated) {
    if (!isReady) {
      return (
        <StatusFrame
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
          {error ? (
            <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-destructive" />
          ) : (
            <ProviderInstanceIcon
              className="mb-3 size-9"
              displayName={props.displayName}
              driverKind={props.provider.driver}
              iconClassName="size-8"
            />
          )}
          <h2 className="font-semibold text-lg">
            {error ? "Claude couldn’t be updated" : "Claude update available"}
          </h2>
          <p
            className="mt-1.5 max-w-60 text-balance text-muted-foreground text-sm leading-relaxed"
            role={error ? "alert" : undefined}
          >
            {error ?? "Install the reviewed update when you’re ready."}
          </p>
          <Button className="mt-4" onClick={() => void update()} size="sm" type="button">
            {error ? "Try again" : "Update Claude"}
          </Button>
          <p className="mt-2 text-muted-foreground text-[11px]">
            Your current version stays available until the update is verified.
          </p>
        </SetupFrame>
      );
    }
    return (
      <StatusFrame
        title="Claude is ready"
        body={
          props.provider.auth.label
            ? `${props.provider.auth.label} is connected.`
            : "Claude is connected."
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
      {signInError ? (
        <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-destructive" />
      ) : (
        <ProviderInstanceIcon
          className="mb-3 size-9"
          displayName={props.displayName}
          driverKind={props.provider.driver}
          iconClassName="size-8"
        />
      )}
      <h2 className="font-semibold text-lg">
        {signInError ? "Claude sign-in didn’t finish" : "Claude is installed"}
      </h2>
      <p
        className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed"
        role={signInError ? "alert" : undefined}
      >
        {signInError ??
          (signInMethod === "claude_subscription"
            ? "Sign in with your existing Claude subscription."
            : "Connect your Anthropic Console account.")}
      </p>
      <Button className="mt-4 gap-1.5" onClick={() => void signIn()} size="sm" type="button">
        {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
        {signInError
          ? "Try sign in again"
          : signInMethod === "claude_subscription"
            ? "Sign in to Claude"
            : "Sign in with Console"}
      </Button>
      {alternateSignInMethod ? (
        <Button
          className="mt-1.5 h-auto px-2 py-1 text-muted-foreground text-xs"
          onClick={() => void signIn(alternateSignInMethod)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {alternateSignInMethod === "claude_console"
            ? "Use Anthropic Console"
            : "Use Claude subscription"}
        </Button>
      ) : null}
      {!signInError ? (
        <p className="mt-2 max-w-56 text-balance text-muted-foreground text-[11px] leading-relaxed">
          Opens in your browser. Scient never sees your password.
        </p>
      ) : null}
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
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
      ) : props.warning ? (
        <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-warning" />
      ) : (
        <CheckCircle2Icon aria-hidden className="mb-3 size-8 text-success" />
      )}
      <h2 className="font-semibold text-lg">{props.title}</h2>
      <p className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed">
        {props.body}
      </p>
    </SetupFrame>
  );
}

function SetupFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-4 text-center"
      data-provider-onboarding-view="claude-flow"
    >
      {children}
    </div>
  );
}
