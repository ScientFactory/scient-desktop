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
  hasExternalCodexUpdate,
  hasManagedCodexUpdate,
  startCodexBrowserSignIn,
  startReviewedCodexRuntimeAction,
  updateCodexRuntime,
} from "./codexLifecycleActions";
import { needsManagedRuntimeRecovery } from "./providerConnectionPresentation";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "sign-in"
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
      return { label: "Downloading Codex…", progress };
    }
    case "verifying":
      return { label: "Verifying the download…", progress: 48 };
    case "installing":
      return { label: "Installing Codex privately…", progress: 66 };
    case "testing":
      return { label: "Checking the installation…", progress: 83 };
    case "activating":
      return { label: "Finishing setup…", progress: 94 };
    default:
      return { label: "Preparing Codex…", progress: 6 };
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
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);

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
  const managedUpdateAvailable = hasManagedCodexUpdate(props.provider);
  const externalUpdateAvailable = hasExternalCodexUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";
  const needsRuntimeRepair = needsManagedRuntimeRecovery(props.provider);

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
      await startReviewedCodexRuntimeAction(props.controller, "repair");
    } catch (error) {
      setLocalError(failureMessage(error, "Scient could not repair Codex."));
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
      setLocalError(failureMessage(error, "Scient could not cancel Codex setup."));
    } finally {
      setPendingAction(null);
    }
  };

  const signIn = async () => {
    setLocalError(null);
    setPendingAction("sign-in");
    try {
      await startCodexBrowserSignIn(props.controller);
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
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
        <h2 className="font-semibold text-lg">
          {updating ? "Updating Codex" : repairing ? "Repairing Codex" : "Installing Codex"}
        </h2>
        <p className="mt-1.5 text-muted-foreground text-sm">{stage.label}</p>
        <div
          aria-label={`Codex ${updating ? "update" : repairing ? "repair" : "installation"} progress`}
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
        : (props.provider.message ?? "Codex's private runtime could not start."));
    return (
      <SetupFrame>
        <TriangleAlertIcon aria-hidden className="mb-3 size-8 text-warning" />
        <h2 className="font-semibold text-lg">Codex needs repair</h2>
        <p className="mt-1.5 max-w-60 text-balance text-muted-foreground text-sm leading-relaxed">
          {error}
        </p>
        <Button className="mt-4 gap-1.5" onClick={() => void repair()} size="sm" type="button">
          <RefreshCwIcon aria-hidden /> Repair Codex
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
          {error ? "Codex installation couldn’t finish" : props.displayName}
        </h2>
        <p
          className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed"
          role={error ? "alert" : undefined}
        >
          {error ?? `Codex is not installed on ${computerLabel(props.provider)}.`}
        </p>
        {canInstall ? (
          <Button className="mt-4 gap-1.5" onClick={() => void install()} size="sm" type="button">
            {error ? <RefreshCwIcon aria-hidden /> : null}
            {error ? "Retry installation" : "Install Codex"}
          </Button>
        ) : (
          <p className="mt-3 max-w-60 text-balance text-muted-foreground text-xs leading-relaxed">
            Assisted installation is not available for this computer yet. You can use an existing
            Codex installation.
          </p>
        )}
        {!error && canInstall ? (
          <p className="mt-2 text-muted-foreground text-[11px]">Private and removable.</p>
        ) : null}
      </SetupFrame>
    );
  }

  if (activeConnectionOperation || pendingAction === "sign-in") {
    const verifying = activeConnectionOperation?.status === "verifying";
    return (
      <SetupFrame>
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
        <h2 className="font-semibold text-lg">
          {verifying ? "Checking your account" : "Finish signing in"}
        </h2>
        <p className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed">
          {verifying ? "Finding your available models…" : "Complete sign-in in your browser."}
        </p>
        {!verifying && activeConnectionOperation?.authorizationUrl ? (
          <Button
            className="mt-4 gap-1.5"
            onClick={() =>
              void props.controller.openAuthorizationPage(
                activeConnectionOperation.authorizationUrl!,
              )
            }
            size="sm"
            type="button"
          >
            <ExternalLinkIcon aria-hidden /> Reopen browser
          </Button>
        ) : null}
        {activeConnectionOperation ? (
          <Button
            className="mt-2"
            disabled={pendingAction === "cancel-sign-in"}
            onClick={() => void cancelSignIn()}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        ) : null}
      </SetupFrame>
    );
  }

  if (isAuthenticated) {
    if (updateRunning) {
      return (
        <StatusFrame
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
            {error ? "Codex couldn’t be updated" : "Codex update available"}
          </h2>
          <p
            className="mt-1.5 max-w-60 text-balance text-muted-foreground text-sm leading-relaxed"
            role={error ? "alert" : undefined}
          >
            {error ?? "Install the reviewed update when you’re ready."}
          </p>
          <Button className="mt-4" onClick={() => void update()} size="sm" type="button">
            {error ? "Try again" : "Update Codex"}
          </Button>
          <p className="mt-2 text-muted-foreground text-[11px]">
            Your current version stays available until the update is verified.
          </p>
        </SetupFrame>
      );
    }
    return <StatusFrame title="Codex is ready" body="Your ChatGPT subscription is connected." />;
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
        {signInError ? "Codex sign-in didn’t finish" : "Codex is installed"}
      </h2>
      <p
        className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed"
        role={signInError ? "alert" : undefined}
      >
        {signInError ?? "Sign in with your existing ChatGPT account."}
      </p>
      <Button className="mt-4 gap-1.5" onClick={() => void signIn()} size="sm" type="button">
        {signInError ? <RefreshCwIcon aria-hidden /> : <ExternalLinkIcon aria-hidden />}
        {signInError ? "Try sign in again" : "Sign in to Codex"}
      </Button>
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
}) {
  return (
    <SetupFrame>
      {props.loading ? (
        <LoaderIcon aria-hidden className="mb-3 size-7 animate-spin text-primary" />
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
      data-provider-onboarding-view="codex-flow"
    >
      {children}
    </div>
  );
}
