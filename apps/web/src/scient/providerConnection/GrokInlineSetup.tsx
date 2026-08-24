import type {
  ProviderRuntimeOperation,
  ProviderRuntimeSummary,
  ServerProvider,
} from "@t3tools/contracts";
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

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import { startGrokSignIn, startReviewedGrokRuntimeAction } from "./grokLifecycleActions";
import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";
import { resolveProviderRuntimeForPresentation } from "./ProviderRuntimeSection";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  needsManagedRuntimeRecovery,
  providerAccountIdentity,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
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
  const canRepair =
    !props.managedRuntimePresentedExternally && (runtime?.actions.includes("repair") ?? false);
  const needsRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);

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

  const runtimeAction = async (action: "install" | "repair" | "update") => {
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

  if (!props.provider.enabled) {
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body="Enable Grok in provider settings before installing or connecting it."
          icon={<ShieldCheckIcon className="size-5 text-primary" />}
          title="Grok is disabled"
        />
      </SetupFrame>
    );
  }

  if (activeRuntimeOperation || ["install", "repair", "update"].includes(pendingAction ?? "")) {
    const action = activeRuntimeOperation?.action ?? pendingAction;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={runtimeStage(activeRuntimeOperation)}
          icon={<GrokLoadingIcon displayName={props.displayName} driver={props.provider.driver} />}
          title={
            <GrokLoadingTitle>
              {action === "repair"
                ? "Repairing Grok"
                : action === "update"
                  ? "Updating Grok"
                  : action === "remove"
                    ? "Removing Grok"
                    : "Installing Grok"}
            </GrokLoadingTitle>
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              className={DESTRUCTIVE_GHOST_ACTION_CLASS}
              disabled={pendingAction === "cancel-runtime"}
              onClick={() =>
                void run("cancel-runtime", () =>
                  props.controller.cancelRuntime(activeRuntimeOperation.operationId),
                )
              }
              size="sm"
              type="button"
              variant="ghost-muted"
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
          body={
            localError ?? runtimeOperation?.message ?? "Grok’s private runtime could not start."
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title="Grok needs repair"
        />
        <AssistedSetupActions>
          <Button onClick={() => void run("repair", () => runtimeAction("repair"))} size="sm">
            <RefreshCwIcon aria-hidden /> Repair Grok
          </Button>
        </AssistedSetupActions>
      </SetupFrame>
    );
  }

  if (!props.provider.installed) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    return (
      <SetupFrame>
        <AssistedSetupStatus
          body={
            localError ??
            (canInstall
              ? "Scient can install a reviewed official Grok Build runtime privately."
              : "Assisted installation is not available on this computer.")
          }
          icon={
            localError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderInstanceIcon
                className="size-8"
                displayName={props.displayName}
                driverKind={props.provider.driver}
                iconClassName="size-8"
              />
            )
          }
          role={localError ? "alert" : undefined}
          title={localError ? "Grok installation couldn’t finish" : "Install Grok"}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button onClick={() => void run("install", () => runtimeAction("install"))} size="sm">
              {localError ? "Retry installation" : "Install"}
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
          icon={<GrokLoadingIcon displayName={props.displayName} driver={props.provider.driver} />}
          title={
            <GrokLoadingTitle>
              {verifying ? "Checking your account" : "Finish signing in"}
            </GrokLoadingTitle>
          }
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
                className={DESTRUCTIVE_GHOST_ACTION_CLASS}
                onClick={() => void run("cancel-sign-in", cancelConnection)}
                size="sm"
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

  const connectedActions =
    canRepair || props.accountAction ? (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {canRepair ? (
          <Button
            disabled={pendingAction !== null}
            onClick={() => void run("repair", () => runtimeAction("repair"))}
            size="sm"
            variant="ghost-muted"
          >
            <RefreshCwIcon aria-hidden /> Repair
          </Button>
        ) : null}
        {props.accountAction}
      </div>
    ) : undefined;

  if (accountConnected) {
    const account = providerAccountIdentity(props.provider) ?? "Grok subscription";
    return (
      <StatusFrame
        accountAction={connectedActions}
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
          trailing={connectedActions}
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
            <ProviderInstanceIcon
              className="size-8"
              displayName={props.displayName}
              driverKind={props.provider.driver}
              iconClassName="size-8"
            />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? "Grok sign-in didn’t finish" : "Sign in required"}
      />
      <AssistedSetupActions>
        <Button
          className="text-muted-foreground"
          onClick={() =>
            void run("device-sign-in", () => startGrokSignIn(props.controller, "grok_device_code"))
          }
          size="sm"
          variant="ghost-muted"
        >
          Use device code
        </Button>
        <Button
          onClick={() => void run("sign-in", () => startGrokSignIn(props.controller))}
          size="sm"
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

function GrokLoadingIcon(props: {
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

function GrokLoadingTitle(props: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <LoaderIcon className="hidden size-3.5 animate-spin text-primary in-[[data-model-picker-content=true]]:block" />
      {props.children}
    </span>
  );
}
