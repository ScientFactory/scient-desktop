import { msg, T, useGT, useMessages } from "gt-react";
import type {
  ProviderRuntimeOperation,
  ProviderRuntimeSummary,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
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
import { startGrokSignIn, startReviewedGrokRuntimeAction } from "./grokLifecycleActions";
import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";
import {
  externalProviderUpdate,
  externalProviderUpdateProgress,
  providerUpdateIssue,
  providerUpdateOffer,
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
import { m, type MessageResolver } from "~/i18n/messages";

type PendingAction =
  | "install"
  | "repair"
  | "update"
  | "external-update"
  | "sign-in"
  | "device-sign-in"
  | "submit-code"
  | "cancel-runtime"
  | "cancel-sign-in"
  | null;

// Each reads as the action's own words, as before; some actions name a step, not a verb.
const GROK_ACTION_FAILURES = {
  install: msg("Scient could not install Grok."),
  repair: msg("Scient could not repair Grok."),
  update: msg("Scient could not update Grok."),
  "external-update": msg("Scient could not update Grok."),
  "sign-in": msg("Scient could not sign-in Grok."),
  "device-sign-in": msg("Scient could not device-sign-in Grok."),
  "submit-code": msg("Scient could not submit-code Grok."),
  "cancel-runtime": msg("Scient could not cancel-runtime Grok."),
  "cancel-sign-in": msg("Scient could not cancel-sign-in Grok."),
} satisfies Record<Exclude<PendingAction, null>, string>;

function runtimeStage(
  operation: ProviderRuntimeOperation | null,
  resolve: MessageResolver = m,
): string {
  switch (operation?.status) {
    case "preparing":
      return resolve(msg("Preparing the reviewed download…"));
    case "downloading":
      return resolve(msg("Downloading Grok from xAI…"));
    case "verifying":
      return resolve(msg("Verifying the reviewed release…"));
    case "installing":
      return resolve(msg("Installing Grok privately…"));
    case "testing":
      return resolve(msg("Checking the installation…"));
    case "activating":
      return resolve(msg("Finishing setup…"));
    case "removing":
      return resolve(msg("Removing Scient’s private Grok copy…"));
    default:
      return resolve(msg("Preparing Grok…"));
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
  const gt = useGT();
  const messages = useMessages();
  const [showAuthorizationCode, setShowAuthorizationCode] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [localRuntime, setLocalRuntime] = useState<ProviderRuntimeSummary | null>(null);

  const [previousInstanceId, setPreviousInstanceId] = useState(props.provider.instanceId);
  if (previousInstanceId !== props.provider.instanceId) {
    setPreviousInstanceId(props.provider.instanceId);
    setPendingAction(null);
    setLocalError(null);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
    setLocalRuntime(null);
  }

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

  const [previousOperationId, setPreviousOperationId] = useState(
    activeConnectionOperation?.operationId,
  );
  if (previousOperationId !== activeConnectionOperation?.operationId) {
    setPreviousOperationId(activeConnectionOperation?.operationId);
    setShowAuthorizationCode(false);
    setAuthorizationCode("");
  }
  const localOperation = localRuntime?.operation;
  if (localOperation && serverRuntime) {
    const serverCaughtUp = serverRuntime.operation?.operationId === localOperation.operationId;
    const installFinished =
      localOperation.action === "install" && serverRuntime.source === "scient_managed";
    const removalFinished =
      localOperation.action === "remove" && serverRuntime.source !== "scient_managed";
    if (serverCaughtUp || installFinished || removalFinished) setLocalRuntime(null);
  }
  const accountConnected =
    props.provider.auth.status === "authenticated" && props.provider.auth.type === "grok_account";
  const apiKeyReady =
    props.provider.auth.status === "authenticated" && props.provider.auth.type === "api_key";
  const needsRepair =
    !props.managedRuntimePresentedExternally && needsManagedRuntimeRecovery(props.provider);
  const updateOffer = providerUpdateOffer(props.provider, {
    managed: !props.managedRuntimePresentedExternally,
  });
  const externalUpdateProgress = externalProviderUpdateProgress(
    props.provider,
    pendingAction === "external-update",
  );

  const run = async (action: Exclude<PendingAction, null>, operation: () => Promise<unknown>) => {
    setLocalError(null);
    setPendingAction(action);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        await operation();
      } catch (error) {
        setLocalError(providerLifecycleFailureMessage(error, m(GROK_ACTION_FAILURES[action])));
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setPendingAction(null);
    if (actionFailure) throw actionFailure.cause;
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
      gt("No Grok update is currently available."),
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

  const runtimeDiagnostics = (
    <AssistedSetupDiagnostics
      displayName={props.displayName}
      presentedExternally={props.managedRuntimePresentedExternally}
      provider={props.provider}
    />
  );
  if (activeRuntimeOperation || ["install", "repair", "update"].includes(pendingAction ?? "")) {
    const action = activeRuntimeOperation?.action ?? pendingAction;
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={runtimeStage(activeRuntimeOperation, messages)}
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={
            action === "repair"
              ? gt("Repairing Grok")
              : action === "update"
                ? gt("Updating Grok")
                : action === "remove"
                  ? gt("Removing Grok")
                  : gt("Installing Grok")
          }
        />
        {activeRuntimeOperation ? (
          <AssistedSetupActions>
            <Button
              aria-label={cancelRuntimeActionLabel("Grok", activeRuntimeOperation.action, messages)}
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
              <XIcon aria-hidden /> <T>Cancel</T>
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
          name="Grok"
          provider={props.provider}
          trailing={props.accountAction}
          update={externalProviderUpdate(props.provider)}
          working={externalUpdateProgress}
        />
      </AssistedSetupFrame>
    );
  }

  if (needsRepair) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            localError ??
            managedRuntimeRepairMessage(props.provider, "Grok", runtimeOperation, messages)
          }
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("Grok needs repair")}
        />
        <AssistedSetupActions>
          <Button
            onClick={() => void run("repair", () => runtimeAction("repair"))}
            size="sm"
            variant="ghost-primary"
          >
            <RefreshCwIcon aria-hidden /> <T>Repair Grok</T>
          </Button>
        </AssistedSetupActions>
        {runtimeDiagnostics}
      </AssistedSetupFrame>
    );
  }

  if (!isProviderRuntimePresentedAsInstalled(props.provider)) {
    const canInstall = runtime?.actions.includes("install") ?? false;
    const installationError =
      localError ?? failedRuntimeOperationMessage(runtimeOperation, "install");
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            installationError ??
            (canInstall
              ? gt("Scient can install a reviewed official Grok Build runtime privately.")
              : gt("Assisted installation is not available on this computer."))
          }
          icon={
            installationError ? (
              <TriangleAlertIcon className="size-5 text-destructive" />
            ) : (
              <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
            )
          }
          role={installationError ? "alert" : undefined}
          title={installationError ? gt("Grok installation couldn’t finish") : gt("Install Grok")}
        />
        {canInstall ? (
          <AssistedSetupActions>
            <Button
              aria-label={installationError ? gt("Retry installation of Grok") : gt("Install Grok")}
              onClick={() => void run("install", () => runtimeAction("install"))}
              size="sm"
              variant="ghost-primary"
            >
              {installationError ? <RefreshCwIcon aria-hidden /> : <DownloadIcon aria-hidden />}
              {installationError ? gt("Retry installation") : gt("Install")}
            </Button>
          </AssistedSetupActions>
        ) : null}
        {installationError ? runtimeDiagnostics : null}
      </AssistedSetupFrame>
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
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            verifying
              ? gt("Confirming your Grok account…")
              : deviceFlow
                ? gt("Enter this code on Grok’s secure sign-in page.")
                : gt("Complete sign in in your browser.")
          }
          icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
          title={verifying ? gt("Checking your account") : gt("Finish signing in")}
        />
        {deviceFlow && activeConnectionOperation?.userCode ? (
          <AssistedSetupDeviceCode code={activeConnectionOperation.userCode} providerName="Grok" />
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
                  ? gt("Open sign-in page")
                  : gt("Reopen sign-in page")}
              </Button>
            ) : null}
            {activeConnectionOperation ? (
              <Button
                aria-label={gt("Cancel Grok sign-in")}
                onClick={() => void run("cancel-sign-in", cancelConnection)}
                size="sm"
                variant="ghost-destructive-action"
              >
                <T>Cancel</T>
              </Button>
            ) : null}
          </AssistedSetupActions>
        ) : null}
      </AssistedSetupFrame>
    );
  }

  if ((accountConnected || apiKeyReady) && updateOffer) {
    const issue = providerUpdateIssue(props.provider, updateOffer, localError);
    return (
      <AssistedSetupFrame>
        <AssistedSetupUpdateStatus
          issue={issue}
          name="Grok"
          provider={props.provider}
          update={updateOffer}
        />
        <AssistedSetupActions>
          {props.accountAction}
          <AssistedSetupUpdateButton
            name="Grok"
            onClick={() =>
              void run(updateOffer.path === "external" ? "external-update" : "update", update)
            }
            retry={issue !== null}
          />
        </AssistedSetupActions>
        {issue ? runtimeDiagnostics : null}
      </AssistedSetupFrame>
    );
  }

  if (accountConnected) {
    const account = providerAccountIdentity(props.provider) ?? gt("Grok subscription");
    return (
      <AssistedSetupStatusFrame
        accountAction={props.accountAction}
        body={`${account} is connected.`}
        title={gt("Grok is ready")}
      />
    );
  }

  if (apiKeyReady) {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={gt("Grok is available through the xAI API key configured on this computer.")}
          icon={<CheckCircle2Icon className="size-5 text-success" />}
          title={gt("Ready via API key")}
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
            <ExternalLinkIcon aria-hidden /> <T>Use a Grok subscription</T>
          </Button>
        </AssistedSetupActions>
      </AssistedSetupFrame>
    );
  }

  if (props.provider.auth.status === "unknown") {
    return (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={props.provider.message ?? gt("Scient could not confirm Grok’s account state.")}
          icon={<TriangleAlertIcon className="size-5 text-warning" />}
          role="alert"
          title={gt("Couldn’t verify Grok")}
        />
        {runtimeDiagnostics}
      </AssistedSetupFrame>
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
          gt("Sign in with your existing Grok subscription. Scient never sees your password.")
        }
        icon={
          signInError ? (
            <TriangleAlertIcon className="size-5 text-destructive" />
          ) : (
            <ProviderSetupIcon displayName={props.displayName} driver={props.provider.driver} />
          )
        }
        role={signInError ? "alert" : undefined}
        title={signInError ? gt("Grok sign-in didn’t finish") : gt("Sign in required")}
      />
      <AssistedSetupActions>
        <Button
          onClick={() =>
            void run("device-sign-in", () => startGrokSignIn(props.controller, "grok_device_code"))
          }
          size="sm"
          variant="ghost-muted"
        >
          <T>Use device code</T>
        </Button>
        <Button
          aria-label={signInError ? gt("Try again to sign in to Grok") : undefined}
          onClick={() => void run("sign-in", () => startGrokSignIn(props.controller))}
          size="sm"
          variant="ghost-primary"
        >
          <ExternalLinkIcon aria-hidden /> {signInError ? gt("Try again") : gt("Sign in with Grok")}
        </Button>
      </AssistedSetupActions>
      {signInError && !props.managedRuntimePresentedExternally ? (
        <AssistedSetupDiagnostics
          displayName={props.displayName}
          managedActionBusy={pendingAction !== null}
          onUseManaged={
            canInstallManaged
              ? () => void run("install", () => runtimeAction("install"))
              : undefined
          }
          provider={props.provider}
        />
      ) : null}
    </AssistedSetupFrame>
  );
}
