import type {
  ProviderRuntimeOperation,
  ProviderRuntimeSummary,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshCwIcon,
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
  ProviderSetupIcon,
} from "./AssistedProviderSetup";
import { startGrokSignIn, startReviewedGrokRuntimeAction } from "./grokLifecycleActions";
import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";
import {
  hasExternalProviderUpdate,
  hasManagedProviderUpdate,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import { resolveProviderRuntimeForPresentation } from "./ProviderRuntimeSection";
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
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "sign-in"
  | "device-sign-in"
  | "submit-code"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;

function runtimeStage(operation: ProviderRuntimeOperation | null): string {
  switch (operation?.status) {
    case "preparing":
      return "Preparing the reviewed download…";
    case "downloading":
      return "Downloading Grok from xAI…";
    case "verifying":
      return "Verifying the reviewed release…";
    case "installing":
      return "Installing Grok privately…";
    case "testing":
      return "Checking the installation…";
    case "activating":
      return "Finishing setup…";
    case "removing":
      return "Removing Scient’s private Grok copy…";
    default:
      return "Preparing Grok…";
  }
}

export function GrokInlineSetup(props: {
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
  const [localRuntime, setLocalRuntime] = useState<ProviderRuntimeSummary | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    setPendingAction(null);
    setLocalError(null);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
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

  useEffect(() => {
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }, [activeConnectionOperation?.operationId]);
  useEffect(() => {
    const localOperation = localRuntime?.operation;
    if (!localOperation || !serverRuntime) return;
    const serverCaughtUp = serverRuntime.operation?.operationId === localOperation.operationId;
    const installFinished =
      localOperation.action === "install" && serverRuntime.source === "scient_managed";
    const removalFinished =
      localOperation.action === "remove" && serverRuntime.source !== "scient_managed";
    if (serverCaughtUp || installFinished || removalFinished) setLocalRuntime(null);
  }, [localRuntime, serverRuntime]);
  const accountConnected =
    props.provider.auth.status === "authenticated" && props.provider.auth.type === "grok_account";
  const apiKeyReady =
    props.provider.auth.status === "authenticated" && props.provider.auth.type === "api_key";
  const needsRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);
  const updateAvailable =
    (!props.managedRuntimePresentedExternally && hasManagedProviderUpdate(props.provider)) ||
    hasExternalProviderUpdate(props.provider);
  const updateState = props.provider.updateState;
  const updateRunning = updateState?.status === "queued" || updateState?.status === "running";

  const run = async (action: Exclude<PendingAction, null>, operation: () => Promise<unknown>) => {
    setLocalError(null);
    setPendingAction(action);
    try {
      await operation();
    } catch (error) {
      setLocalError(providerLifecycleFailureMessage(error, `Scient could not ${action} Grok.`));
    } finally {
      setPendingAction(null);
    }
  };

  const runtimeAction = async (action: "install" | "repair") => {
    const provider = await startReviewedGrokRuntimeAction(props.controller, action);
    setLocalRuntime(provider.connection?.runtime ?? null);
    if (
      action === "repair" &&
      provider.connection?.runtime?.operation?.action === "repair" &&
      provider.connection.runtime.operation.status === "succeeded"
    ) {
      props.onRepairSucceeded?.();
    }
  };

  const update = async () => {
    const provider = await updateManagedOrExternalProviderRuntime(
      props.controller,
      props.provider,
      "No Grok update is currently available.",
    );
    setLocalRuntime(provider.connection?.runtime ?? null);
  };

  const cancelConnection = () =>
    activeConnectionOperation
      ? props.controller.cancelConnection(activeConnectionOperation.operationId)
      : Promise.resolve();

  const submitCode = async () => {
    if (!activeConnectionOperation || authorizationCode.trim().length === 0) return;
    await props.controller.submitAuthorizationCode(
      activeConnectionOperation.operationId,
      authorizationCode,
    );
    setAuthorizationCode("");
  };

  if (activeRuntimeOperation || ["install", "repair", "update"].includes(pendingAction ?? "")) {
    const action = activeRuntimeOperation?.action ?? pendingAction;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={runtimeStage(activeRuntimeOperation)}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            action === "repair"
              ? "Repairing Grok"
              : action === "update"
                ? "Updating Grok"
                : action === "remove"
                  ? "Removing Grok"
                  : "Installing Grok"
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel("Grok", activeRuntimeOperation.action)}
              disabled={pendingAction === "cancel-runtime"}
              onClick={() =>
                void run("cancel-runtime", () =>
                  props.controller.cancelRuntime(activeRuntimeOperation.operationId),
                )
              }
              size="sm"
              type="button"
              variant="ghost-destructive-action"
            >
              <XIcon aria-hidden /> Cancel
            </Button>
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if (needsRepair) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={localError ?? managedRuntimeRepairMessage(props.provider, "Grok", runtimeOperation)}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Grok needs repair"
        />
        <AssistedSetupActions>
          <Button
            onClick={() => void run("repair", () => runtimeAction("repair"))}
            size="sm"
            variant="ghost-primary"
          >
            <RefreshCwIcon aria-hidden /> Repair Grok
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const installationError =
      localError ?? failedRuntimeOperationMessage(runtimeOperation, "install");
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            installationError ??
            (canInstall
              ? "Scient can install a reviewed official Grok Build runtime privately."
              : "Assisted installation is not available on this computer.")
          }
          icon={
            installationError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={installationError ? "alert" : undefined}
          title={installationError ? "Grok installation couldn’t finish" : "Install Grok"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={installationError ? "Retry Grok installation" : "Install Grok"}
              onClick={() => void run("install", () => runtimeAction("install"))}
              size="sm"
              variant="ghost-primary"
            >
              {installationError ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {installationError ? "Retry installation" : "Install"}
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
    const deviceFlow = activeConnectionOperation?.method === "grok_device_code";
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            verifying
              ? "Confirming your Grok account…"
              : deviceFlow
                ? "Enter this code on Grok’s secure sign-in page."
                : "Complete sign in in your browser."
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? "Checking your account" : "Finish signing in"}
        />
        {deviceFlow && activeConnectionOperation?.userCode ? (
          <div className="ms-8 flex items-center justify-between gap-3 rounded-md border bg-background/40 px-3 py-2 in-[[data-model-picker-content=true]]:mx-auto in-[[data-model-picker-content=true]]:ms-0 in-[[data-model-picker-content=true]]:w-full in-[[data-model-picker-content=true]]:max-w-64">
            <code className="font-semibold tracking-wider text-foreground">
              {activeConnectionOperation.userCode}
            </code>
            <Button
              aria-label="Copy Grok device code"
              onClick={() => copyToClipboard(activeConnectionOperation.userCode!, undefined)}
              size="icon-sm"
              type="button"
              variant="ghost-muted"
            >
              <CopyIcon aria-hidden />
            </Button>
          </div>
        ) : null}
        {activeConnectionOperation?.acceptsAuthorizationCode ? (
          <ProviderAuthorizationCodeDisclosure
            authorizationCode={authorizationCode}
            disabled={pendingAction === "submit-code"}
            expanded={showAuthorizationCode}
            onAuthorizationCodeChange={setAuthorizationCode}
            onExpandedChange={setShowAuthorizationCode}
            onSubmit={() => void run("submit-code", submitCode)}
            providerName="Grok"
            submitting={pendingAction === "submit-code"}
          />
        ) : null}
        {!verifying ? (
          <AssistedSetupActions>
            {activeConnectionOperation?.authorizationUrl ? (
              <Button
                onClick={() =>
                  void props.controller.openAuthorizationPage(
                    activeConnectionOperation.authorizationUrl!,
                  )
                }
                size="sm"
                variant="ghost-muted"
              >
                <ExternalLinkIcon aria-hidden />
                {activeConnectionOperation.authorizationUrlKind === "manual_fallback"
                  ? "Open sign-in page"
                  : "Reopen sign-in page"}
              </Button>
            ) : null}
            {activeConnectionOperation ? (
              <Button
                aria-label="Cancel Grok sign-in"
                onClick={() => void run("cancel-sign-in", cancelConnection)}
                size="sm"
                variant="ghost-destructive-action"
              >
                Cancel
              </Button>
            ) : null}
          </AssistedSetupActions>
        ) : null}
      </SetupFrame>
    );
  }

  if ((accountConnected || apiKeyReady) && updateRunning) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={updateState?.message ?? "Updating and verifying Grok…"}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title="Updating Grok"
          trailing={props.accountAction}
        />
      </SetupFrame>
    );
  }

  if ((accountConnected || apiKeyReady) && updateAvailable) {
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
          title={error ? "Grok couldn’t be updated" : "Grok update available"}
        />
        <AssistedSetupActions>
          {props.accountAction}
          <Button
            aria-label={error ? "Retry Grok update" : "Update Grok"}
            onClick={() => void run("update", update)}
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

  if (accountConnected) {
    const account = providerAccountIdentity(props.provider) ?? "Grok subscription";
    return (
      <StatusFrame
        accountAction={props.accountAction}
        body={`${account} is connected.`}
        title="Grok is ready"
      />
    );
  }

  if (apiKeyReady) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body="Grok is available through the xAI API key configured on this computer."
          icon={<CheckCircle2Icon className="size-5 text-success" />}
          title="Ready via API key"
          trailing={props.accountAction}
        />
        <AssistedSetupActions>
          <Button
            onClick={() =>
              void run("sign-in", () => startGrokSignIn(props.controller, "grok_account", true))
            }
            size="sm"
            variant="ghost-muted"
          >
            <ExternalLinkIcon aria-hidden /> Use a Grok subscription
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (props.provider.auth.status === "unknown") {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={props.provider.message ?? "Scient could not confirm Grok’s account state."}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Couldn’t verify Grok"
        />
      </SetupFrame>
    );
  }

  const signInError =
    localError ?? (connectionOperation?.status === "failed" ? connectionOperation.message : null);
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={
          signInError ??
          "Sign in with your existing Grok subscription. Scient never sees your password."
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Grok sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        <Button
          onClick={() =>
            void run("device-sign-in", () => startGrokSignIn(props.controller, "grok_device_code"))
          }
          size="sm"
          variant="ghost-muted"
        >
          Use device code
        </Button>
        <Button
          aria-label={signInError ? "Retry Grok sign-in" : undefined}
          onClick={() => void run("sign-in", () => startGrokSignIn(props.controller))}
          size="sm"
          variant="ghost-primary"
        >
          <ExternalLinkIcon aria-hidden /> {signInError ? "Try again" : "Sign in with Grok"}
        </Button>
      </AssistedSetupActions>
    </SetupFrame>
  );
}

function StatusFrame(props: {
  readonly accountAction?: ReactNode;
  readonly title: string;
  readonly body: ReactNode;
}) {
  return (
    <SetupFrame>
      <AssistedSetupStatus
        body={props.body}
        icon={<CheckCircle2Icon className="size-5 text-success" />}
        title={props.title}
        trailing={props.accountAction}
      />
    </SetupFrame>
  );
}

function SetupFrame(props: { readonly children: ReactNode }) {
  return <AssistedSetupFrame>{props.children}</AssistedSetupFrame>;
}
